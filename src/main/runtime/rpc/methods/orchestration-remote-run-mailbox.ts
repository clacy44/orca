import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RunRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { resolveRunScope, type RunScopeParams } from './orchestration-run-scope'

// Why: the Run mailbox lives in exactly one runtime's SQLite, so an agent told "there is
// mail for you in run_X" on another runtime has no local row to read. This path lets a
// paired runtime read/write that mailbox on the runtime that owns it.
//
// TRUST ARGUMENT — why dropping requireCurrentConsumer here is not an escalation (S10-19
// §13.1, R18 — rewritten, not annotated: the pre-S10-19 text claimed a peer "could always
// post and read Run mail by driving a local pane", which is false under a peer-profile
// grant — terminal.create is refused and terminal.send does not exist for a peer at all):
// The caller is an authenticated runtime-scope paired device (`pairedDeviceId` +
// `clientKind === 'runtime'`), asserted up front and never from a caller-supplied handle;
// the read joins the Run's CURRENT consumer generation rather than rebinding it, so a
// locally bound coordinator is never fenced and acks land in the authoritative DB. Under a
// federation-peer grant this is a first-class capability, not a shortcut around one the
// peer already had: `terminal.create` and `terminal.send` are both refused and the peer
// has no pane input at all beyond a two-value startup-prompt answer the host types
// (`orchestration.federationAnswerPrompt`). What bounds it is that the mailbox is
// addressed by Run id only — body handles, pane keys and `from` are refused for a peer
// caller (§8.1/§8.2) — and that a peer may not take the exclusive waiter on a Run a local
// pane is bound to (R24, `run_wait_local_only`). A Run id is a bearer capability: any peer
// holding one can read and consume that Run's mail. Scoping a peer to Runs it was
// explicitly told about requires the link binding S10-16 lands; until then, treat a Run id
// shared with a peer as shared with that whole host.
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
