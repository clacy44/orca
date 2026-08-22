import { DISPATCH_PREAMBLE_TASK_MARKER } from './preamble'

// Why 45s and not tighter: the observer exists to catch a worker that never started, not to track
// one that is running, so the tick only has to be fast relative to the dwell it is measuring.
export const DISPATCH_INPUT_OBSERVER_INTERVAL_MS = 45_000

// Why 90s and explicitly NOT the measured ~20s self-submit: that figure is Windows-only (n=2) and
// the one Linux/AppImage run showed no self-submit at 90s (n=1), so tuning the dwell to 20s would
// report every slower-booting agent as stuck. A1 section 2's caveat names this exact trap.
export const DISPATCH_INPUT_OBSERVATION_DWELL_MS = 90_000

export type DispatchInputObservationKind =
  | 'blocked_on_gate'
  | 'input_not_consumed'
  | 'worker_process_gone'

export type DispatchInputObservationEvidence = {
  now: number
  submittedAt: number | null
  // Why one boolean and not the timestamp: any heartbeat at all means the agent ran the CLI, which
  // is proof the prompt was consumed — how long ago it was is a question for the liveness window.
  heartbeated: boolean
  agentStatus: 'working' | 'permission' | 'idle' | null
  blockedSince: number | null
  terminalStatus: 'running' | 'exited' | null
  processLiveness: 'live' | 'dead' | 'unknown'
  tailText: string | null
  taskSpec: string
}

export type DispatchInputObservation = {
  kind: DispatchInputObservationKind
  observedForMs: number
  agentStatus?: 'working' | 'permission' | 'idle'
  blockedForMs?: number
  terminalStatus?: 'exited'
  processLiveness?: 'dead'
}

// Why every branch below needs a fact and none needs a clock alone: A1's separability ceiling says
// (a) booting and (c) thinking silently are not separable from each other for a title-less agent,
// so a quiet worker produces nothing here — not a softer verdict, nothing. A false "your worker is
// stuck" on a 40-minute refactor trains coordinators to ignore the signal permanently.
export function evaluateDispatchInputObservation(
  evidence: DispatchInputObservationEvidence
): DispatchInputObservation | null {
  const observedForMs = evidence.submittedAt === null ? 0 : evidence.now - evidence.submittedAt
  // Why first and without a dwell: a dead incarnation or an exited terminal is a settled fact about
  // the process, not an inference about what the agent is doing, so waiting adds nothing.
  if (evidence.processLiveness === 'dead') {
    return { kind: 'worker_process_gone', observedForMs, processLiveness: 'dead' }
  }
  if (evidence.terminalStatus === 'exited') {
    return { kind: 'worker_process_gone', observedForMs, terminalStatus: 'exited' }
  }
  if (evidence.heartbeated) {
    return null
  }
  if (
    evidence.agentStatus === 'permission' &&
    evidence.blockedSince !== null &&
    evidence.now - evidence.blockedSince >= DISPATCH_INPUT_OBSERVATION_DWELL_MS
  ) {
    return {
      kind: 'blocked_on_gate',
      observedForMs,
      agentStatus: 'permission',
      blockedForMs: evidence.now - evidence.blockedSince
    }
  }
  if (
    evidence.submittedAt !== null &&
    observedForMs >= DISPATCH_INPUT_OBSERVATION_DWELL_MS &&
    evidence.agentStatus !== 'working' &&
    evidence.tailText !== null &&
    tailStillHoldsUnansweredTask(evidence.tailText, evidence.taskSpec)
  ) {
    return {
      kind: 'input_not_consumed',
      observedForMs,
      ...(evidence.agentStatus ? { agentStatus: evidence.agentStatus } : {})
    }
  }
  return null
}

// Why precision over recall: an agent whose composer prints a hint line after the pasted prompt
// reads here as "something happened" and produces no report. That is a miss, and a miss is the
// correct failure — the alternative is a per-agent allowlist of chrome strings that eventually
// mistakes a real transcript for chrome and reports a healthy worker as stuck.
export function tailStillHoldsUnansweredTask(tailText: string, taskSpec: string): boolean {
  const markerIndex = tailText.lastIndexOf(DISPATCH_PREAMBLE_TASK_MARKER)
  if (markerIndex === -1) {
    return false
  }
  const specLines = new Set(
    taskSpec
      .split('\n')
      .map(stripTerminalChrome)
      .filter((line) => line.length > 0)
  )
  let renderedSpecLine = false
  for (const line of tailText
    .slice(markerIndex + DISPATCH_PREAMBLE_TASK_MARKER.length)
    .split('\n')) {
    const content = stripTerminalChrome(line)
    if (content.length === 0) {
      continue
    }
    if (!specLines.has(content)) {
      return false
    }
    renderedSpecLine = true
  }
  // Why the marker alone is not enough: a tail truncated mid-paste also ends at the marker, and
  // that says the buffer rolled over, not that the agent ignored the prompt.
  return renderedSpecLine
}

// Why only box glyphs and the prompt caret: those are the frame a TUI draws around text it did not
// author, so removing them lets a boxed prompt line compare equal to the line that was pasted.
const TERMINAL_FRAME_GLYPH_RE = /[\u2500-\u259f\u276f>]/g

function stripTerminalChrome(line: string): string {
  return line.replace(TERMINAL_FRAME_GLYPH_RE, '').trim()
}

export type DispatchInputObservationTargetRow = {
  dispatch_id: string
  run_id: string
  task_id: string
  agent_terminal_handle: string
  process_incarnation: string | null
  input_evidence: string | null
  last_heartbeat_at: string | null
  spec: string
}
