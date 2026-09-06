// S10-21b B9 (design §2.5/§2.6(c)/§2.9, Ruling 34 Addendum 6(2)/6(11), errata NA6/NB4) — the
// strict fence's gap/desync outcomes, the fresh-nonce-gated `resync_request` mint, and the
// terminal-settle disposition (cancel tail + pause + queue `gap_notice` + bounded repair
// counter). `resync`/`resync_request`'s own APPLY functions live in
// pact-federated-resync-apply.ts (max-lines split). `pact_ordinal` is never touched here
// (INV-P-021) — this file only ever writes pact_peer_seq/pact_paused_at/pact_relay_pending/
// pact_repair_attempts/pact_resync_nonce(+_at)/pact_turn_in_flight_at.
import { randomBytes } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { writeAgentAudit } from './agent-audit-log'
import { checkAndBumpRate } from './agent-rate-limit'
import { settleReplyOutboxItem } from './reply-outbox-lifecycle'
import { enqueueFederatedPactVerb } from './pact-federated-emit'
import { insertPactStepRow, requireThread } from './pact-shared'
import { PACT_HOLD_CAUSES } from './reply-outbox-pump-disposition'
import {
  auditReplyRelaySettleRaced,
  fireReplyRelayDispositionNotice,
  shouldFireDispositionNotice
} from './reply-outbox-pump-notify'
import {
  LINK_BINDING_RATE_WINDOW_MS,
  PACT_RELAY_HOLD_MAX_MS,
  PACT_RELAY_FAILED_NOTICE
} from './link-binding-constants'
import type { ReplyOutboxRow } from './reply-outbox-types'
import type { ThreadRow } from './thread-directory-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'

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

// §2.5's fresh-nonce gate (NA6), shared by the fence's own gap row and by a `gap_notice` whose
// seq is itself gap-shaped (gap_notice gets NO special case in the fence — this is the only
// call site). A live, unexpired nonce OR an already-queued, undrained `gap_notice` (the OTHER
// fresh-mint mechanism sharing the same counter, §2.6(c) step 6) suppresses the re-mint
// entirely: no re-queue, no attempts bump. Returns whether a fresh nonce was actually minted
// this call. `pact_repair_attempts` bumps on this mint exactly as it does on cancelPactTailAndPause's
// own fresh queue below — one shared counter, two minting mechanisms (§2.1's field table).
export function mintResyncRequestIfNeeded(db: Database.Database, threadId: string): boolean {
  const now = Date.now()
  const thread = requireThread(db, threadId)
  if (isResyncNonceLive(thread, now) || thread.pact_relay_pending === 'gap_notice') {
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

// S10-21b B9b (design v3.1:560-570/684-700, §2.6(c), gap 21b-G1): true once a pact item's retry
// (one of the four PACT_HOLD_CAUSES) has been held past PACT_RELAY_HOLD_MAX_MS, read from
// first_held_at ONLY. Not in reply-outbox-pump-disposition.ts, which stays a pure classifier.
function isPactHoldExpired(item: ReplyOutboxRow, disposition: string, now: number): boolean {
  return (
    item.relayKind !== 'reply' &&
    item.pactThreadId !== null &&
    PACT_HOLD_CAUSES.has(disposition) &&
    item.firstHeldAt !== null &&
    now - item.firstHeldAt > PACT_RELAY_HOLD_MAX_MS
  )
}

// S10-21b B9 call-site shape, shared: settle a pact item's terminal disposition (B9's own
// machinery), then the raced-audit/notice pair every terminal pact settle uses identically —
// both the pre-existing `refused` call site (reply-outbox-pump.ts) and B9b's new POST-DIAL
// hold-expired call site below reduce to one call each of this, no duplicated branching.
export function applyPactTerminalSettle(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  item: ReplyOutboxRow,
  code: string,
  errorMessage: string,
  now: number
): void {
  const result = db.firePactTerminalSettleDisposition(item, code, errorMessage, now)
  if (result.outcome === 'raced') {
    auditReplyRelaySettleRaced(db, item, 'refused')
  } else if (shouldFireDispositionNotice(runtime, item, PACT_RELAY_FAILED_NOTICE, now)) {
    fireReplyRelayDispositionNotice(runtime, item, PACT_RELAY_FAILED_NOTICE, null)
  }
}

// S10-21b B9b (gap 21b-G1): the pump's POST-DIAL call site — when isPactHoldExpired, fires B9's
// terminal settle with the hold cause as the terminal code and reason 'pact_hold_expired' (chair
// default: §2.6(c) names no code for an expired hold). Returns whether it fired, so the pump's
// retry branch knows to return without ever calling retryReplyOutboxItem for this item.
export function firePactHoldExpiredDisposition(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  item: ReplyOutboxRow,
  disposition: string,
  now: number
): boolean {
  if (!isPactHoldExpired(item, disposition, now)) {
    return false
  }
  applyPactTerminalSettle(runtime, db, item, disposition, 'pact_hold_expired', now)
  return true
}

export type PactDispositionResult = { queued: boolean; attempts: number; exhausted: boolean }

// §2.6(c) steps 2/3/4/6 — the parts of the terminal-settle transaction that apply regardless of
// WHICH terminal code triggered it and regardless of whether a specific outbox item is settling
// alongside it (step 1's item-settle and step 7's notice/audit are each caller's own concern —
// see firePactDesyncDispositionInbound/firePactTerminalSettleDisposition below). Idempotent: a
// pact that is already paused gets the same pact_paused_at/pact_pause_reason written again — a
// no-op in effect, per §2.9's "the disposition itself is never suppressed" instruction.
export function cancelPactTailAndPause(
  db: Database.Database,
  threadId: string,
  terminalCode: string
): PactDispositionResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    // Step 2: cancel this PACT's own unsettled tail — every other queued/sending relay item on
    // the same pact is now suspect, not merely the one item (if any) that just settled.
    db.prepare(
      `UPDATE peer_reply_outbox SET state = 'cancelled', last_error_code = 'pact_tail_cancelled'
         WHERE pact_thread_id = ? AND state IN ('queued', 'sending')`
    ).run(threadId)

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
      db.exec('COMMIT')
      return { queued: false, attempts: 0, exhausted: false }
    }

    const thread = requireThread(db, threadId)
    // Fresh-nonce gate, both directions: a live, undrained `gap_notice` OR a live
    // pact_resync_nonce (the OTHER minting mechanism, mintResyncRequestIfNeeded above) suppresses
    // re-queue AND the attempts bump (§2.5/§2.6(c) step 6 — one shared counter).
    if (thread.pact_relay_pending === 'gap_notice' || isResyncNonceLive(thread, Date.now())) {
      db.exec('COMMIT')
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
      db.exec('COMMIT')
      return { queued: false, attempts: nextAttempts, exhausted: true }
    }
    // Step 5 — the emitter-push `gap_notice` (Addendum 6(11)/(15), REPLACES v3's receiver-pull
    // `resync_request`). This carries `seq = pact_local_seq + 1` and no state at the moment the
    // pump actually relays it — nothing further to compute or store here.
    db.prepare(
      `UPDATE threads SET pact_relay_pending = 'gap_notice', pact_repair_attempts = ? WHERE id = ?`
    ).run(nextAttempts, threadId)
    db.exec('COMMIT')
    return { queued: true, attempts: nextAttempts, exhausted: false }
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

export type PactTerminalSettleOutcome =
  | { outcome: 'settled'; disposition: PactDispositionResult }
  | { outcome: 'raced' }

// §2.6(c), the outbound-pump call site: a specific outbox ITEM just classified `refused`
// (design §2.6 table — every terminal pact-item cause reaches here uniformly, `pact_desync`
// included). Step 1 settles that one item (checked boolean, same guarded shape as every other
// settle on this path — a lost race applies no disposition at all); steps 2-4/6 are
// cancelPactTailAndPause's job; step 7's audit fires unconditionally (never metered) — this is a
// one-shot terminal settle of a specific item, not the INBOUND fence's repeat-fire hazard that
// firePactDesyncDispositionInbound above exists to bound.
export function firePactTerminalSettleDisposition(
  db: Database.Database,
  item: ReplyOutboxRow,
  code: string,
  errorMessage: string,
  now: number
): PactTerminalSettleOutcome {
  if (item.pactThreadId === null) {
    throw new Error(
      `internal error: firePactTerminalSettleDisposition called for non-pact outbox item ${item.id}`
    )
  }
  const settled = settleReplyOutboxItem(db, item.id, {
    state: 'refused',
    settledAt: now,
    consecutiveFailures: item.consecutiveFailures,
    nextAttemptAfter: null,
    lastErrorCode: code,
    lastError: errorMessage
  })
  if (!settled) {
    return { outcome: 'raced' }
  }
  const disposition = cancelPactTailAndPause(db, item.pactThreadId, code)
  writeAgentAudit(db, {
    agentId: null,
    actorPaneKey: null,
    actorHostId: item.linkDeviceId,
    verb: 'pactRelay',
    outcome: 'terminal_settle',
    reasonCode: JSON.stringify({ pactThreadId: item.pactThreadId, outboxId: item.id, code })
  })
  return { outcome: 'settled', disposition }
}
