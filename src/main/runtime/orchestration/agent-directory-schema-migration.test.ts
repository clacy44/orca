// S10-1 SCHEMA v32 -> v33 migration + provenance/audit trigger tests (M1-M4).
//
// Note on version numbers: the spec (agent-coordination-s10-1-spec.md) was written against
// `SCHEMA_VERSION 31 -> 32`. By the time this slice landed, v32 was already taken in this tree
// by an unrelated S10-0 fix (recipient_pane_key on messages). This suite therefore migrates a
// REAL, populated v32 fixture (checked in at __fixtures__/v32-orchestration.db, generated from
// this tree's actual pre-S10-1 schema code) up to v33 — the concrete version this slice ships.
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb, PEER_RUN_ID } from './db'

const FIXTURE_PATH = join(__dirname, '__fixtures__', 'v32-orchestration.db')

describe('SCHEMA v32 -> v33 migration', () => {
  let tempDir: string | undefined
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function copyFixture(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-v32-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    copyFileSync(FIXTURE_PATH, dbPath)
    return dbPath
  }

  function rawInspect(dbPath: string): Database.Database {
    return new Database(dbPath)
  }

  it('the checked-in fixture really is a populated, unmigrated v32 database', () => {
    const dbPath = copyFixture()
    const raw = rawInspect(dbPath)
    expect(raw.pragma('user_version', { simple: true })).toBe(32)
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
    )
    expect(tables.has('agents')).toBe(false)
    expect(tables.has('mailbox_deliveries')).toBe(false)
    const messageCount = raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(messageCount.n).toBeGreaterThan(0)
    raw.close()
  })

  it('M1: migration is idempotent — opening twice is a no-op the second time', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    // Reopen: createTables()+migrate() run again against an already-migrated database.
    // Why 34, not 33: S10-2a bumped SCHEMA_VERSION past this suite's original v33 — every
    // fixture DB this suite opens now migrates one version further than when this assertion
    // was written (thread-directory-schema-migration.test.ts owns the v33->v34 step itself).
    expect(() => {
      orchestrationDb = new OrchestrationDb(dbPath)
    }).not.toThrow()
    const raw = rawInspect(dbPath)
    expect(raw.pragma('user_version', { simple: true })).toBe(34)
    const agentRows = raw.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }
    expect(agentRows.n).toBe(0) // no duplicate seed rows, no spurious inserts
    raw.close()
  })

  it('M1b: schema tables/indexes/triggers/seed are present after migration', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    orchestrationDb = undefined
    const raw = rawInspect(dbPath)
    const names = (kind: string): Set<string> =>
      new Set(
        (
          raw.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(kind) as {
            name: string
          }[]
        ).map((r) => r.name)
      )
    const tables = names('table')
    for (const table of ['agents', 'mailbox_deliveries', 'agent_audit', 'agent_rate']) {
      expect(tables.has(table)).toBe(true)
    }
    const indexes = names('index')
    for (const index of [
      'idx_agents_name',
      'idx_agents_pane_suffix',
      'idx_agents_state',
      'idx_mailbox_deliveries_one_outstanding'
    ]) {
      expect(indexes.has(index)).toBe(true)
    }
    const triggers = names('trigger')
    for (const trigger of [
      'trg_agents_origin_immutable',
      'trg_agent_audit_no_update',
      'trg_agent_audit_no_delete'
    ]) {
      expect(triggers.has(trigger)).toBe(true)
    }
    const sentinel = raw.prepare('SELECT id, legacy FROM runs WHERE id = ?').get(PEER_RUN_ID) as
      | { id: string; legacy: number }
      | undefined
    expect(sentinel?.id).toBe(PEER_RUN_ID)
    expect(sentinel?.legacy).toBe(0)
    const messageCols = raw.pragma('table_info(messages)') as { name: string }[]
    expect(messageCols.some((c) => c.name === 'sender_agent_id')).toBe(true)
    raw.close()
  })

  it('M2: a mid-migration throw leaves user_version unchanged and applies neither migrate()-only mutation (all-or-nothing txn)', () => {
    // createTables() runs unconditionally and non-transactionally before migrate() ever starts
    // (matching this file's existing pattern for every other table: `deliveries`,
    // `question_threads`, etc. are also duplicated in both places), so the agents/
    // mailbox_deliveries CREATE TABLE IF NOT EXISTS statements already succeed by the time
    // migrate() runs and cannot be used to probe migrate()'s OWN transactional boundary. What
    // is unique to `current < 33` — never duplicated in createTables() — is the
    // `ALTER TABLE messages ADD COLUMN sender_agent_id` and the `run_peer_local` sentinel
    // INSERT. Forcing the sentinel INSERT to fail (via a trigger the fixture's `runs` table did
    // not originally have — existing rows are untouched, only a NEW legacy=0 insert of this
    // specific id is blocked) isolates a genuine failure inside migrate()'s `BEGIN IMMEDIATE`
    // txn, after the ALTER has already run earlier in the SAME transaction — proving the ALTER
    // is rolled back too, not just the pragma write. `INSERT OR IGNORE` (used by the sentinel
    // insert) suppresses constraint conflicts but not a trigger's RAISE(ABORT), so this reaches
    // the same code path a real failure (e.g. disk full, a corrupt `runs` row) would take.
    const dbPath = copyFixture()
    const raw = rawInspect(dbPath)
    raw.exec(`
      CREATE TRIGGER block_new_peer_sentinel_for_test
      BEFORE INSERT ON runs
      WHEN NEW.legacy = 0 AND NEW.id = '${PEER_RUN_ID}'
      BEGIN SELECT RAISE(ABORT, 'M2 fixture: forced failure for the sentinel insert'); END;
    `)
    raw.close()
    expect(() => {
      orchestrationDb = new OrchestrationDb(dbPath)
    }).toThrow()
    orchestrationDb = undefined
    const after = rawInspect(dbPath)
    expect(after.pragma('user_version', { simple: true })).toBe(32)
    const sentinel = after.prepare('SELECT id FROM runs WHERE id = ?').get(PEER_RUN_ID)
    expect(sentinel).toBeUndefined()
    const messageCols = (after.pragma('table_info(messages)') as { name: string }[]).map(
      (c) => c.name
    )
    expect(messageCols).not.toContain('sender_agent_id')
    after.close()
  })

  it('M3: messages keeps its row count, sequence values, and column order plus one new column', () => {
    const dbPath = copyFixture()
    const before = rawInspect(dbPath)
    const beforeRows = before
      .prepare('SELECT sequence, id, subject FROM messages ORDER BY sequence')
      .all()
    const beforeCols = (before.pragma('table_info(messages)') as { name: string }[]).map(
      (c) => c.name
    )
    before.close()

    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    orchestrationDb = undefined

    const after = rawInspect(dbPath)
    const afterRows = after
      .prepare('SELECT sequence, id, subject FROM messages ORDER BY sequence')
      .all()
    const afterCols = (after.pragma('table_info(messages)') as { name: string }[]).map(
      (c) => c.name
    )
    after.close()

    expect(afterRows).toEqual(beforeRows)
    expect(afterCols.slice(0, beforeCols.length)).toEqual(beforeCols)
    expect(afterCols).toContain('sender_agent_id')
  })

  it('M4: direct SQL cannot rewrite agent provenance or touch agent_audit (trigger-enforced)', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    const db = (orchestrationDb as unknown as { db: Database.Database }).db
    db.prepare(
      `INSERT INTO agents (
         id, display_name, host_id, pane_key, origin_kind, origin_pane_key, origin_host_id
       ) VALUES ('agt_fixture', 'fixture-agent-abcd', 'local', 'tab1:leaf1', 'pane', 'tab1:leaf1', 'local')`
    ).run()

    expect(() =>
      db.exec("UPDATE agents SET origin_pane_key = 'x' WHERE id = 'agt_fixture'")
    ).toThrow()
    expect(() =>
      db.exec("UPDATE agents SET registered_at = '2020-01-01 00:00:00' WHERE id = 'agt_fixture'")
    ).toThrow()
    // A benign update (not touching provenance columns) must still succeed.
    expect(() => db.exec("UPDATE agents SET role = 'ok' WHERE id = 'agt_fixture'")).not.toThrow()

    db.prepare(
      `INSERT INTO agent_audit (agent_id, verb, outcome) VALUES ('agt_fixture', 'register', 'created')`
    ).run()
    expect(() => db.exec("UPDATE agent_audit SET outcome = 'tampered'")).toThrow()
    expect(() => db.exec('DELETE FROM agent_audit')).toThrow()
  })

  // Mutation proof: if the provenance trigger's WHEN clause were narrowed (e.g. dropped the
  // origin_at/registered_at columns from the comparison), a caller could rewrite when an agent
  // was first seen — undermining the audit trail CONTAINMENT #9 promises.
  it('MUTATION PROOF: origin_at and registered_at are covered by the immutability trigger', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    const db = (orchestrationDb as unknown as { db: Database.Database }).db
    db.prepare(
      `INSERT INTO agents (
         id, display_name, host_id, pane_key, origin_kind, origin_pane_key, origin_host_id
       ) VALUES ('agt_fixture2', 'fixture-agent-efgh', 'local', 'tab1:leaf2', 'pane', 'tab1:leaf2', 'local')`
    ).run()
    expect(() =>
      db.exec("UPDATE agents SET origin_at = '2020-01-01 00:00:00' WHERE id = 'agt_fixture2'")
    ).toThrow()
    expect(() =>
      db.exec("UPDATE agents SET registered_at = '2020-01-01 00:00:00' WHERE id = 'agt_fixture2'")
    ).toThrow()
  })
})
