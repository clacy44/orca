import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

export type RemoteStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  inputEvidence?: unknown
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

// S10-19 W-3 (attacker 9): the closed list a worker-server's reported failure code must be in
// before its outcome is trusted as 'known' (a clean, no-residual failure) rather than
// 'outcome_unknown' (orphan-recovery-needed). `error.data` (an arbitrary `data.effectsApplied`
// included) is NEVER independently authoritative — a hostile worker server could otherwise claim
// "no effects applied" under any code at all and suppress the home's only orphaned-resource
// signal. The code list alone decides; nothing else a peer's error carries can widen it.
const KNOWN_REMOTE_START_FAILURE_CODES = [
  'invalid_argument',
  'agent_unconfigured',
  'worktree_not_found_on_server',
  'terminal_worktree_mismatch',
  'capability_unsupported',
  'forbidden'
]

function isKnownRemoteStartFailure(code: string): boolean {
  return KNOWN_REMOTE_START_FAILURE_CODES.includes(code)
}

export function classifyRemoteStartFailure(error: unknown): 'known' | 'unknown' {
  return error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    isKnownRemoteStartFailure((error as { code: string }).code)
    ? 'known'
    : 'unknown'
}

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
