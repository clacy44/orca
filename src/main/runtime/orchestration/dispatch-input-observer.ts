import type { OrcaRuntimeService } from '../orca-runtime'
import { observeWorkerAgentGate } from '../rpc/methods/orchestration-worker-observation'
import type { OrchestrationDb } from './db'
import { parseOrchestrationTimestampMs } from './dispatch-heartbeat-age'
import { parseDispatchInputEvidence } from './dispatch-input-evidence'
import {
  evaluateDispatchInputObservation,
  type DispatchInputObservation,
  type DispatchInputObservationTargetRow
} from './dispatch-input-observation'
import { RUNTIME_NOTIFICATION_MESSAGE_TYPE } from './types'

// Why the same sender the liveness breach uses: A1 section 12 puts runtime-generated notices on the
// escalation channel workers also raise on, so the coordinator must be able to see at a glance that
// the runtime said this. On the federated leg the home rewrites the sender to the Dispatch, which
// is why payload.origin carries the same claim for a machine reader.
export const DISPATCH_INPUT_OBSERVATION_SENDER = 'runtime'

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
    // handle no longer names this worker, which is a fact about the handle, not a dead process.
    terminalStatus: terminal ? (terminal.connected === false ? 'exited' : 'running') : null,
    processLiveness,
    tailText: evidence?.tailText ?? null
  }
}

export async function tickDispatchInputObserver(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  now?: number
}): Promise<{ disarm: boolean; observation: DispatchInputObservation | null }> {
  const now = args.now ?? Date.now()
  const [target] = args.db.listDispatchInputObservationTargets(args.dispatchId)
  // Why disarm rather than retry: the row leaves this set on settlement, on worker-release and on
  // the claim this observer itself makes, so its absence is the self-disarm A1 section 2 asks for.
  if (!target) {
    return { disarm: true, observation: null }
  }
  const observation = await observeDispatchInputTarget({ ...args, target, now })
  if (!observation) {
    return { disarm: false, observation: null }
  }
  if (!args.db.claimDispatchInputObservation(target.dispatch_id, new Date(now).toISOString())) {
    return { disarm: true, observation: null }
  }
  const notice = describeDispatchInputObservation(observation, target.dispatch_id)
  const message = args.db.insertMessage({
    runId: target.run_id,
    from: DISPATCH_INPUT_OBSERVATION_SENDER,
    to: `run:${target.run_id}`,
    subject: notice.subject,
    body: notice.body,
    type: RUNTIME_NOTIFICATION_MESSAGE_TYPE,
    priority: 'high',
    payload: JSON.stringify(
      buildDispatchInputObservationPayload(observation, target.dispatch_id, target.task_id)
    )
  })
  args.runtime.notifyMessageArrived(message.to_handle, message.type)
  return { disarm: true, observation }
}

async function observeDispatchInputTarget(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  target: DispatchInputObservationTargetRow
  now: number
}): Promise<DispatchInputObservation | null> {
  const { target } = args
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
}): Promise<{ disarm: boolean; observation: DispatchInputObservation | null }> {
  const now = args.now ?? Date.now()
  const attachment = args.db.getRemoteDispatchAttachment(args.target.dispatchId)
  if (attachment?.state !== 'ready') {
    return { disarm: true, observation: null }
  }
  const probe = await probeDispatchInput(
    args.runtime,
    args.target.terminalHandle,
    args.target.processIncarnation,
    null
  )
  const observation = evaluateDispatchInputObservation({
    now,
    submittedAt: args.target.submittedAt,
    heartbeated: args.db.hasFederatedWorkerSpoken(args.target.dispatchId),
    taskSpec: args.target.taskSpec,
    ...probe
  })
  if (!observation) {
    return { disarm: false, observation: null }
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
  return { disarm: true, observation }
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
