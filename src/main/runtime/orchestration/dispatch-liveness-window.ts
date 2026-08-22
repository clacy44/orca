import { ORCHESTRATION_ASK_MAX_TIMEOUT_MS } from '../../../shared/orchestration-ask-timeout'
import { evaluateDispatchLiveness } from './dispatch-blocked-window'
import { summarizeDispatchHeartbeat } from './dispatch-heartbeat-age'
import { HEARTBEAT_INTERVAL_MIN } from './preamble'

// Why the longest legal `ask` and not coordinator.ts's 10 minutes: the preamble tells a parked
// worker to stop heartbeating, so a shorter default breaches on healthy blocked workers wherever
// §14's marker is missing (a restart mid-park, an identity that resolved to nothing).
export const DISPATCH_LIVENESS_DEFAULT_WINDOW_MS = ORCHESTRATION_ASK_MAX_TIMEOUT_MS

// Why wider when federated: the home's marker never moves for a peer-side park, so its silence
// starts at the last relayed heartbeat — a full cadence before the `ask` did (A1 §14).
export const DISPATCH_FEDERATED_LIVENESS_DEFAULT_WINDOW_MS =
  ORCHESTRATION_ASK_MAX_TIMEOUT_MS + 2 * HEARTBEAT_INTERVAL_MIN * 60_000

// Why default-on rather than opt-in: the runs this catches are precisely the ones nobody would
// have opted in for, so an opt-in liveness contract is discipline wearing a flag (A1 §3).
export function resolveDispatchLivenessWindowMs(
  startOptions: string | null | undefined,
  options?: { federated?: boolean }
): number {
  const fallback = options?.federated
    ? DISPATCH_FEDERATED_LIVENESS_DEFAULT_WINDOW_MS
    : DISPATCH_LIVENESS_DEFAULT_WINDOW_MS
  if (!startOptions) {
    return fallback
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(startOptions)
  } catch {
    return fallback
  }
  const requested = (parsed as { livenessWindowMs?: unknown } | null)?.livenessWindowMs
  // Why 0 survives this guard: it is the explicit disable, not a missing value.
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
    ? requested
    : fallback
}

export type DispatchLivenessCandidateRow = {
  id: string
  run_id: string
  task_id: string
  dispatched_at: string | null
  last_heartbeat_at: string | null
  blocked_since: string | null
  start_options: string | null
  // Why on the row and not a second query: the peer-side park is invisible here, so the window has
  // to know which half of the asymmetry it is judging.
  federated: number
}

export type DispatchLivenessBreach = {
  dispatchId: string
  runId: string
  taskId: string
  lastHeartbeatAt: string | null
  windowMs: number
  silenceMs: number
  effectiveSilenceMs: number
}

// Why this is positive evidence and not silence: the preamble commits the worker to a heartbeat
// cadence and exempts only the park, which is subtracted — what remains is a heartbeat that was
// EXPECTED and did not arrive, never an inference from a quiet terminal.
export function selectDispatchLivenessBreaches(
  rows: readonly DispatchLivenessCandidateRow[],
  now: number = Date.now()
): DispatchLivenessBreach[] {
  const breaches: DispatchLivenessBreach[] = []
  for (const row of rows) {
    const windowMs = resolveDispatchLivenessWindowMs(row.start_options, {
      federated: Boolean(row.federated)
    })
    const verdict = evaluateDispatchLiveness({
      lastHeartbeatAt: row.last_heartbeat_at,
      dispatchedAt: row.dispatched_at,
      blockedSince: row.blocked_since,
      windowMs,
      now
    })
    if (!verdict.breached) {
      continue
    }
    breaches.push({
      dispatchId: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      // Why normalized and nullable: the column carries both the SQLite space format and the send
      // path's ISO, and a Dispatch that never heartbeated must report null rather than its start.
      lastHeartbeatAt:
        summarizeDispatchHeartbeat(row.last_heartbeat_at, now).lastHeartbeatAt ?? null,
      windowMs,
      silenceMs: verdict.silenceMs ?? 0,
      effectiveSilenceMs: verdict.effectiveSilenceMs ?? 0
    })
  }
  return breaches
}
