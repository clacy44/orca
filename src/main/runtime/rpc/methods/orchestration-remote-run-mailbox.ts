import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RunRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { resolveRunScope, type RunScopeParams } from './orchestration-run-scope'

// Why: the Run mailbox lives in exactly one runtime's SQLite, so an agent told "there is
// mail for you in run_X" on another runtime has no local row to read. This path lets a
// paired runtime read/write that mailbox on the runtime that owns it.
//
// TRUST ARGUMENT — why dropping requireCurrentConsumer here is not an escalation:
// requireCurrentConsumer answers "is the caller's PANE the Run's current consumer", which
// is a *binding* question about panes in this runtime's own DB. A paired peer has no pane
// here, so the question is unanswerable, not merely unanswered. What authorizes the call
// instead is the runtime-scope pairing the peer already holds: that credential lets it
// create terminals and drive agents on this host (`terminal.send`, `worker-start`), so it
// could always post and read Run mail by driving a local pane. Reading the same mailbox
// directly is strictly less capable than the terminal-drive rights pairing already grants.
// The claim is checked against the authenticated socket identity (`pairedDeviceId` +
// runtime scope), never against a caller-supplied handle, and it never rebinds the Run:
// the read joins the Run's CURRENT consumer generation, so acks land in this (the
// authoritative) DB and the locally bound coordinator is not fenced.
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
