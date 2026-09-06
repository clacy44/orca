// S10-21b B1 (design §6, Ruling 34 Addendum 2/6/6(16)): SCHEMA v41 -> v42 migration (T24).
// Synthetic fixture (v2's T21 approach, updated column/index counts): a real store is built at
// current code (v42), then downgraded via raw DROP COLUMN/TABLE/TRIGGER/INDEX + a rewound
// user_version to fabricate a genuine v41 fixture, matching this repo's existing precedent
// (agent-launch-sessions-migration.test.ts, pact-propose-accept.test.ts's blocker-regression
// test) rather than a hand-maintained binary fixture.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  OrchestrationDb,
  PACT_STEPS_APPEND_ONLY_TRIGGER_SQL,
  PACT_STEPS_NO_DELETE_TRIGGER_SQL
} from './db'

const THREADS_V42_COLUMNS = [
  'pact_peer_key_fingerprint',
  'pact_peer_agent_id',
  'pact_peer_link_device_id',
  'pact_peer_environment_id',
  'pact_peer_thread_id',
  'pact_turn_in_flight_at',
  'pact_peer_paused_at',
  'pact_release_at',
  'pact_peer_release_at',
  'pact_last_inbound_at',
  'pact_last_resync_at',
  'pact_relay_pending',
  'pact_local_seq',
  'pact_peer_seq',
  'pact_flight_token',
  'pact_resync_nonce',
  'pact_resync_nonce_at',
  'pact_repair_attempts',
  'pact_pause_epoch'
]
const PACT_STEPS_V42_COLUMNS = [
  'actor_is_remote',
  'actor_remote_agent_id',
  'actor_environment_id',
  'relay_seq',
  'relay_state',
  'relay_settled_at'
]
const REMOTE_AGENTS_V42_COLUMNS = ['superseded_at', 'succeeded_by_remote_agent_id']
const PEER_REPLY_OUTBOX_V42_COLUMNS = [
  'relay_kind',
  'pact_thread_id',
  'pact_seq',
  'pact_era',
  'pact_turn_after',
  'pact_state',
  'pact_flight_token'
]

// 19 + 6 + 2 + 7 = 34.
expect(
  THREADS_V42_COLUMNS.length +
    PACT_STEPS_V42_COLUMNS.length +
    REMOTE_AGENTS_V42_COLUMNS.length +
    PEER_REPLY_OUTBOX_V42_COLUMNS.length
).toBe(34)

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).some(
    (c) => c.name === column
  )
}

function hasTable(sqlite: Database.Database, table: string): boolean {
  return (
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  )
}

function hasTrigger(sqlite: Database.Database, trigger: string): boolean {
  return (
    sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
      .get(trigger) !== undefined
  )
}

function hasIndex(sqlite: Database.Database, index: string): boolean {
  return (
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index) !==
    undefined
  )
}

function rowCount(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

function preexistingTableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           AND name != 'pact_applied_ids'`
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
}

// Fabricates a genuine v41 fixture from a real v42 store: drops every v42 addition and rewinds
// user_version, so the reopen below exercises the actual `current < 42` migrate() block rather
// than a hand-typed approximation of it.
function downgradeToV41(sqlite: Database.Database): void {
  // Drop the v42 indexes and triggers FIRST — SQLite refuses to DROP COLUMN a column that is
  // still referenced by an index or a trigger.
  sqlite.exec(`DROP INDEX IF EXISTS idx_threads_pact_peer`)
  sqlite.exec(`DROP INDEX IF EXISTS idx_peer_reply_outbox_pact`)
  sqlite.exec(`DROP INDEX IF EXISTS idx_pact_steps_remote`)
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_pact_steps_no_delete`)
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_pact_steps_append_only`)

  for (const column of THREADS_V42_COLUMNS) {
    sqlite.exec(`ALTER TABLE threads DROP COLUMN ${column}`)
  }
  for (const column of PACT_STEPS_V42_COLUMNS) {
    sqlite.exec(`ALTER TABLE pact_steps DROP COLUMN ${column}`)
  }
  for (const column of REMOTE_AGENTS_V42_COLUMNS) {
    sqlite.exec(`ALTER TABLE remote_agents DROP COLUMN ${column}`)
  }
  for (const column of PEER_REPLY_OUTBOX_V42_COLUMNS) {
    sqlite.exec(`ALTER TABLE peer_reply_outbox DROP COLUMN ${column}`)
  }
  sqlite.exec(`ALTER TABLE peer_link_scan_facts DROP COLUMN unreachable_since`)
  sqlite.exec(`DROP TABLE IF EXISTS pact_applied_ids`)

  // Restore the pre-v42 trigger shapes (v35's unconditional-abort no-delete trigger; the
  // append-only trigger without the four new pact_steps columns in its inequality list) so the
  // reopen's DROP+re-CREATE is exercised against the real "before" shape, not just a no-op.
  sqlite.exec(`
    CREATE TRIGGER trg_pact_steps_no_delete
    BEFORE DELETE ON pact_steps
    BEGIN
      SELECT RAISE(ABORT, 'pact ledger is append-only');
    END;
  `)
  sqlite.exec(`
    CREATE TRIGGER trg_pact_steps_append_only
    BEFORE UPDATE ON pact_steps
    WHEN NEW.seq <> OLD.seq
      OR NEW.thread_id <> OLD.thread_id
      OR NEW.ordinal <> OLD.ordinal
      OR NEW.kind <> OLD.kind
      OR IFNULL(NEW.actor_agent_id, '') <> IFNULL(OLD.actor_agent_id, '')
      OR IFNULL(NEW.actor_pane_key, '') <> IFNULL(OLD.actor_pane_key, '')
      OR IFNULL(NEW.actor_host_id, '') <> IFNULL(OLD.actor_host_id, '')
      OR IFNULL(NEW.message_id, '') <> IFNULL(OLD.message_id, '')
      OR NEW.summary_sha256 <> OLD.summary_sha256
      OR IFNULL(NEW.turn_after_agent_id, '') <> IFNULL(OLD.turn_after_agent_id, '')
      OR IFNULL(NEW.reason_code, '') <> IFNULL(OLD.reason_code, '')
      OR NEW.at <> OLD.at
      OR NOT (NEW.summary IS NULL AND OLD.summary IS NOT NULL
              AND OLD.summary_purged_at IS NULL AND NEW.summary_purged_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'pact ledger is append-only');
    END;
  `)
  sqlite.pragma('user_version = 41')
}

describe('S10-21b B1: schema v42 migration (T24)', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    db = undefined
    tempDir = undefined
  })

  function freshPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-pact-v42-migration-'))
    return join(tempDir, 'orchestration.db')
  }

  it('a v41 store migrates to user_version 42: all 34 columns present, pact_applied_ids present and empty, unreachable_since present, both triggers present and still aborting, both new indexes present, no CHECK widened, row counts unchanged, a second open is a no-op', () => {
    const path = freshPath()

    db = new OrchestrationDb(path)
    const before = rawDb(db)
    // A pre-existing thread + a local and a remote pact_steps row, so the downgrade/reopen
    // round-trip has real rows to preserve and the trigger assertions below have fixtures.
    before
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era)
         VALUES ('thr_v42', 'v42 fixture', 'peer', 'agent:b', 'engaged', 'agent:a', 'agent:a', 0)`
      )
      .run()
    before
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_agent_id, summary_sha256)
         VALUES ('thr_v42', 0, 0, 'pause', NULL, 'deadbeef')`
      )
      .run()
    const preexisting = preexistingTableNames(before)
    const countsBefore = new Map(preexisting.map((t) => [t, rowCount(before, t)]))
    downgradeToV41(before)
    expect(before.pragma('user_version', { simple: true })).toBe(41)
    for (const column of THREADS_V42_COLUMNS) {
      expect(hasColumn(before, 'threads', column)).toBe(false)
    }
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(42)

    for (const column of THREADS_V42_COLUMNS) {
      expect(hasColumn(sqlite, 'threads', column)).toBe(true)
    }
    for (const column of PACT_STEPS_V42_COLUMNS) {
      expect(hasColumn(sqlite, 'pact_steps', column)).toBe(true)
    }
    for (const column of REMOTE_AGENTS_V42_COLUMNS) {
      expect(hasColumn(sqlite, 'remote_agents', column)).toBe(true)
    }
    for (const column of PEER_REPLY_OUTBOX_V42_COLUMNS) {
      expect(hasColumn(sqlite, 'peer_reply_outbox', column)).toBe(true)
    }
    expect(hasColumn(sqlite, 'peer_link_scan_facts', 'unreachable_since')).toBe(true)

    expect(hasTable(sqlite, 'pact_applied_ids')).toBe(true)
    expect(rowCount(sqlite, 'pact_applied_ids')).toBe(0)

    expect(hasTrigger(sqlite, 'trg_pact_steps_append_only')).toBe(true)
    expect(hasTrigger(sqlite, 'trg_pact_steps_no_delete')).toBe(true)
    expect(hasIndex(sqlite, 'idx_threads_pact_peer')).toBe(true)
    expect(hasIndex(sqlite, 'idx_peer_reply_outbox_pact')).toBe(true)
    expect(hasIndex(sqlite, 'idx_pact_steps_remote')).toBe(true)

    // Every pre-existing table's row count is unchanged (pact_applied_ids is new, excluded).
    // Asserted BEFORE the mutation-exercising assertions below, which deliberately insert more
    // rows to exercise the triggers/CHECK.
    for (const table of preexisting) {
      expect(rowCount(sqlite, table)).toBe(countsBefore.get(table))
    }

    // v41 (S10-21a) tables are present — the design's own citation names `agent_session_lineage`,
    // which does not exist in this tree; 21a actually landed as these three tables (verified at
    // this brief's base, db.ts's schema-version history comment).
    for (const table of [
      'agent_launch_sessions',
      'current_sessions',
      'agent_sweep_restore_marks'
    ]) {
      expect(hasTable(sqlite, table)).toBe(true)
    }

    // trg_pact_steps_append_only still aborts a summary-preserving UPDATE (changing `kind`,
    // which is not the one permitted purge transition).
    expect(() =>
      sqlite.prepare(`UPDATE pact_steps SET kind = 'resume' WHERE thread_id = 'thr_v42'`).run()
    ).toThrow(/append-only/)

    // trg_pact_steps_no_delete still aborts deleting a local row (actor_is_remote = 0).
    expect(() =>
      sqlite.prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_v42'`).run()
    ).toThrow(/append-only/)

    // ...and a remote row whose era equals the thread's current era (era 0 == thr_v42's era 0).
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_is_remote,
           actor_agent_id, summary_sha256)
         VALUES ('thr_v42', 0, 0, 'pause', 1, NULL, 'deadbee1')`
      )
      .run()
    expect(() =>
      sqlite
        .prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_v42' AND actor_is_remote = 1`)
        .run()
    ).toThrow(/append-only/)

    // No CHECK widened: pact_pause_reason still accepts exactly six values, and rejects a
    // seventh ('counterpart_unreachable' — the link-driven pause carries that as
    // pact_steps.reason_code instead, never as a pact_pause_reason value).
    const validReasons = [
      'counterpart_gone',
      'counterpart_left',
      'counterpart_quarantined',
      'thread_paused',
      'thread_closed',
      'operator'
    ]
    for (const reason of validReasons) {
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO threads (id, subject, origin, pact_pause_reason) VALUES (?, 'x', 'peer', ?)`
          )
          .run(`thr_reason_${reason}`, reason)
      ).not.toThrow()
    }
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO threads (id, subject, origin, pact_pause_reason) VALUES ('thr_reason_bad', 'x', 'peer', 'counterpart_unreachable')`
        )
        .run()
    ).toThrow()

    db.close()
    db = undefined

    // Second open (migrate() re-runs on every open; current is already 42) is a no-op.
    db = new OrchestrationDb(path)
    const sqliteAgain = rawDb(db)
    expect(sqliteAgain.pragma('user_version', { simple: true })).toBe(42)
    expect(rowCount(sqliteAgain, 'pact_applied_ids')).toBe(0)
  })

  // D-R133 F4: pact-federated-schema-v42-migration.test.ts's own trigger assertions above only
  // exercise trg_pact_steps_no_delete's TWO abort arms (local row; same-era remote row) — the
  // EXEMPTION arm (era-age OR released-and-aged) was untested, so a trigger silently reverted to
  // v35's unconditional abort would still pass this whole file. FAILS AT BASE: base's trigger has
  // no exemption arm at all (bare RAISE(ABORT) unconditionally), so every DELETE below throws at
  // base — these are strengthening additions, not weakenings.
  it('era-age exemption: an actor_is_remote=1 row whose pact_era is less than the thread current pact_era IS deletable', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    sqlite
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era)
         VALUES ('thr_era', 'era fixture', 'peer', 'agent:b', 'engaged', 'agent:a', 'agent:a', 5)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_is_remote,
           actor_agent_id, summary_sha256)
         VALUES ('thr_era', 0, 3, 'pause', 1, NULL, 'deadbee2')`
      )
      .run()
    expect(() =>
      sqlite.prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_era'`).run()
    ).not.toThrow()
    expect(rowCount(sqlite, 'pact_steps')).toBe(0)
  })

  it('retention exemption: a released thread with pact_release_at backdated past PACT_RELEASED_RETENTION_MS (604_800_000ms) makes its actor_is_remote=1 row deletable', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    sqlite
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era, pact_release_at)
         VALUES ('thr_released_old', 'released fixture', 'peer', 'agent:b', 'released',
           'agent:a', 'agent:a', 5, datetime('now', '-8 days'))`
      )
      .run()
    // Same era as the thread — only the released+aged disjunct can permit this delete.
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_is_remote,
           actor_agent_id, summary_sha256)
         VALUES ('thr_released_old', 0, 5, 'pause', 1, NULL, 'deadbee3')`
      )
      .run()
    expect(() =>
      sqlite.prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_released_old'`).run()
    ).not.toThrow()
    expect(rowCount(sqlite, 'pact_steps')).toBe(0)
  })

  it('retention exemption: a released but not-yet-aged thread does NOT make its actor_is_remote=1 row deletable', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    sqlite
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era, pact_release_at)
         VALUES ('thr_released_new', 'released fixture', 'peer', 'agent:b', 'released',
           'agent:a', 'agent:a', 5, datetime('now'))`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_is_remote,
           actor_agent_id, summary_sha256)
         VALUES ('thr_released_new', 0, 5, 'pause', 1, NULL, 'deadbee4')`
      )
      .run()
    expect(() =>
      sqlite.prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_released_new'`).run()
    ).toThrow(/append-only/)
  })

  // D-R133 F8 / errata 21b-E2: WHEN NULL means "trigger does not fire" in SQLite — before the
  // IFNULL narrowing, an orphaned remote row (its thread already gone) made the era subquery
  // NULL, which made the whole WHEN clause NULL, letting the DELETE through (fail-OPEN). FAILS AT
  // BASE: base's trigger (no IFNULL) allows this delete instead of throwing.
  it('era-age exemption fails CLOSED on an orphaned remote row (its thread_id matches no threads row)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_is_remote,
           actor_agent_id, summary_sha256)
         VALUES ('thr_orphan_no_such_thread', 0, 0, 'pause', 1, NULL, 'deadbee6')`
      )
      .run()
    expect(() =>
      sqlite.prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_orphan_no_such_thread'`).run()
    ).toThrow(/append-only/)
  })

  it('a v42-stamped DB with pact_applied_ids entirely absent is re-created empty on open (repairUnshippedV42FederatedPacts)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec(`DROP TABLE pact_applied_ids`)
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(hasTable(sqlite, 'pact_applied_ids')).toBe(true)
    expect(rowCount(sqlite, 'pact_applied_ids')).toBe(0)
  })

  it('a v42-stamped DB missing a v42 column on threads is repaired on open (repairUnshippedV42FederatedPacts)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const before = rawDb(db)
    before.exec(`ALTER TABLE threads DROP COLUMN pact_pause_epoch`)
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(hasColumn(sqlite, 'threads', 'pact_pause_epoch')).toBe(true)
  })

  // D-R133 F6: a store already stamped v42 by an earlier in-review copy could carry v35's
  // bare-abort trg_pact_steps_no_delete forever and never gain the three v42 indexes — neither
  // was restored by the repair tier before this fix, since both lived only in the `current < 42`
  // migration block. FAILS AT BASE: base's repair tier does neither.
  it('a v42-stamped DB with the OLD bare-abort trg_pact_steps_no_delete and no v42 indexes is repaired on open: the era exemption works and all three indexes exist (repairUnshippedV42FederatedPacts)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const before = rawDb(db)
    before.exec(`DROP INDEX IF EXISTS idx_threads_pact_peer`)
    before.exec(`DROP INDEX IF EXISTS idx_peer_reply_outbox_pact`)
    before.exec(`DROP INDEX IF EXISTS idx_pact_steps_remote`)
    before.exec(`DROP TRIGGER IF EXISTS trg_pact_steps_no_delete`)
    before.exec(`
      CREATE TRIGGER trg_pact_steps_no_delete
      BEFORE DELETE ON pact_steps
      BEGIN
        SELECT RAISE(ABORT, 'pact ledger is append-only');
      END;
    `)
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(hasIndex(sqlite, 'idx_threads_pact_peer')).toBe(true)
    expect(hasIndex(sqlite, 'idx_peer_reply_outbox_pact')).toBe(true)
    expect(hasIndex(sqlite, 'idx_pact_steps_remote')).toBe(true)

    // Behavioral proof it is the WHEN-clause trigger, not the restored bare abort: an
    // actor_is_remote=1 row whose era is behind the thread's current era is deletable.
    sqlite
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era)
         VALUES ('thr_repair_trigger', 'x', 'peer', 'agent:b', 'engaged', 'agent:a', 'agent:a', 5)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_is_remote,
           actor_agent_id, summary_sha256)
         VALUES ('thr_repair_trigger', 0, 3, 'pause', 1, NULL, 'deadbee5')`
      )
      .run()
    expect(() =>
      sqlite.prepare(`DELETE FROM pact_steps WHERE thread_id = 'thr_repair_trigger'`).run()
    ).not.toThrow()
  })
})

// S10-21b B7b (D-R134/D-R135 F1, BLOCKER; D-R134 F14): every test above uses a store opened
// EXACTLY ONCE, so none of them exercise repairUnshippedV42FederatedPacts's own trigger
// DROP/CREATE — the class of defect the suite never exercised, per D-R134 F1/D-R135's own
// wording. These tests CLOSE and REOPEN before asserting, so the second open's
// repairUnshippedV42FederatedPacts call (db.ts, guarded on user_version >= 42) is what installs
// the trigger under test.
function triggerSql(sqlite: Database.Database, name: string): string {
  return (
    sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
      .get(name) as {
      sql: string
    }
  ).sql
}

// sqlite_master stores the statement text trimmed of outer whitespace and without the
// terminating `;` (that terminator ends the exec() call's statement list, it is not part of the
// stored CREATE TRIGGER statement) — normalize the JS constant the same way before comparing.
function asStoredTriggerSql(constantSql: string): string {
  return constantSql.trim().replace(/;\s*$/, '')
}

describe('S10-21b B7b (D-R134/D-R135 F1, D-R134 F14): reopened-store trigger tests', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    db = undefined
    tempDir = undefined
  })

  function freshPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-pact-v42-reopen-'))
    return join(tempDir, 'orchestration.db')
  }

  function seedThreadAndStep(sqlite: Database.Database, threadId: string): void {
    sqlite
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era)
         VALUES (?, 'reopen fixture', 'peer', 'agent:b', 'engaged', 'agent:a', 'agent:a', 0)`
      )
      .run(threadId)
    sqlite
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_agent_id,
           message_id, summary, summary_sha256)
         VALUES (?, 1, 0, 'step', 'agent:a', 'msg_1', 'a summary', 'deadbeef')`
      )
      .run(threadId)
  }

  // Item 2(a). FAILS AT BASE: repairUnshippedV42FederatedPacts's pre-fix bare summary clause
  // (`OR NOT (<purge shape>)`) is TRUE for this row (it is not in the purge shape), so the WHEN
  // clause fires and the settle-path stamp aborts with 'pact ledger is append-only' —
  // pact-federated-settle.ts:129-132's exact UPDATE shape.
  it('a reopened v42 store accepts the settle path relay_state/relay_settled_at stamp', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    seedThreadAndStep(rawDb(db), 'thr_settle')
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(() =>
      sqlite
        .prepare(
          `UPDATE pact_steps SET relay_state = 'delivered', relay_settled_at = datetime('now')
           WHERE thread_id = 'thr_settle'`
        )
        .run()
    ).not.toThrow()
  })

  // Item 2(b). FAILS AT BASE (empirically verified against ad5b3d806f): base has no
  // PACT_STEPS_APPEND_ONLY_TRIGGER_SQL/PACT_STEPS_NO_DELETE_TRIGGER_SQL export at all, so the
  // import above resolves undefined and the append_only assertion throws a TypeError inside
  // asStoredTriggerSql rather than an assertion mismatch — still a hard FAIL at base, by
  // construction (this test cannot exist meaningfully before the shared constants do). Once the
  // constants exist, the underlying claim is: the migration block's narrowed form and the repair
  // tier's pre-fix bare form were different SQL text for trg_pact_steps_append_only.
  // trg_pact_steps_no_delete already matched at base (D-R135: byte-identical for no_delete).
  it('after reopen, both pact_steps triggers are byte-identical to the shared constants in sqlite_master', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(triggerSql(sqlite, 'trg_pact_steps_append_only')).toBe(
      asStoredTriggerSql(PACT_STEPS_APPEND_ONLY_TRIGGER_SQL)
    )
    expect(triggerSql(sqlite, 'trg_pact_steps_no_delete')).toBe(
      asStoredTriggerSql(PACT_STEPS_NO_DELETE_TRIGGER_SQL)
    )
  })

  // Item 2(c). GREEN at base already (the guard): base's bare clause aborts every non-purge
  // update including this one, so this assertion already holds pre-fix — kept to prove the fix
  // does not loosen summary protection while narrowing everything else.
  it('after reopen, a summary-changing update still aborts (not the purge shape)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    seedThreadAndStep(rawDb(db), 'thr_summary')
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(() =>
      sqlite
        .prepare(`UPDATE pact_steps SET summary = 'edited' WHERE thread_id = 'thr_summary'`)
        .run()
    ).toThrow(/append-only/)
  })

  // Item 2(d), F14. DEVIATION from the brief's stated red/green (brief: "RED at base"),
  // empirically verified against ad5b3d806f (pathspec-limited `git stash push -- db.ts`, ran this
  // test against unmodified base db.ts, popped the stash): this assertion is GREEN at base, not
  // red. Base's repair tier reinstates the pre-B7 bare clause `OR NOT (<purge shape>)` on this
  // table (F1, the blocker this commit fixes), which is TRUE — and so aborts — for ANY UPDATE not
  // in the exact purge shape, including one that changes ONLY pact_era; this row's summary is
  // NULL both before and after, so it is not in the purge shape (which requires OLD.summary IS
  // NOT NULL) and base's blanket bug aborts it anyway, coincidentally producing the same outward
  // behavior F14's dedicated `OR NEW.pact_era <> OLD.pact_era` clause is meant to guarantee. Base
  // therefore has NO dedicated pact_era protection — it has an unrelated bug that happens to
  // cover this one case — so the assertion is asserted as its own test regardless, to prove the
  // fix's dedicated clause keeps this true once F1's blanket abort is narrowed away (a narrowing
  // of F1 that forgot `pact_era` would regress this test visibly instead of silently, since it
  // would no longer be riding on the old bug for coverage).
  it('after reopen, an UPDATE changing only pact_era aborts (F14: pact_era is immutable)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const before = rawDb(db)
    before
      .prepare(
        `INSERT INTO threads (id, subject, origin, pact_with_agent_id, pact_state,
           pact_proposer_agent_id, pact_turn_agent_id, pact_era)
         VALUES ('thr_era_immutable', 'reopen fixture', 'peer', 'agent:b', 'engaged',
           'agent:a', 'agent:a', 0)`
      )
      .run()
    before
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, pact_era, kind, actor_agent_id, summary_sha256)
         VALUES ('thr_era_immutable', 0, 0, 'pause', NULL, 'deadbeef')`
      )
      .run()
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(() =>
      sqlite
        .prepare(`UPDATE pact_steps SET pact_era = 1 WHERE thread_id = 'thr_era_immutable'`)
        .run()
    ).toThrow(/append-only/)
  })

  // Item 2(e). GREEN at base already (the guard): the purge transition is the one shape base's
  // bare clause was written to permit, so it already succeeds pre-fix — kept to prove the F1/F14
  // narrowing does not regress the one legitimate post-insert UPDATE this table supports
  // (message-purge.ts:108's exact statement shape, reproduced here).
  it('after reopen, the message-purge transition still succeeds', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    seedThreadAndStep(rawDb(db), 'thr_purge')
    db.close()
    db = undefined

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(() =>
      sqlite
        .prepare(
          `UPDATE pact_steps SET summary = NULL, summary_purged_at = datetime('now')
           WHERE thread_id = 'thr_purge' AND summary IS NOT NULL`
        )
        .run()
    ).not.toThrow()
    const row = sqlite
      .prepare(`SELECT summary, summary_purged_at FROM pact_steps WHERE thread_id = 'thr_purge'`)
      .get() as { summary: string | null; summary_purged_at: string | null }
    expect(row.summary).toBeNull()
    expect(row.summary_purged_at).not.toBeNull()
  })
})
