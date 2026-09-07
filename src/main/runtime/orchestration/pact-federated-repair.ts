// S10-21b B9 (design §2.5/§2.6(c)/§2.9, Ruling 34 Addendum 6(2)/6(11), errata NA6/NB4) — the
// strict fence's gap/desync outcomes and the fresh-nonce-gated `resync_request` mint.
// `resync`/`resync_request`'s own APPLY functions live in pact-federated-resync-apply.ts
// (max-lines split); the terminal-settle disposition call sites (a settling outbox item) live in
// pact-federated-terminal-settle.ts (D-R136 B8d split) — this file keeps the shared
// cancelPactTailAndPauseBody/cancelPactTailAndPause (exported for that module) and the INBOUND
// (no settling item) disposition, firePactDesyncDispositionInbound. `pact_ordinal` is never
// touched here (INV-P-021) — this file only ever writes pact_peer_seq/pact_paused_at/
// pact_relay_pending/pact_repair_attempts/pact_resync_nonce(+_at)/pact_turn_in_flight_at.
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { writeAgentAudit } from './agent-audit-log'
import { checkAndBumpRate } from './agent-rate-limit'
import { enqueueFederatedPactVerb, PACT_VERB_RELAY_KIND } from './pact-federated-emit'
import { insertPactStepRow, requireThread } from './pact-shared'
import { LINK_BINDING_RATE_WINDOW_MS, PACT_RELAY_HOLD_MAX_MS } from './link-binding-constants'
import type { ThreadRow } from './thread-directory-types'

// §2.5's fence table — the oversize-gap boundary.
export const PACT_MAX_GAP = 64

// errata 6(16), NB4 — imports B5's constant rather than a fresh literal, per the brief.
export const PACT_RESYNC_NONCE_TTL_MS = PACT_RELAY_HOLD_MAX_MS

// §2.6(c) step 6's bound (Addendum 6(5)).
const PACT_REPAIR_ATTEMPTS_CAP = 3

// §2.5's fence table. The "exact successor" apply row is the caller's own concern (gate 14's
// happy path, unchanged from B8) — this classifies only the remaining two: gate 8
// (runPactDedupeGate) has already ruled the messageId "fresh" (not found anywhere in the
// ledger) before a caller ever reaches here, so `seq <= pact_peer_seq` at this point is exactly
// §2.5's "duplicate-shaped but unproven" desync row, never the genuine-duplicate row (which gate
// 8 already returned a stored receipt for, upstream of the fence entirely).
export type PactFenceOutcome = { kind: 'apply' } | { kind: 'gap' } | { kind: 'desync' }

export function resolvePactFenceOutcome(thread: ThreadRow, seq: number): PactFenceOutcome {
  if (seq === thread.pact_peer_seq + 1) {
    return { kind: 'apply' }
  }
  if (seq <= thread.pact_peer_seq) {
    return { kind: 'desync' }
  }
  const gap = seq - thread.pact_peer_seq - 1
  return gap <= PACT_MAX_GAP ? { kind: 'gap' } : { kind: 'desync' }
}

// errata 6(16), NB4: "live" = not-NULL and within PACT_RESYNC_NONCE_TTL_MS of
// pact_resync_nonce_at. An EXPIRED nonce is treated as absent everywhere below.
export function isResyncNonceLive(thread: ThreadRow, nowMs: number): boolean {
  return (
    thread.pact_resync_nonce !== null &&
    thread.pact_resync_nonce_at !== null &&
    nowMs - thread.pact_resync_nonce_at < PACT_RESYNC_NONCE_TTL_MS
  )
}

// errata 21b-E5 (chair ruling, no TTL/column): the gap_notice token is transient — drained (and
// cleared) by the next pump tick, so between drain and the row settling there is a window with
// no token but a live in-flight gap_notice. Suppression therefore also checks for an unsettled
// ('queued'/'sending') peer_reply_outbox row of that kind; it lifts only once that row settles
// (delivered or terminal), no clock involved.
function hasUnsettledGapNoticeOutbox(db: Database.Database, threadId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM peer_reply_outbox
        WHERE pact_thread_id = ? AND relay_kind = 'pact_gap_notice' AND state IN ('queued', 'sending')
        LIMIT 1`
    )
    .get(threadId)
  return row !== undefined
}

// §2.5's fresh-nonce gate (NA6), shared by the fence's own gap row and by a `gap_notice` whose
// seq is itself gap-shaped (gap_notice gets NO special case in the fence — this is the only
// call site). A live, unexpired nonce OR an already-queued, undrained `gap_notice` token OR an
// unsettled `gap_notice` outbox row (errata 21b-E5, the OTHER fresh-mint mechanism sharing the
// same counter, §2.6(c) step 6) suppresses the re-mint entirely: no re-queue, no attempts bump.
// Returns whether a fresh nonce was actually minted this call. `pact_repair_attempts` bumps on
// this mint exactly as it does on cancelPactTailAndPause's own fresh queue below — one shared
// counter, two minting mechanisms (§2.1's field table).
export function mintResyncRequestIfNeeded(db: Database.Database, threadId: string): boolean {
  const now = Date.now()
  const thread = requireThread(db, threadId)
  if (
    isResyncNonceLive(thread, now) ||
    thread.pact_relay_pending === 'gap_notice' ||
    hasUnsettledGapNoticeOutbox(db, threadId)
  ) {
    return false
  }
  const nonce = randomBytes(16).toString('hex')
  db.prepare(
    `UPDATE threads SET pact_resync_nonce = ?, pact_resync_nonce_at = ?,
       pact_repair_attempts = pact_repair_attempts + 1 WHERE id = ?`
  ).run(nonce, now, threadId)
  enqueueFederatedPactVerb(db, null, threadId, 'resync_request', {
    actorAgentId: null,
    actorPaneKey: null,
    actorHostId: null,
    runId: 'host',
    resyncRequest: { nonce }
  })
  return true
}

export type PactDispositionResult = { queued: boolean; attempts: number; exhausted: boolean }

// §2.6(c) steps 2/3/4/6 — the parts of the terminal-settle transaction that apply regardless of
// WHICH terminal code triggered it and regardless of whether a specific outbox item is settling
// alongside it (step 1's item-settle and step 7's notice/audit are each caller's own concern —
// see firePactDesyncDispositionInbound below and pact-federated-terminal-settle.ts's
// firePactTerminalSettleDisposition). Idempotent: a pact that is already paused gets the same
// pact_paused_at/pact_pause_reason written again — a no-op in effect, per §2.9's "the
// disposition itself is never suppressed" instruction.
// B9c (D-R135 F9): the BODY only — no BEGIN/COMMIT/ROLLBACK of its own, so a caller that already
// holds an open transaction (firePactTerminalSettleDisposition, pact-federated-terminal-
// settle.ts) can include these steps in its OWN transaction instead of committing them
// separately (SQLite has no nested transactions). Exceptions propagate to the caller's rollback.
// Exported for pact-federated-terminal-settle.ts (D-R136 B8d split) — its
// firePactTerminalSettleDisposition shares this SAME body inside its own transaction.
// D-R138 F4 (S10-21b B18): the tail-cancel alone, factored out of step 2 below so a fresh era
// (proposePact's own reset, and applyPropose's inbound era-adoption reset) can cancel a pact's
// stale unsettled outbox rows too — a fresh era must never carry a relay item minted under the
// era it replaced (the exact class of defect the cross-propose race's loser hit: its pre-race
// propose/decline rows survived the era reset and retried against the peer's now-live pact).
//
// FORCED DEVIATION (disclosed, not in the brief): `includeSending` defaults to true (unchanged
// scope) for `cancelPactTailAndPauseBody`'s own caller, below — a genuine desync/terminal
// disposition makes every in-flight item on the pact suspect, claimed or not. The era-reset call
// sites (proposePact, applyPropose) pass `includeSending: false` — cancelling an ALREADY-CLAIMED
// ('sending') item there regresses D-R136 N4's own tested contract (pact-federated-
// repair.test.ts, "a relay queued under a released era does not cancel/pause the freshly
// re-proposed pact"): a prior-era item already claimed by the pump settles safely through
// `firePactTerminalSettleDisposition`'s own era/state guard and must be left alone. F4's actual
// defect (the race loser's pre-race `propose`/`decline` rows) are always still `queued` at this
// point — nothing has claimed them — so this narrowing still closes F4 in full.
// D-R139 N2: the era-reset call sites' scope, closed over the BODY verbs of the replaced era —
// NEVER `pact_release`/`pact_gap_notice`/`pact_resync*`, which the peer still needs delivered
// regardless of a local re-propose. Cancelling a queued `pact_release` here strands the peer's
// thread `engaged`, and its retried propose then collides on `pact_exists`.
export const PACT_ERA_RESET_CANCELLABLE_RELAY_KINDS: readonly string[] = [
  PACT_VERB_RELAY_KIND.propose,
  PACT_VERB_RELAY_KIND.accept,
  PACT_VERB_RELAY_KIND.decline,
  PACT_VERB_RELAY_KIND.step,
  PACT_VERB_RELAY_KIND.pause,
  PACT_VERB_RELAY_KIND.resume,
  PACT_VERB_RELAY_KIND.rebind_party
]

export function cancelUnsettledPactOutboxTail(
  db: Database.Database,
  threadId: string,
  options?: { includeSending?: boolean; relayKinds?: readonly string[] }
): void {
  const states = options?.includeSending === false ? ['queued'] : ['queued', 'sending']
  const kindScope = options?.relayKinds
  const kindClause = kindScope ? ` AND relay_kind IN (${kindScope.map(() => '?').join(', ')})` : ''
  db.prepare(
    `UPDATE peer_reply_outbox SET state = 'cancelled', last_error_code = 'pact_tail_cancelled'
       WHERE pact_thread_id = ? AND state IN (${states.map(() => '?').join(', ')})${kindClause}`
  ).run(threadId, ...states, ...(kindScope ?? []))
}

export function cancelPactTailAndPauseBody(
  db: Database.Database,
  threadId: string,
  terminalCode: string
): PactDispositionResult {
  // Step 2: cancel this PACT's own unsettled tail — every other queued/sending relay item on
  // the same pact is now suspect, not merely the one item (if any) that just settled.
  cancelUnsettledPactOutboxTail(db, threadId)

  // Step 3.
  db.prepare(`UPDATE threads SET pact_turn_in_flight_at = NULL WHERE id = ?`).run(threadId)

  // Step 4 — pause + a host `pause` ledger row. `pact_pause_reason` stays 'operator' (its CHECK
  // is frozen at six values, NB1); the precise cause is the ledger row's `reason_code`, exactly
  // §2.1's declared-deviation pattern.
  db.prepare(
    `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = 'operator' WHERE id = ?`
  ).run(threadId)
  insertPactStepRow(db, {
    threadId,
    ordinal: 0,
    kind: 'pause',
    actorAgentId: null,
    actorPaneKey: null,
    actorHostId: null,
    messageId: null,
    summary: null,
    turnAfterAgentId: null,
    reasonCode: terminalCode
  })

  // Step 6's no-repair-loop carve-out (Addendum 6(5)): nothing queued for these two codes,
  // ever; the counter is left untouched.
  if (terminalCode === 'pact_no_pact' || terminalCode === 'pact_era_mismatch') {
    return { queued: false, attempts: 0, exhausted: false }
  }

  const thread = requireThread(db, threadId)
  // Fresh-nonce gate, both directions: a live, undrained `gap_notice` token, an unsettled
  // `gap_notice` outbox row (errata 21b-E5), OR a live pact_resync_nonce (the OTHER minting
  // mechanism, mintResyncRequestIfNeeded above) suppresses re-queue AND the attempts bump
  // (§2.5/§2.6(c) step 6 — one shared counter).
  if (
    thread.pact_relay_pending === 'gap_notice' ||
    hasUnsettledGapNoticeOutbox(db, threadId) ||
    isResyncNonceLive(thread, Date.now())
  ) {
    return { queued: false, attempts: thread.pact_repair_attempts, exhausted: false }
  }
  const nextAttempts = thread.pact_repair_attempts + 1
  if (nextAttempts > PACT_REPAIR_ATTEMPTS_CAP) {
    // Budget exhausted: step 5's queue is skipped even for an otherwise-repairable code; the
    // counter still records the exhausted attempt so the notice can name it.
    db.prepare(`UPDATE threads SET pact_repair_attempts = ? WHERE id = ?`).run(
      nextAttempts,
      threadId
    )
    return { queued: false, attempts: nextAttempts, exhausted: true }
  }
  // Step 5 — the emitter-push `gap_notice` (Addendum 6(11)/(15), REPLACES v3's receiver-pull
  // `resync_request`). This carries `seq = pact_local_seq + 1` and no state at the moment the
  // pump actually relays it — nothing further to compute or store here.
  db.prepare(
    `UPDATE threads SET pact_relay_pending = 'gap_notice', pact_repair_attempts = ? WHERE id = ?`
  ).run(nextAttempts, threadId)
  return { queued: true, attempts: nextAttempts, exhausted: false }
}

export function cancelPactTailAndPause(
  db: Database.Database,
  threadId: string,
  terminalCode: string
): PactDispositionResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = cancelPactTailAndPauseBody(db, threadId, terminalCode)
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// §2.9 [v3.1, Addendum 6(15)]: mirrors pact-relay-audit-meter.ts's shouldEmitPactDesyncAudit
// exactly (same subjectKey/verb key derivation, same 60s window), but against a raw
// `Database.Database` — this call site (the INBOUND fence) runs before any `OrchestrationDb`
// wrapper is in scope (pact-federated-inbound-apply.ts operates on the raw handle throughout).
function shouldEmitPactDesyncAuditRaw(
  db: Database.Database,
  linkDeviceId: string,
  pactThreadId: string
): boolean {
  const gate = checkAndBumpRate(db, {
    subjectKey: `pactRelay:${linkDeviceId}:${pactThreadId}`,
    verb: `pactRelayAudit:pact_desync`,
    windowMs: LINK_BINDING_RATE_WINDOW_MS,
    limit: 1
  })
  return gate.allowed
}

// §2.5's fence table, `pact_desync` rows — called directly from the INBOUND apply path (no
// settling outbox item involved). The disposition (pause + tail-cancel + repair bookkeeping)
// fires on EVERY occurrence; only the audit row is metered, so a peer spamming desync-shaped
// verbs at one already-desynced pact cannot use the audit trail to hide repetition, and cannot
// use repetition to flood it either (closes NA8 without reopening N2).
export function firePactDesyncDispositionInbound(
  db: Database.Database,
  threadId: string,
  linkDeviceId: string
): PactDispositionResult {
  const result = cancelPactTailAndPause(db, threadId, 'pact_desync')
  if (shouldEmitPactDesyncAuditRaw(db, linkDeviceId, threadId)) {
    writeAgentAudit(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: linkDeviceId,
      verb: 'pactRelay',
      outcome: 'pact_desync',
      reasonCode: JSON.stringify({ pactThreadId: threadId })
    })
  }
  return result
}
