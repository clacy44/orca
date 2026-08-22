import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { parseDispatchInputEvidence } from '../../orchestration/dispatch-input-evidence'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { FederatedDispatchRow, WorkerDispatchRow } from '../../orchestration/types'

export type WorkerAgentGateObservation = {
  agentStatus?: 'working' | 'permission' | 'idle'
  blockedSince?: string
}

export type WorkerTerminalObservation = WorkerAgentGateObservation & {
  terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>> | null
  exact: boolean
  status: 'unattached' | 'missing' | 'identity_changed' | 'running' | 'exited'
}

export async function inspectWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  // Why opt-in: worker-read, worker-stop and release share this helper and drop the verdict, and
  // the probe can reach getForegroundProcess — an SSH round trip they should not pay for.
  options?: { probeAgentGate?: boolean }
): Promise<WorkerTerminalObservation> {
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker?.agent_terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached' }
  }
  const terminal = await runtime.showTerminal(worker.agent_terminal_handle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' }
  }
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(worker.agent_terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(worker.agent_terminal_handle)
  })
  return {
    terminal,
    exact,
    status: exact ? (terminal.connected === false ? 'exited' : 'running') : 'identity_changed',
    // Why: a non-exact handle names some other process, so its status would be a fabricated
    // verdict about this worker; identity_changed stays the whole answer.
    ...(exact && options?.probeAgentGate
      ? await observeWorkerAgentGate(runtime, worker.agent_terminal_handle)
      : {})
  }
}

// Why: getTerminalAgentStatus throws for gone/exited/stale handles, and worker-show already
// succeeds on those — every failure must read as unknown (absent), never propagate.
export async function observeWorkerAgentGate(
  runtime: OrcaRuntimeService,
  handle: string
): Promise<WorkerAgentGateObservation> {
  const agentStatus = await runtime
    .getTerminalAgentStatus(handle)
    .then((result) => result.status)
    .catch(() => null)
  if (agentStatus !== 'permission') {
    return agentStatus ? { agentStatus } : {}
  }
  // Why: blockedSince denotes the gate's first sighting, so it means nothing unless the worker
  // is actually at one; a falsy stamp is no evidence and must stay absent rather than read as 0.
  const blockedAt = runtime.getTerminalWaitBlockedAt(handle)
  return blockedAt
    ? { agentStatus, blockedSince: new Date(blockedAt).toISOString() }
    : { agentStatus }
}

export function exposeWorkerObservation(observation: WorkerTerminalObservation): {
  status: string
  exactWorker: boolean
} & WorkerAgentGateObservation {
  return {
    status: observation.status,
    exactWorker: observation.exact,
    ...(observation.agentStatus ? { agentStatus: observation.agentStatus } : {}),
    ...(observation.blockedSince ? { blockedSince: observation.blockedSince } : {})
  }
}

export function exposeWorker(worker: WorkerDispatchRow) {
  // Why absent rather than null when there is none: a coordinator reading `inputEvidence: null`
  // would take it as "nothing was on screen", and the honest answer for a row written before the
  // column existed is that nobody looked (A1 section 2).
  const inputEvidence = parseDispatchInputEvidence(worker.input_evidence)
  return {
    ...worker,
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    startOptions: JSON.parse(worker.start_options) as unknown,
    ...(inputEvidence ? { inputEvidence } : {})
  }
}

export function resolvePinnedFederatedServer(
  runtime: OrcaRuntimeService,
  federated: FederatedDispatchRow
) {
  const server = runtime.resolveOrchestrationWorkerServer(federated.environment_id)
  if (server.peerFingerprint !== federated.peer_fingerprint) {
    throw new OrchestrationError(
      'peer_changed',
      `Saved environment ${federated.environment_name} now identifies a different Orca server.`
    )
  }
  return server
}

export async function callFederatedWorkerShow(
  runtime: OrcaRuntimeService,
  federated: FederatedDispatchRow
): Promise<{
  runtimeEpoch: string
  attachment: {
    state: string
    stage: string
    last_error: string | null
    worktree_id: string | null
    terminal_handle: string | null
    setup_state: string
    effects: unknown[]
    residualResources: unknown[]
  }
  terminal: unknown
  // Why optional: the gate fields arrive only from a peer new enough to observe them; absent
  // must read as unknown on the home rather than as a verdict.
  observation: { status: string; exactWorker: boolean } & WorkerAgentGateObservation
}> {
  return (await runtime.callOrchestrationWorkerServer(
    federated.environment_id,
    'orchestration.federationShow',
    { dispatchId: federated.dispatch_id },
    15_000
  )) as Awaited<ReturnType<typeof callFederatedWorkerShow>>
}
