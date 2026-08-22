import type { OrcaRuntimeService } from '../orca-runtime'
import { observeWorkerAgentGate } from '../rpc/methods/orchestration-worker-observation'
import type { OrchestrationDb } from './db'
import { parseOrchestrationTimestampMs } from './dispatch-heartbeat-age'
import { parseDispatchInputEvidence } from './dispatch-input-evidence'
import {
  DISPATCH_INPUT_TERMINAL_EXITED_DWELL_MS,
  evaluateDispatchInputObservation,
  type DispatchInputObservation,
  type DispatchInputObservationTargetRow
} from './dispatch-input-observation'
import { postRuntimeNotification } from './runtime-notification'
import { RUNTIME_NOTIFICATION_MESSAGE_TYPE } from './types'

export type FederatedDispatchInputObserverTarget = {
  dispatchId: string
  taskId: string
  terminalHandle: string
  taskSpec: string
  submittedAt: number
  processIncarnation: string | null
}

type DispatchInputObserverProbe = {
  agentStatus: 'working' | 'permission' | 'idle' | null
  blockedSince: number | null
  terminalStatus: 'running' | 'exited' | null
  processLiveness: 'live' | 'dead' | 'unknown'
  tailText: string | null
}

// Why every probe below swallows its own failure: a stale handle, a torn-down PTY and an SSH host
// that stopped answering all throw here, and none of them is evidence about the agent. Tranche 3's
// precedent stands — a throw reads as unknown, and unknown produces no report.
async function probeDispatchInput(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  processIncarnation: string | null,
  hostScope: string | null
): Promise<DispatchInputObserverProbe> {
  const gate = await observeWorkerAgentGate(runtime, terminalHandle)
  const evidence = runtime.getTerminalWaitEvidence(terminalHandle)
  const processLiveness = processIncarnation
    ? await runtime
        .inspectTerminalProcessIncarnationLiveness(processIncarnation, hostScope)
        .catch(() => 'unknown' as const)
    : 'unknown'
  const terminal = await runtime.showTerminal(terminalHandle).catch(() => null)
  return {
    agentStatus: gate.agentStatus ?? null,
    blockedSince: parseOrchestrationTimestampMs(gate.blockedSince),
    // Why only these two of the five observation states: `missing` and `identity_changed` say the
    // handle no longer names this worker, and the caller has already refused those by identity.
    terminalStatus: terminal ? (terminal.connected === false ? 'exited' : 'running') : null,
    processLiveness,
    tailText: evidence?.tailText ?? null
  }
}

// Why the disconnected reading gets a dwell and the dead one does not: `dead` is a probed verdict
// about the process, while `connected === false` is `ptyId !== null` and goes false for a graph
// rebuild or an SSH blip the runtime itself expects to recover (A1 section 2's precision rule).
function holdBackTransientProcessGone(
  observation: DispatchInputObservation | null,
  now: number,
  exitedSince: number | null
): { observation: DispatchInputObservation | null; exitedSince: number | null } {
  if (observation?.terminalStatus !== 'exited') {
    return { observation, exitedSince: null }
  }
  const since = exitedSince ?? now
  return now - since >= DISPATCH_INPUT_TERMINAL_EXITED_DWELL_MS
    ? { observation, exitedSince: since }
    : { observation: null, exitedSince: since }
}

export type DispatchInputObserverTickResult = {
  disarm: boolean
  observation: DispatchInputObservation | null
  // Why carried out and back in: the dwell on a disconnected pane needs a first sighting, and the
  // observer is a stateless function whose only memory is the runtime's armed record.
  exitedSince: number | null
}

export async function tickDispatchInputObserver(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  now?: number
  exitedSince?: number | null
}): Promise<DispatchInputObserverTickResult> {
  const now = args.now ?? Date.now()
  const [target] = args.db.listDispatchInputObservationTargets(args.dispatchId)
  // Why disarm rather than retry: the row leaves this set on settlement, on worker-release and on
  // the claim this observer itself makes, so its absence is the self-disarm A1 section 2 asks for.
  if (!target) {
    return { disarm: true, observation: null, exitedSince: null }
  }
  const { observation, exitedSince } = holdBackTransientProcessGone(
    await observeDispatchInputTarget({ ...args, target, now }),
    now,
    args.exitedSince ?? null
  )
  if (!observation) {
    return { disarm: false, observation: null, exitedSince }
  }
  if (!args.db.claimDispatchInputObservation(target.dispatch_id, new Date(now).toISOString())) {
    return { disarm: true, observation: null, exitedSince }
  }
  const notice = describeDispatchInputObservation(observation, target.dispatch_id)
  postRuntimeNotification({
    db: args.db,
    runtime: args.runtime,
    runId: target.run_id,
    subject: notice.subject,
    body: notice.body,
    payload: { dispatchId: target.dispatch_id, taskId: target.task_id, ...observation }
  })
  return { disarm: true, observation, exitedSince }
}

async function observeDispatchInputTarget(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  target: DispatchInputObservationTargetRow
  now: number
}): Promise<DispatchInputObservation | null> {
  const { target } = args
  // Why identity first: a re-minted pane answers on the same handle, and Tranche 3's precedent
  // (inspectWorkerTerminal) refuses to attach any verdict to a handle that names another process —
  // "Worker <id> is gone" about a working agent also burns the once-per-Dispatch budget.
  if (
    !args.db.isDispatchProcessCurrent({
      dispatchId: target.dispatch_id,
      paneKey: args.runtime.getTerminalPaneKey(target.agent_terminal_handle),
      processIncarnation: args.runtime.getTerminalProcessIncarnation(target.agent_terminal_handle)
    })
  ) {
    return null
  }
  const resource = args.db.getWorkerTerminalResourceByOwner(target.dispatch_id)
  const probe = await probeDispatchInput(
    args.runtime,
    target.agent_terminal_handle,
    target.process_incarnation,
    resource?.host_scope ?? null
  )
  return evaluateDispatchInputObservation({
    now: args.now,
    submittedAt: resolveSubmittedAt(target.input_evidence),
    heartbeated: target.last_heartbeat_at !== null,
    taskSpec: target.spec,
    ...probe
  })
}

// Why the peer keeps its target in memory: it has no task row to read the spec back from and no
// heartbeat column to consult, so unlike the home its observer cannot be rebuilt from the database
// after a restart. A peer restart therefore loses the observer rather than re-firing it.
export async function tickFederatedDispatchInputObserver(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  target: FederatedDispatchInputObserverTarget
  now?: number
  exitedSince?: number | null
}): Promise<DispatchInputObserverTickResult> {
  const now = args.now ?? Date.now()
  const attachment = args.db.getRemoteDispatchAttachment(args.target.dispatchId)
  if (attachment?.state !== 'ready') {
    return { disarm: true, observation: null, exitedSince: null }
  }
  // Why the peer runs the same identity refusal: its pane can be re-minted exactly like the home's,
  // and the attachment row is the peer's own record of which process this Dispatch owns.
  if (
    !args.db.isRemoteAttachmentProcessCurrent({
      dispatchId: args.target.dispatchId,
      paneKey: args.runtime.getTerminalPaneKey(args.target.terminalHandle),
      processIncarnation: args.runtime.getTerminalProcessIncarnation(args.target.terminalHandle)
    })
  ) {
    return { disarm: false, observation: null, exitedSince: null }
  }
  const probe = await probeDispatchInput(
    args.runtime,
    args.target.terminalHandle,
    args.target.processIncarnation,
    null
  )
  const { observation, exitedSince } = holdBackTransientProcessGone(
    evaluateDispatchInputObservation({
      now,
      submittedAt: args.target.submittedAt,
      heartbeated: args.db.hasFederatedWorkerSpoken(args.target.dispatchId),
      taskSpec: args.target.taskSpec,
      ...probe
    }),
    now,
    args.exitedSince ?? null
  )
  if (!observation) {
    return { disarm: false, observation: null, exitedSince }
  }
  const notice = describeDispatchInputObservation(observation, args.target.dispatchId)
  args.db.enqueueFederationRelay({
    dispatchId: args.target.dispatchId,
    direction: 'to_home',
    // Why its own relay kind: the queue is also this runtime's evidence that the worker has spoken,
    // so a notice the runtime wrote must not be counted as the worker speaking.
    kind: 'runtime_notification',
    payload: JSON.stringify({
      from: `dispatch:${args.target.dispatchId}`,
      subject: notice.subject,
      body: notice.body,
      type: RUNTIME_NOTIFICATION_MESSAGE_TYPE,
      priority: 'high',
      threadId: null,
      payload: JSON.stringify(
        buildDispatchInputObservationPayload(
          observation,
          args.target.dispatchId,
          args.target.taskId
        )
      )
    })
  })
  return { disarm: true, observation, exitedSince }
}

function resolveSubmittedAt(inputEvidence: string | null): number | null {
  return parseOrchestrationTimestampMs(parseDispatchInputEvidence(inputEvidence)?.submittedAt)
}

function buildDispatchInputObservationPayload(
  observation: DispatchInputObservation,
  dispatchId: string,
  taskId: string
): Record<string, unknown> {
  return { origin: 'runtime', dispatchId, taskId, ...observation }
}

// Why the body says what was seen and what was not: the same channel carries worker-raised
// escalations, and a coordinator that cannot tell an observation from a request will either act on
// the wrong one or stop reading both.
function describeDispatchInputObservation(
  observation: DispatchInputObservation,
  dispatchId: string
): { subject: string; body: string } {
  const minutes = Math.round(observation.observedForMs / 60_000)
  if (observation.kind === 'worker_process_gone') {
    return {
      subject: `Worker ${dispatchId} is gone`,
      body:
        `The terminal running Dispatch ${dispatchId} is no longer alive and the Dispatch never ` +
        'settled. Nothing was changed; read the worker before deciding.'
    }
  }
  if (observation.kind === 'blocked_on_gate') {
    return {
      subject: `Worker ${dispatchId} is waiting at a gate`,
      body:
        `Dispatch ${dispatchId} has been at an interactive permission gate for ` +
        `${Math.round((observation.blockedForMs ?? 0) / 1_000)}s and has never heartbeated. ` +
        'The runtime observed this; the agent did not report it.'
    }
  }
  return {
    subject: `Worker ${dispatchId} has not consumed its task`,
    body:
      `The terminal for Dispatch ${dispatchId} still shows the dispatch prompt ${minutes} min ` +
      'after it was written, with no agent output after it and no heartbeat. The runtime ' +
      'observed this; the agent did not report it.'
  }
}
