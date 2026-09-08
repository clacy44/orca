// S10-21c B-final F8 (D-R159 finding 8): agent_audit had NO index despite being append-only and
// ever-growing, and two new per-hook-event lookups now join raiseMismatchAlarm's own scan — split
// out of db.test.ts (near the 800-line test cap) per _common-rules.md's "split modules if needed
// and say so".
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('agent_audit', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('creates idx_agent_audit_pane_verb on open', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const indexes = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_audit' AND name = 'idx_agent_audit_pane_verb'`
      )
      .all()
    expect(indexes).toHaveLength(1)
  })
})
