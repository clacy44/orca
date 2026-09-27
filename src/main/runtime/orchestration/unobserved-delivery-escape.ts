// [I-24-1 FIX-1] Pure decision logic for the bounded unobserved-starvation escape — the primary
// fix for E1/E5 (I-24-1 EVIDENCE): a pane not observed live this runtime, with no fresh Claude
// hook, sits in `no_hydrated_status`/`awaiting_idle_edge`/`probe_failed` forever, because the
// R147 starvation escape (delivery-starvation.ts) is wired only to the busy/pane_busy branch,
// never to these. Guards (a)-(d) below are everything decidable from plain data; guard (e) — a
// single-flight, fresh confirmForegroundProcess naming claude — and guard (f) — the pty
// lifecycle generation unchanged across that await, target still writable — need the runtime's
// own async primitives and stay in orca-runtime.ts's wiring, which is the only thing that grows
// there (three call sites plus this async orchestration; no max-lines bypass). Kept pure and
// file-local (no orca-runtime.ts import), same convention as delivery-starvation.ts and
// launch-prompt-fence.ts.
//
// INV-P-LAUNCH-EDGE (launch-prompt-fence.ts): guard (b) refuses while the fence holds, and
// guard (c) refuses after an evidence-less fence expiry until a Claude hook received after that
// expiry clears it — the escape can never be the first host bytes into a launching pane.
import type { DeliveryStarvationRecord } from './delivery-starvation'
import { hasCrossedBound } from './delivery-starvation'

/** The one shape this module needs off a hook-snapshot row — a subset of AgentStatusIpcPayload,
 *  so this file never imports the runtime's own status types. */
export type ClaudeHookSnapshotEntry = {
  readonly paneKey: string | null
  readonly agentType?: string
  readonly state: string
  readonly receivedAt: number | null
}

export type UnobservedStarvationEscapeGuardInput = {
  readonly now: number
  /** Guard (a): this mailbox's withheld record. */
  readonly starvation: DeliveryStarvationRecord | undefined
  readonly starvationBoundMs: number
  /** [G1 B3, INV-P-LAUNCH-EDGE] Guard (a) fix: the pty's CURRENT lifecycle generation's own
   *  start (stamped by the caller at `advancePtyLifecycleGeneration` and at pty-record creation
   *  — orca-runtime.ts). A starvation record accrued against an EARLIER generation (a main
   *  restart, or a same-id daemon respawn/cold restore) must not authorize a write into a
   *  generation that has shown no evidence of its own — the bound is measured from
   *  `max(starvation.firstAt, generationStartedAt)`, never `starvation.firstAt` alone.
   *  Undefined reads as "no known generation start" (the caller could not resolve one) — treated
   *  as 0, i.e. no additional restriction beyond `starvation.firstAt` (fail-open only for a
   *  caller defect, never for a genuinely later generation start, which is always resolvable). */
  readonly generationStartedAt: number | undefined
  /** Guard (b): the pty is connected and the launch-prompt fence does not hold. */
  readonly ptyConnected: boolean
  readonly fenceHolds: boolean
  /** Guard (c): set (by the caller) at the moment a fence expired without agent evidence;
   *  undefined once cleared, or if the fence never expired without evidence at all. */
  readonly fenceExpiredWithoutEvidenceAt: number | undefined
  readonly paneKey: string | null
  /** Guard (d) reads this same snapshot for "the newest Claude hook of any age". Guard (c)'s
   *  clearing check reads it too, filtered to entries at/after `fenceExpiredWithoutEvidenceAt`.
   *  Guard (g) reads it for "does ANY Claude hook row exist for this pane key at all". */
  readonly claudeHooks: readonly ClaudeHookSnapshotEntry[]
}

/** Guards (a)-(d) and (g): starvation bound crossed (measured from the pty's CURRENT generation,
 *  not a possibly-stale record — G1 B3); pty connected and fence not holding; no evidence-less
 *  fence expiry still outstanding; the newest Claude hook (any age) is not `waiting`/`blocked` —
 *  a pane sitting at a permission/question dialog the modal detector does not recognize must
 *  never have Enter typed into it; and at least one Claude hook row exists for the pane key at
 *  all (restored rows count — agent-hooks/server.ts keeps them 7 days) — positive prior agent
 *  evidence, so a pane this runtime has NEVER heard from (a reattached record with no hook
 *  history at all) can never be the escape's target. Does NOT check guards (e)/(f) — the fresh
 *  confirm and the post-await re-resolve are the caller's own async work. */
export function canAttemptUnobservedStarvationEscape(
  input: UnobservedStarvationEscapeGuardInput
): boolean {
  // (a)
  if (!input.starvation) {
    return false
  }
  const effectiveFirstAt = Math.max(input.starvation.firstAt, input.generationStartedAt ?? 0)
  if (
    !hasCrossedBound(
      { ...input.starvation, firstAt: effectiveFirstAt },
      input.now,
      input.starvationBoundMs
    )
  ) {
    return false
  }
  // (b)
  if (!input.ptyConnected || input.fenceHolds) {
    return false
  }
  // (c)
  if (
    input.fenceExpiredWithoutEvidenceAt !== undefined &&
    !hasClaudeHookSinceFenceExpiry(
      input.claudeHooks,
      input.paneKey,
      input.fenceExpiredWithoutEvidenceAt
    )
  ) {
    return false
  }
  // (d)
  const newestHook = newestClaudeHookForPane(input.claudeHooks, input.paneKey)
  if (newestHook && (newestHook.state === 'waiting' || newestHook.state === 'blocked')) {
    return false
  }
  // (g) [G1 B3, INV-P-LAUNCH-EDGE]
  if (!newestHook) {
    return false
  }
  return true
}

/** Guard (c)'s own clearing check, exported so the caller can clear its `expiredAt` marker as
 *  soon as qualifying evidence exists — INDEPENDENTLY of whether the overall guard set (e.g.
 *  guard (d)) ends up passing. The marker means "this pane generation never showed agent
 *  evidence"; a hook received after the expiry IS that evidence, whether or not that hook's own
 *  state also happens to block guard (d) on this same attempt. */
export function hasClaudeHookSinceFenceExpiry(
  claudeHooks: readonly ClaudeHookSnapshotEntry[],
  paneKey: string | null,
  expiredAt: number
): boolean {
  return claudeHooks.some(
    (hook) =>
      hook.paneKey === paneKey &&
      hook.agentType === 'claude' &&
      typeof hook.receivedAt === 'number' &&
      hook.receivedAt >= expiredAt
  )
}

function newestClaudeHookForPane(
  hooks: readonly ClaudeHookSnapshotEntry[],
  paneKey: string | null
): ClaudeHookSnapshotEntry | undefined {
  let newest: ClaudeHookSnapshotEntry | undefined
  for (const hook of hooks) {
    if (hook.paneKey !== paneKey || hook.agentType !== 'claude') {
      continue
    }
    if (!newest || (hook.receivedAt ?? 0) > (newest.receivedAt ?? 0)) {
      newest = hook
    }
  }
  return newest
}

/** [I-24-1 FIX-1] The escape's own footer, distinct from the R147 forced-busy path's "delivered
 *  while busy — your pane never reported idle" (formatter.ts) — this pane was never observed
 *  busy OR idle this generation at all, so that wording would misdescribe what happened. */
export const UNOBSERVED_STARVATION_ESCAPE_FOOTER = 'delivered without an observed idle edge'

/** [I-24-1 FIX-1] At most once per mailbox in this window — a second escape firing on the very
 *  next retry (5-6 min later, still well inside the window) would defeat the "at most once per
 *  10 minutes per mailbox" bound the design doc requires. Reuses DELIVERY_STARVATION_BOUND_MS
 *  (the caller passes it in) rather than a second constant. */
export function hasEscapedRecently(
  lastEscapeAt: number | undefined,
  now: number,
  boundMs: number
): boolean {
  return lastEscapeAt !== undefined && now - lastEscapeAt < boundMs
}
