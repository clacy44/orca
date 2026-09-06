// S10-21b B9/B9b (design §2.6(c), gap 21b-G1) — the terminal-settle disposition call sites: a
// specific outbox item settling refused/hold-expired/age-abandoned. Split out of
// pact-federated-repair.ts (max-lines ratchet, D-R136 B8d) — that file keeps the fence
// classification, nonce mint, and the INBOUND (no settling item) disposition
// (firePactDesyncDispositionInbound), which this module consumes via
// cancelPactTailAndPauseBody.
import type Database from '../../sqlite/sync-database'
import { writeAgentAudit } from './agent-audit-log'
import { settleReplyOutboxItem } from './reply-outbox-lifecycle'
import { PACT_HOLD_CAUSES } from './reply-outbox-pump-disposition'
import {
  auditReplyRelaySettleRaced,
  fireReplyRelayDispositionNotice,
  shouldFireDispositionNotice
} from './reply-outbox-pump-notify'
import {
  PACT_RELAY_HOLD_MAX_MS,
  PACT_RELAY_FAILED_NOTICE,
  REPLY_RELAY_ABANDONED_NOTICE
} from './link-binding-constants'
import { cancelPactTailAndPauseBody, type PactDispositionResult } from './pact-federated-repair'
import type { ReplyOutboxRow } from './reply-outbox-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'

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

export type PactTerminalSettleOutcome =
  | { outcome: 'settled'; disposition: PactDispositionResult }
  | { outcome: 'raced' }

// §2.6(c), the outbound-pump call site: a specific outbox ITEM just classified `refused`
// (design §2.6 table — every terminal pact-item cause reaches here uniformly, `pact_desync`
// included). Step 1 settles that one item (checked boolean, same guarded shape as every other
// settle on this path — a lost race applies no disposition at all); steps 2-4/6 are
// cancelPactTailAndPauseBody's job; step 7's audit fires unconditionally (never metered) — this
// is a one-shot terminal settle of a specific item, not the INBOUND fence's repeat-fire hazard
// firePactDesyncDispositionInbound (pact-federated-repair.ts) exists to bound.
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
  const pactThreadId = item.pactThreadId
  // B9c (D-R135 F9): steps 1-6 are ONE transaction — settleReplyOutboxItem is a plain prepared
  // UPDATE (no BEGIN/COMMIT of its own), so it and cancelPactTailAndPauseBody's steps now share
  // this single BEGIN IMMEDIATE; a crash/throw between them rolls BOTH back, leaving the item
  // 'sending' and the pact live rather than settled-but-unpaused.
  db.exec('BEGIN IMMEDIATE')
  try {
    const settled = settleReplyOutboxItem(db, item.id, {
      state: 'refused',
      settledAt: now,
      consecutiveFailures: item.consecutiveFailures,
      nextAttemptAfter: null,
      lastErrorCode: code,
      lastError: errorMessage
    })
    if (!settled) {
      db.exec('ROLLBACK')
      return { outcome: 'raced' }
    }

    // N4 (D-R136): guard on (era, state) exactly as the delivery settle does (settle.ts) — an
    // item queued under a stale era/state must settle ALONE, never cancel/pause the pact a
    // since-landed era reset (release, re-propose) has moved on to.
    const threadRow = db
      .prepare('SELECT pact_era, pact_state FROM threads WHERE id = ?')
      .get(pactThreadId) as { pact_era: number; pact_state: string | null } | undefined
    const stale =
      !threadRow || threadRow.pact_era !== item.pactEra || threadRow.pact_state !== item.pactState
    if (stale) {
      writeAgentAudit(db, {
        agentId: null,
        actorPaneKey: null,
        actorHostId: item.linkDeviceId,
        verb: 'pactRelay',
        outcome: 'settle_stale',
        reasonCode: JSON.stringify({ pactThreadId, outboxId: item.id, code })
      })
      db.exec('COMMIT')
      return { outcome: 'settled', disposition: { queued: false, attempts: 0, exhausted: false } }
    }

    const disposition = cancelPactTailAndPauseBody(db, pactThreadId, code)
    writeAgentAudit(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: item.linkDeviceId,
      verb: 'pactRelay',
      outcome: 'terminal_settle',
      reasonCode: JSON.stringify({ pactThreadId, outboxId: item.id, code })
    })
    db.exec('COMMIT')
    return { outcome: 'settled', disposition }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// S10-21b B9 call-site shape, shared: settle a pact item's terminal disposition (above), then
// the raced-audit/notice pair every terminal pact settle uses identically — both the
// pre-existing `refused` call site (reply-outbox-pump.ts) and B9b's own POST-DIAL hold-expired
// call site below reduce to one call each of this, no duplicated branching.
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

// B9c (D-R134 F10): the 7-day age-abandon — a pact row routes through §2.6(c)'s terminal settle
// (tail cancel + pause + queue gap_notice); mail keeps the plain settle('abandoned') shape.
// Owns the WHOLE R18.3 deadline branch (not just the pact half) so reply-outbox-pump.ts's own
// call site stays a two-line guard, keeping that file under its max-lines budget.
export function fireReplyOutboxAgeAbandon(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  item: ReplyOutboxRow,
  now: number
): void {
  if (item.relayKind !== 'reply' && item.pactThreadId !== null) {
    applyPactTerminalSettle(
      runtime,
      db,
      item,
      'pact_relay_abandoned',
      item.lastError ?? 'pact relay abandoned after the 7-day age deadline',
      now
    )
    return
  }
  // Ruling 26 Addendum 1(q)/F4: the settle's boolean is checked — a lost write (the row was
  // cancelled underneath this call) must never fire the notice.
  const settled = db.settleReplyOutboxItem(item.id, {
    state: 'abandoned',
    settledAt: now,
    consecutiveFailures: item.consecutiveFailures,
    nextAttemptAfter: null,
    lastErrorCode: item.lastErrorCode,
    lastError: item.lastError
  })
  if (settled) {
    if (shouldFireDispositionNotice(runtime, item, REPLY_RELAY_ABANDONED_NOTICE, now)) {
      fireReplyRelayDispositionNotice(runtime, item, REPLY_RELAY_ABANDONED_NOTICE, null)
    }
  } else {
    auditReplyRelaySettleRaced(db, item, 'abandoned')
  }
}
