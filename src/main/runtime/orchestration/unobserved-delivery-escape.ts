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
  /** Guard (b): the pty is connected and the launch-prompt fence does not hold. */
  readonly ptyConnected: boolean
  readonly fenceHolds: boolean
  /** Guard (c): set (by the caller) at the moment a fence expired without agent evidence;
   *  undefined once cleared, or if the fence never expired without evidence at all. */
  readonly fenceExpiredWithoutEvidenceAt: number | undefined
  readonly paneKey: string | null
  /** Guard (d) reads this same snapshot for "the newest Claude hook of any age". Guard (c)'s
   *  clearing check reads it too, filtered to entries at/after `fenceExpiredWithoutEvidenceAt`. */
  readonly claudeHooks: readonly ClaudeHookSnapshotEntry[]
}

/** Guards (a)-(d): starvation bound crossed; pty connected and fence not holding; no
 *  evidence-less fence expiry still outstanding; and the newest Claude hook (any age) is not
 *  `waiting`/`blocked` — a pane sitting at a permission/question dialog the modal detector does
 *  not recognize must never have Enter typed into it. Does NOT check guards (e)/(f) — the fresh
 *  confirm and the post-await re-resolve are the caller's own async work. */
export function canAttemptUnobservedStarvationEscape(
  input: UnobservedStarvationEscapeGuardInput
): boolean {
  // (a)
  if (!input.starvation || !hasCrossedBound(input.starvation, input.now, input.starvationBoundMs)) {
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
