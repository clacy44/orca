import { createHash } from 'node:crypto'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'

export type OrchestrationWorkerServer = {
  environmentId: string
  name: string
  peerFingerprint: string
}

export type OrchestrationEnvironmentTransport = {
  resolve(selector: string): OrchestrationWorkerServer
  call(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope
  ): Promise<RuntimeRpcResponse<unknown>>
  // S10-4 ruling 7: called when a call to `selector` came back with the peer rejecting our
  // pairing token, so `orca environment list`/`show` can surface it. Optional so every existing
  // test-only transport stub keeps compiling unchanged.
  markPairingStale?(selector: string): void
  /** S10-16 R4.1: a call pinned to the environment revision the caller resolved, and bounded by an
   *  ABSOLUTE duration (not the idle `timeoutMs`). Absent ⇒ link binding and pinned reply relay
   *  are unavailable on this runtime — refuse, never fall back to unpinned. */
  callPinned?(args: {
    selector: string
    method: string
    params: unknown
    timeoutMs: number
    maxDurationMs: number
    expectedEnvironmentPairingRevision: number
    envelope?: RuntimeOrchestrationEnvelope
  }): Promise<RuntimeRpcResponse<unknown>>
}

export function fingerprintOrchestrationPeer(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('base64url')
}
