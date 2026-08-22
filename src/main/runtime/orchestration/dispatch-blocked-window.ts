import { ORCHESTRATION_ASK_MAX_TIMEOUT_MS } from '../../../shared/orchestration-ask-timeout'
import { parseOrchestrationTimestampMs } from './dispatch-heartbeat-age'

// Why capped: the marker is durable, so a runtime restart while a worker is parked leaves it set
// with no return to clear it. No legal park outlasts the longest `ask` a caller can buy, so past
// that the exemption expires and a worker that died parked breaches late rather than never.
export const DISPATCH_BLOCKED_EXEMPTION_CAP_MS = ORCHESTRATION_ASK_MAX_TIMEOUT_MS

export type DispatchLivenessInput = {
  lastHeartbeatAt?: string | null
  dispatchedAt?: string | null
  blockedSince?: string | null
  windowMs: number
  now?: number
}

export type DispatchLivenessVerdict = {
  breached: boolean
  silenceMs?: number
  exemptedMs?: number
  effectiveSilenceMs?: number
}

// Why this exists: preamble.ts tells a worker to stop heartbeating while parked in `ask` or
// `check --wait` because "those calls are themselves liveness signals" — a promise nothing kept,
// which made the best-behaved workers the first ones a window would falsely kill (A1 §14).
// Every liveness window subtracts the parked interval here rather than re-deriving it.
//
// Why never a verdict from silence alone: absence of output is not evidence (A1 §3 separability
// ceiling). This reports an age against a caller-chosen window; naming a stall class stays with
// the caller, which owns the positive evidence.
export function evaluateDispatchLiveness(input: DispatchLivenessInput): DispatchLivenessVerdict {
  const now = input.now ?? Date.now()
  const lastSignalMs =
    parseOrchestrationTimestampMs(input.lastHeartbeatAt) ??
    parseOrchestrationTimestampMs(input.dispatchedAt)
  // Why absent, never zero: a Dispatch with no stamped signal has no age, and a 0 there reads as
  // "heard from just now" — the false green this surface exists to remove.
  if (lastSignalMs === null) {
    return { breached: false }
  }
  const silenceMs = Math.max(0, now - lastSignalMs)
  const blockedSinceMs = parseOrchestrationTimestampMs(input.blockedSince)
  // Why the overlap, not the whole park: only the part of the park that fell inside the silence
  // was ever counted against the worker, so only that part can be given back.
  const exemptedMs =
    blockedSinceMs === null
      ? 0
      : Math.min(
          DISPATCH_BLOCKED_EXEMPTION_CAP_MS,
          Math.max(0, now - Math.max(blockedSinceMs, lastSignalMs))
        )
  const effectiveSilenceMs = Math.max(0, silenceMs - exemptedMs)
  // Why <= 0 is not a breach: A1 §3 reserves a zero window as the explicit disable.
  const armed = Number.isFinite(input.windowMs) && input.windowMs > 0
  return {
    breached: armed && effectiveSilenceMs > input.windowMs,
    silenceMs,
    exemptedMs,
    effectiveSilenceMs
  }
}

export type DispatchBlockedMarkerStore = {
  markDispatchBlocked: (dispatchId: string, at: string) => void
  clearDispatchBlocked: (dispatchId: string) => void
}

// Why opportunistic on both edges: identity resolution is best-effort in the SSH-remote, WSL and
// remote-run-mailbox shapes, and a liveness hint must never be the reason a worker's `ask` or
// `check --wait` fails. Both writes carry the dispatchId + status='dispatched' guard in SQL, so a
// settled, missing or retried Dispatch matches no row instead of being marked.
//
// FEDERATED ASYMMETRY — pinned by test, deliberately not fixed here: a federated worker runs
// `ask` / `check` against the PEER, and a peer holds only a remote_dispatch_attachments row, never
// a dispatch_contexts row for the home's dispatch id, so the peer-side park matches nothing and
// the home's marker does not move. The home's liveness for a federated Dispatch advances only
// through relayed heartbeats, so its window must be generous enough to cover a full `ask`. Do not
// relay this marker: it is a home-local column, not wire state.
export async function whileDispatchBlocked<T>(
  store: DispatchBlockedMarkerStore,
  dispatchId: string | undefined,
  park: () => Promise<T>
): Promise<T> {
  if (!dispatchId) {
    return park()
  }
  try {
    store.markDispatchBlocked(dispatchId, new Date().toISOString())
  } catch {
    // Why swallowed: the marker is a hint, never a precondition of the verb the worker is running.
  }
  try {
    return await park()
  } finally {
    try {
      store.clearDispatchBlocked(dispatchId)
    } catch {
      // Why swallowed: a park that returned must not fail on bookkeeping; the cap bounds a stuck marker.
    }
  }
}
