import type { NostrClient, SessionManager } from '@/source'

export type LogType    = 'info' | 'error' | 'warning' | 'success' | 'sign' | 'req' | 'res' | 'ready'
export type NodeStatus = 'online' | 'offline' | 'locked' | 'connecting'

export interface NostrClientAPI {
  client  : NostrClient | null
  session : SessionManager | null
  lock    : () => void
  unlock  : (password : string) => void
  reset   : () => void
  status  : NodeStatus
}

export interface LogEntry {
  timestamp : number
  message   : string
  type      : string
  payload?  : any
}

export interface PeerStatus {
  pubkey  : string
  status  : 'online' | 'offline' | 'checking'
  updated : number
}

export interface RelayPolicy {
  url   : string
  read  : boolean
  write : boolean
}
