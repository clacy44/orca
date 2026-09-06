// S10-21b B14 (design §4.6(a)) — split out of pact-lifecycle.ts (max-lines ratchet): the
// per-pact `pact_steps` cap's own auto-pause. Over cap refuses `pact_ledger_capped` AND
// auto-pauses THAT PACT ONLY (every other federated pact on the same link is unaffected, closing
// N5's cross-pact denial). `pact_pause_reason` stays 'operator' (its CHECK is frozen at six
// values); the ledger row's own `reason_code` is 'pact_ledger_capped' — the same
// declared-deviation pattern §2.6(c) step 4 already uses.
//
// OPEN (brief's own flag, unresolved by the design text): no distinct `pact_pause_reason` is
// named for this case beyond the general transport-fault 'operator' value — this is the brief's
// own recommended inference, not a quoted design instruction; flagged in RETURN for chair
// confirmation.
import type Database from '../../sqlite/sync-database'
import { auditPact, insertPactStepRow } from './pact-shared'

export function autoPauseThreadForLedgerCap(db: Database.Database, threadId: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = 'operator',
         pact_turn_in_flight_at = NULL WHERE id = ? AND pact_paused_at IS NULL`
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
      reasonCode: 'pact_ledger_capped'
    })
    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: null,
      verb: 'pact_auto_pause',
      outcome: 'paused',
      reasonCode: 'pact_ledger_capped'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
