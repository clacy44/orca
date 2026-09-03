import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db'
import type { RunRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { resolveRunScope, type RunScopeParams } from './orchestration-run-scope'
import { isHostScopedId } from '../../orchestration/orchestration-id-grammar'

// Why: the Run mailbox lives in exactly one runtime's SQLite, so an agent told "there is
// mail for you in run_X" on another runtime has no local row to read. This path lets a
// paired runtime read/write that mailbox on the runtime that owns it.
//
// TRUST ARGUMENT — why dropping requireCurrentConsumer here is not an escalation (S10-19
// §13.1, R18 — rewritten again by W-5..W-7 review finding 1 / Ruling 24 addendum 4(aa): the
// pre-S10-19 text claimed a peer "could always post and read Run mail by driving a local
// pane", which is false under a peer-profile grant — terminal.create is refused and
// terminal.send does not exist for a peer at all):
// The caller is an authenticated runtime-scope paired device (`pairedDeviceId` +
// `clientKind === 'runtime'`), asserted up front and never from a caller-supplied handle;
// the read joins the Run's CURRENT consumer generation rather than rebinding it, so a
// locally bound coordinator is never fenced and acks land in the authoritative DB. Under a
// federation-peer grant this is a first-class capability, not a shortcut around one the
// peer already had: `terminal.create` and `terminal.send` are both refused and the peer
// has no pane input at all beyond a two-value startup-prompt answer the host types
// (`orchestration.federationAnswerPrompt`). What bounds it is `assertPeerMailDestinationAllowed`
// below, enforced SERVER-SIDE on all three mail verbs, never `params.remoteRunMailbox` (a
// client hint only): a peer send/check may address an explicit `run:<id>` mailbox (a Run id
// is a bearer capability — any peer holding one can read and consume that Run's mail; body
// handles, pane keys and `from` are refused, §8.1/§8.2) or a `dispatch:<id>` whose
// `remote_dispatch_attachments` row carries THIS link's `home_peer_fingerprint`; a peer
// reply is scoped the same way from the row it is replying to, plus a peer may not take the
// exclusive waiter on a Run a local pane is bound to (R24, `run_wait_local_only`). Scoping a
// peer to Runs it was explicitly told about requires the link binding S10-16 lands; until
// then, treat a Run id shared with a peer as shared with that whole host — that is the
// accepted "mail as data" residual (INV-P-012's amendment), not a hole this fix closes. What
// this fix DOES close: a peer reaching `agent:<id>`, a bare terminal handle, a group
// address, or a Dispatch mailbox owned by a DIFFERENT link — none of which is "a mailbox
// this peer was told about".
export type RemoteRunMailboxCaller = Pick<RpcContext, 'pairedDeviceId' | 'clientKind'> & {
  remoteRunMailbox?: boolean
}

// Why: only these mean "the caller has no usable pane binding here" — the case a paired
// peer can never satisfy. Anything else (run_not_found, legacy_read_only) still refuses.
const RUN_BINDING_REFUSAL_CODES = new Set([
  'run_required',
  'consumer_fenced',
  'stable_pane_required'
])

export function isRemoteRunMailboxRequest(caller: RemoteRunMailboxCaller): boolean {
  return caller.remoteRunMailbox === true
}

export function assertRemoteRunMailboxCaller(caller: RemoteRunMailboxCaller): void {
  if (caller.pairedDeviceId && caller.clientKind === 'runtime') {
    return
  }
  throw new OrchestrationError(
    'remote_mailbox_unpaired',
    'Remote run mailbox access requires an authenticated runtime-scope pairing. Pair this runtime with orca environment add and retry.',
    { effectsApplied: false }
  )
}

// Why: pane-bound scope stays the rule; the paired identity is only consulted once the
// pane question came back unanswerable, so no locally working call changes behavior.
export function resolveRemoteRunMailboxScope(
  runtime: OrcaRuntimeService,
  params: RunScopeParams,
  caller: RemoteRunMailboxCaller
): RunRow {
  try {
    return resolveRunScope(runtime, params)
  } catch (error) {
    if (!isRemoteRunMailboxRequest(caller) || !params.runId || !isRunBindingRefusal(error)) {
      throw error
    }
    assertRemoteRunMailboxCaller(caller)
    const run = runtime.getOrchestrationDb().getRun(params.runId)
    if (!run || run.legacy === 1) {
      throw new OrchestrationError('run_not_found', `Run ${params.runId} was not found.`)
    }
    return run
  }
}

function isRunBindingRefusal(error: unknown): boolean {
  return error instanceof OrchestrationError && RUN_BINDING_REFUSAL_CODES.has(error.code)
}

// W-5..W-7 review finding 1 / Ruling 24 addendum 4(aa): the SERVER-SIDE destination
// constraint for a peer-profile mail caller — `params.remoteRunMailbox` is a client hint
// only, this is the actual authority. A peer may address:
//  - `run`: an explicit Run mailbox (the accepted "Run id is a bearer capability" residual,
//    unchanged — a peer must already know the Run id to name it here); or
//  - `dispatch`: a Dispatch whose `remote_dispatch_attachments` row was attached by THIS
//    same link (`home_peer_fingerprint === callerFingerprint`) — the documented peer
//    follow-up route (`send --to dispatch:<id>`).
// Everything else — `agent:<id>`, a bare terminal handle, a group address, or a Dispatch
// owned by a DIFFERENT link — refuses. A non-peer caller (accessProfile !== 'peer') is
// always a no-op: this constraint exists only at the peer boundary.
export type PeerMailDestination =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'dispatch'; readonly dispatchId: string }
  | { readonly kind: 'other' }

// F-12 (Ruling 32 Addendum 1; field-run-10i OL-07): a peer-supplied run:/dispatch: pointer must
// pass the S10-20 id grammar BEFORE any lookup. Without this, assertPeerMailDestinationAllowed's
// own `db.getRemoteDispatchAttachment(destination.dispatchId)` below, and resolveMessageRun's
// `db.getDispatchContextById`/`db.getRun` right after it (orchestration.ts), both ran a raw,
// unvalidated wire string straight into a lookup and then echoed it verbatim in a
// `dispatch_not_found`/`run_not_found` refusal — no audit row, wrong error code. Call this FIRST,
// ahead of assertPeerMailDestinationAllowed, on the same raw destination. A non-peer caller is a
// no-op, same boundary as assertPeerMailDestinationAllowed: a local caller's own typed id is
// unaffected and may still be echoed on a genuine not-found, unchanged.
export function assertPeerMailPointerGrammar(
  db: OrchestrationDb,
  accessProfile: 'full' | 'peer' | undefined,
  callerFingerprint: string | undefined,
  destination: PeerMailDestination
): void {
  if (accessProfile !== 'peer') {
    return
  }
  const malformed =
    (destination.kind === 'run' && !isHostScopedId(destination.runId, ['run'])) ||
    (destination.kind === 'dispatch' && !isHostScopedId(destination.dispatchId, ['ctx']))
  if (!malformed) {
    return
  }
  // Host-keyed, never wire-keyed: exactly one audit row per refusal, the pointer's own bytes
  // never enter it (agentId/actorPaneKey are null — no local identity is implicated).
  db.writeAgentAudit({
    agentId: null,
    actorPaneKey: null,
    actorHostId: callerFingerprint ?? null,
    verb: 'send',
    outcome: 'invalid_argument',
    reasonCode: 'malformed_relay_id'
  })
  // Host-constant message — the wire string is never interpolated.
  throw new OrchestrationError(
    'invalid_argument',
    'The relayed recipient pointer is not a valid host-minted id.',
    {
      effectsApplied: false,
      nextSteps: [
        'this indicates a version-mismatched or malformed peer relay — update Orca on the sending host'
      ]
    }
  )
}

export function assertPeerMailDestinationAllowed(
  db: OrchestrationDb,
  accessProfile: 'full' | 'peer' | undefined,
  callerFingerprint: string | undefined,
  destination: PeerMailDestination
): void {
  if (accessProfile !== 'peer') {
    return
  }
  if (destination.kind === 'run') {
    return
  }
  if (destination.kind === 'dispatch') {
    const attachment = db.getRemoteDispatchAttachment(destination.dispatchId)
    if (attachment && attachment.home_peer_fingerprint === callerFingerprint) {
      return
    }
  }
  throw new OrchestrationError(
    'forbidden',
    'A federation peer may only address its own Run mailbox (an explicit run:<id> it already ' +
      'knows) or a Dispatch this link owns.',
    {
      effectsApplied: false,
      nextSteps: [
        'address --run <run_id> (the run mailbox this link already knows) or --to dispatch:<id> for a Dispatch this link owns'
      ]
    }
  )
}
