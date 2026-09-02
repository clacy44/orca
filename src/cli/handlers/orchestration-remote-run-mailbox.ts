import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_RUN_MAILBOX_UNSUPPORTED_MESSAGE
} from '../../shared/protocol-version'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

export type RemoteRunMailboxClient = Pick<RuntimeClient, 'call' | 'isRemote'>

export type RemoteRunMailboxNegotiation = {
  // Why: `undefined` keeps the key off the wire, so local calls and old peers see the request they always saw.
  param: true | undefined
  remote: boolean
  supported: boolean
  // S10-19 §9.3: cached off the same status.get round trip — true only when the remote runtime
  // stamped a peerAccess block, i.e. this call is against a federation-peer grant (never a full
  // pairing). Lets check/send/reply suppress local pane identity fields it already knows the
  // server will refuse, without a second probe.
  peerAccess: boolean
}

const LOCAL_NEGOTIATION: RemoteRunMailboxNegotiation = {
  param: undefined,
  remote: false,
  supported: false,
  peerAccess: false
}

// Why: an old peer strips remoteRunMailbox and then refuses the call as an unbound
// coordinator, so these codes are what "the peer is too old for this" looks like.
const RUN_BINDING_REFUSAL_CODES = new Set([
  'run_required',
  'consumer_fenced',
  'stable_pane_required'
])

export async function negotiateRemoteRunMailbox(
  client: RemoteRunMailboxClient,
  needed: boolean
): Promise<RemoteRunMailboxNegotiation> {
  if (!needed || client.isRemote !== true) {
    return LOCAL_NEGOTIATION
  }
  const status = await client.call<RuntimeStatus>('status.get')
  const supported =
    status.result.capabilities?.includes(ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY) ===
    true
  const peerAccess = (status.result as { peerAccess?: unknown }).peerAccess !== undefined
  return { param: supported ? true : undefined, remote: true, supported, peerAccess }
}

// Why: without this the user sees "No Run is bound" from a runtime they never bound a pane on.
export function describeRemoteRunMailboxFailure(
  error: unknown,
  negotiation: RemoteRunMailboxNegotiation
): unknown {
  if (!negotiation.remote || negotiation.supported || !isRunBindingRefusal(error)) {
    return error
  }
  return new RuntimeClientError(
    'capability_unsupported',
    `${ORCHESTRATION_REMOTE_RUN_MAILBOX_UNSUPPORTED_MESSAGE}. Update Orca on the peer runtime, or target a Run that lives on the recipient's runtime.`
  )
}

export async function withRemoteRunMailboxDegradation<TResult>(
  negotiation: RemoteRunMailboxNegotiation,
  run: () => Promise<TResult>
): Promise<TResult> {
  try {
    return await run()
  } catch (error) {
    throw describeRemoteRunMailboxFailure(error, negotiation)
  }
}

function isRunBindingRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && RUN_BINDING_REFUSAL_CODES.has(code)
}
