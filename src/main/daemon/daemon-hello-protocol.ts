import type { ProcessIntegrityLevel } from '../../shared/host-integrity-types'

export type HelloMessage = {
  type: 'hello'
  version: number
  token: string
  clientId: string
  role: 'control' | 'stream'
}

export type DaemonEndpointIdentity = {
  pid: number
  startedAtMs: number
  launchNonce: string
  /** Optional launch metadata. Absent from daemons that predate it; readers must fall back. */
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  /** Windows only (INV-P-023): the daemon's own token integrity once its boot probe settled. */
  integrityLevel?: ProcessIntegrityLevel
}

export type HelloResponse = {
  type: 'hello'
  ok: boolean
  error?: string
  daemonIdentity?: DaemonEndpointIdentity
}
