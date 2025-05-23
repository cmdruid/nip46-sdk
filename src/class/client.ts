import { SimplePool }       from 'nostr-tools'
import { EventEmitter }     from './emitter.js'
import { gen_message_id }   from '@/lib/util.js'
import { verify_relays }    from '@/lib/validate.js'

import { Assert, now, parse_error } from '@/util/index.js'

import {
  SubCloser,
  SubscribeManyParams
} from 'nostr-tools/abstract-pool'

import {
  create_envelope,
  decrypt_envelope,
  parse_message
} from '@/lib/message.js'



import type {
  EventFilter,
  SignedEvent,
  ClientConfig,
  SignDeviceAPI,
  PublishResponse,
  ClientInboxMap,
  ClientEventMap,
  PublishedEvent,
  MessageTemplate,
  RequestTemplate,
  ResponseMessage,
  RequestMessage
} from '@/types/index.js'

/**
 * Default configuration settings for a Nostr node.
 */
const DEFAULT_CONFIG : () => ClientConfig = () => {
  return {
    kind: 24133,
    filter: {
      kinds : [ 24133 ], // Filter for specific Nostr event type
      since : now()      // Only get events from current time onwards
    },
    req_timeout  : 5000,
    since_offset : 5,
    start_delay  : 2000
  }
}

export class NostrClient extends EventEmitter <ClientEventMap> {
  // Core node components
  private readonly _config   : ClientConfig
  private readonly _pool     : SimplePool
  private readonly _pubkey   : string
  private readonly _relays   : string[]
  private readonly _signer   : SignDeviceAPI

  // Message routing system
  private readonly _inbox : ClientInboxMap = {
    author  : new EventEmitter(), // Route by sender pubkey.
    request : new EventEmitter(), // Route by message type.
    response: new EventEmitter()  // Route by message type.
  }

  private _filter : EventFilter
  private _ready  : boolean = false
  private _sub    : SubCloser | null = null

  /**
   * Creates a new NostrNode instance.
   * @param relays   Array of relay URLs to connect to.
   * @param seckey   Secret key in hex format
   * @param options  Optional configuration parameters
   * @throws {Error} If relays array is invalid or secret key is malformed
   */
  constructor (
    pubkey  : string,
    relays  : string[],
    signer  : SignDeviceAPI,
    options : Partial<ClientConfig> = {}
  ) {
    super()
    
    // Validate inputs before initialization
    verify_relays(relays)
    
    this._pubkey = pubkey
    this._signer = signer
  
    this._config  = get_node_config(options)
    this._filter  = get_filter_config(this, options.filter)
    this._pool    = new SimplePool()
    this._relays  = relays

    this.emit('info', 'filter:', JSON.stringify(this.filter, null, 2))
  }

  get config() : ClientConfig {
    return this._config
  }

  get filter() : EventFilter {
    return this._filter
  }

  get inbox() : ClientInboxMap {
    return this._inbox
  }

  get pubkey() : string {
    return this._pubkey
  }

  get ready() : boolean {
    return this._ready
  }

  get relays() : string[] {
    return this._relays
  }

  private async _handler (event : SignedEvent) : Promise<void> {
    if (event.pubkey === this.pubkey) return

    this.emit('event', event)

    try {
      // Decrypt and parse the incoming message
      const payload = await decrypt_envelope(event, this._signer)
      const message = parse_message(payload, event)
      const type    = message.type

      // If the message is a request,
      if (type === 'request') {
        // If the message is a ping,
        if (message.method === 'ping') {
          // Send a pong response.
          this._pong(message)
        } else {
          // Otherwise, emit the message to the request inbox.
          this.inbox.request.emit(message.method, message)
        }
      }
      // If the message is an accept or reject,
      else if (type === 'accept' || type === 'reject') {
        // Emit the message to the response inbox.
        this.inbox.response.emit(message.id, message)
      }
      // Emit the message to the author inbox.
      this.inbox.author.emit(message.env.pubkey, message)
      // Emit the message to client emitter.
      this.emit('message', message)
    } catch (err) {
      // Emit the error to the client emitter.
      this.emit('error', err)
      // Emit the bounced event to the client emitter.
      this.emit('bounced', event.id, parse_error(err))
    }
  }

  private _init() : void {
    this._ready = true
    this.emit('ready', this)
  }

  private _pong (message : RequestMessage) : void {
    Assert.ok(message.method === 'ping', 'invalid ping message')
    const template = { result: 'pong', id: message.id }
    this.send(template, message.env.pubkey)
  }

  /**
   * Publishes a signed event to the Nostr network.
   * @param event  Signed event to publish
   * @returns      Publication status and message ID
   */
  private async _publish (
    event : SignedEvent
  ) : Promise<PublishResponse> {
    // Publish to all connected relays
    const receipts = this._pool.publish(this.relays, event)
    return Promise.allSettled(receipts).then(resolve_receipts)
  }

  private _subscribe() : void {
    const params : SubscribeManyParams = {
      onevent : this._handler.bind(this),
      oneose  : this._init.bind(this)
    }
    this._sub = this._pool.subscribe(this.relays, this.filter, params)
  }

  /**
   * Establishes connections to configured relays.
   * @param timeout  The timeout for the connection.
   * @returns        This node instance
   * @emits ready    When connections are established
   */
  async connect (timeout? : number) : Promise<this> {
    timeout ??= this.config.req_timeout
    // Start listening for events on all relays.
    this._subscribe()
    return new Promise(resolve => {
      this.once('ready', () => resolve(this))
    })
  }

  /**
   * Gracefully closes all relay connections.
   * 
   * @emits close  When all connections are terminated
   */
  async close () : Promise<void> {
    if (this._sub !== null) {
      this._sub.close()
    }
    if (this._pool.close !== undefined) {
      this._pool.close(this.relays)
    }
    this._ready = false
    this.emit('close', this)
  }

  async create_event (
    message   : MessageTemplate,
    recipient : string
  ) : Promise<SignedEvent> {
    message.id   ??= gen_message_id()
    const config   = { kind : this.config.kind, tags : [] }
    const payload  = JSON.stringify(message)
    return create_envelope(config, payload, recipient, this._signer)
  }

  async ping (recipient : string) : Promise<boolean> {
    const msg_id   = gen_message_id()
    const template = { method: 'ping', id: msg_id }
    return this.request(template, recipient)
      .then(res => res.type === 'accept')
      .catch(_ => false)
  }

  async request (
    message   : RequestTemplate,
    recipient : string
  ) : Promise<ResponseMessage> {
    if (!message.id) throw new Error('message id is required')
    const event   = await this.create_event(message, recipient)
    const timeout = this.config.req_timeout
    const receipt = new Promise<ResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject('timeout'), timeout)
      this.inbox.response.within(message.id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      }, timeout)
    })
    this._publish(event)
    return receipt
  }

  /**
   * Publishes a message to the Nostr network.
   * @param message   Message data to publish
   * @param recipient Target peer's public key
   * @returns        Publication status and message ID
   */
  async send (
    message   : MessageTemplate,
    recipient : string
  ) : Promise<PublishedEvent> {
    const event = await this.create_event(message, recipient)
    const res   = await this._publish(event)
    return { ...res, event }
  }
}

/**
 * Merges provided options with default node configuration.
 * @param opt      Custom configuration options
 * @returns        Complete node configuration
 */
function get_node_config (
  opt : Partial<ClientConfig> = {}
) : ClientConfig {
  const config = DEFAULT_CONFIG()
  const filter = { ...config.filter, ...opt.filter }
  return { ...config, filter }
}

/**
 * Combines custom filter settings with defaults.
 * @param client   Nostr client instance
 * @param filter   Custom filter settings
 * @returns        Complete filter configuration
 */
function get_filter_config (
  client : NostrClient,
  filter : Partial<EventFilter> = {}
) : EventFilter {
  return { ...client.config.filter, ...filter }
}

function resolve_receipts (
  settled : PromiseSettledResult<string>[]
) : PublishResponse {
  const acks : string[] = [], fails : string[] = []
  for (const prom of settled) {
    if (prom.status === 'fulfilled') {
      acks.push(prom.value)
    } else {
      fails.push(prom.reason)
    }
  }
  return { acks, fails, ok: acks.length > 0 }
}
