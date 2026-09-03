// S10-19 (chair rulings 20/22/24): v38 -> v39 migration — remote_dispatch_attachments gains
// blocked_reason/blocked_at/blocked_consumed_at/handle_bound_at/agent_exited_at, idx_rda_terminal_
// handle, the 'agent_exited' state (CHECK rebuild, its own reviewable hunk), and the (empty,
// reader-gated) peer_run_grants table. C-7.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('v38 -> v39 peer attachment migration (C-7)', () => {
  let dbPath: string
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('opening a v38-stamped fixture reaches v39 with every new column, the widened CHECK, the index, and peer_run_grants', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-v39-migrate-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.pragma('user_version = 38')
    raw
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage)
         VALUES ('disp_v39old0001', 'task_v39old0001', 'fp_peer', 'epoch1', 'ready', 'input_accepted')`
      )
      .run()
    raw.close()

    db = new OrchestrationDb(dbPath)
    const raw2 = new Database(dbPath)
    expect(raw2.pragma('user_version', { simple: true })).toBe(40)

    for (const column of [
      'blocked_reason',
      'blocked_at',
      'blocked_consumed_at',
      'handle_bound_at',
      'agent_exited_at'
    ]) {
      const hasColumn = (
        raw2.prepare(`PRAGMA table_info(remote_dispatch_attachments)`).all() as { name: string }[]
      ).some((c) => c.name === column)
      expect(hasColumn).toBe(true)
    }

    // Pre-existing row survives the CHECK-rebuild untouched.
    const oldRow = db.getRemoteDispatchAttachment('disp_v39old0001')
    expect(oldRow?.state).toBe('ready')
    expect(oldRow?.agent_exited_at ?? null).toBeNull()

    // The widened CHECK admits 'agent_exited' post-rebuild.
    expect(() => {
      raw2
        .prepare(
          `UPDATE remote_dispatch_attachments SET state = 'agent_exited' WHERE dispatch_id = 'disp_v39old0001'`
        )
        .run()
    }).not.toThrow()

    const indexNames = (
      raw2.prepare(`PRAGMA index_list(remote_dispatch_attachments)`).all() as { name: string }[]
    ).map((i) => i.name)
    expect(indexNames).toContain('idx_rda_terminal_handle')

    const hasPeerRunGrants =
      raw2
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peer_run_grants'`)
        .get() !== undefined
    expect(hasPeerRunGrants).toBe(true)
    expect(
      (raw2.prepare(`SELECT COUNT(*) AS n FROM peer_run_grants`).get() as { n: number }).n
    ).toBe(0)

    raw2.close()
  })

  it('a fresh DB (createTables() shape) already allows agent_exited without a v39 migration run', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-v39-fresh-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    const raw = new Database(dbPath)
    expect(raw.pragma('user_version', { simple: true })).toBe(40)
    const hasIndex = (
      raw.prepare(`PRAGMA index_list(remote_dispatch_attachments)`).all() as { name: string }[]
    ).some((i) => i.name === 'idx_rda_terminal_handle')
    expect(hasIndex).toBe(true)
    raw.close()
  })

  it('review finding 10: the CHECK-rebuild INSERT...SELECT column list actually runs against real v38 data — every column survives on multiple rows', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-v39-rebuild-data-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    // The genuine PRE-v39 shape (old CHECK, no new columns) — mirrors the rollback test's DDL,
    // but here the rebuild is left to actually SUCCEED so the data-copy path runs for real.
    raw.exec(`
      DROP INDEX IF EXISTS idx_rda_terminal_handle;
      ALTER TABLE remote_dispatch_attachments RENAME TO remote_dispatch_attachments_v38shape;
      CREATE TABLE remote_dispatch_attachments (
        dispatch_id             TEXT PRIMARY KEY,
        task_id                 TEXT NOT NULL,
        home_peer_fingerprint   TEXT NOT NULL,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        runtime_epoch           TEXT NOT NULL,
        capability_hash         TEXT,
        pane_key                TEXT,
        process_incarnation     TEXT,
        state                   TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                   TEXT NOT NULL DEFAULT 'accepted',
        worktree_id             TEXT,
        terminal_handle         TEXT,
        setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
        effects                 TEXT NOT NULL DEFAULT '[]',
        residual_resources      TEXT NOT NULL DEFAULT '[]',
        to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
        last_error              TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      DROP TABLE remote_dispatch_attachments_v38shape;
      DROP TABLE IF EXISTS peer_run_grants;
    `)
    raw.pragma('user_version = 38')
    raw
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch,
            capability_hash, pane_key, process_incarnation, state, stage, worktree_id,
            terminal_handle, setup_state, effects, residual_resources,
            to_worker_imported_sequence, last_error, created_at, updated_at)
         VALUES
           ('disp_data_1', 'task_1', 'fp_peer_1', 2, 'epoch_1', 'cap_hash_1', 'tab_1:leaf_1',
            'pty_1:inc_1', 'ready', 'input_accepted', 'wt_1', 'term_1', 'ran', '[{"kind":"a"}]',
            '[{"kind":"b"}]', 3, 'err_1', '2024-01-01 00:00:00', '2024-01-02 00:00:00'),
           ('disp_data_2', 'task_2', 'fp_peer_2', 1, 'epoch_2', NULL, NULL, NULL, 'stopped',
            'agent_exited', NULL, NULL, 'not_applicable', '[]', '[]', 0, NULL,
            '2024-02-01 00:00:00', '2024-02-02 00:00:00')
      `
      )
      .run()
    raw.close()

    db = new OrchestrationDb(dbPath)
    const raw2 = new Database(dbPath)
    expect(raw2.pragma('user_version', { simple: true })).toBe(40)

    const row1 = db.getRemoteDispatchAttachment('disp_data_1')
    expect(row1).toMatchObject({
      task_id: 'task_1',
      home_peer_fingerprint: 'fp_peer_1',
      protocol_version: 2,
      runtime_epoch: 'epoch_1',
      capability_hash: 'cap_hash_1',
      pane_key: 'tab_1:leaf_1',
      process_incarnation: 'pty_1:inc_1',
      state: 'ready',
      stage: 'input_accepted',
      worktree_id: 'wt_1',
      terminal_handle: 'term_1',
      setup_state: 'ran',
      to_worker_imported_sequence: 3,
      last_error: 'err_1',
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-02 00:00:00',
      // New v39 columns default to NULL for a pre-existing row — never fabricated.
      blocked_reason: null,
      blocked_at: null,
      blocked_consumed_at: null,
      handle_bound_at: null,
      agent_exited_at: null
    })
    expect(JSON.parse(row1?.effects ?? '[]')).toEqual([{ kind: 'a' }])
    expect(JSON.parse(row1?.residual_resources ?? '[]')).toEqual([{ kind: 'b' }])

    const row2 = db.getRemoteDispatchAttachment('disp_data_2')
    expect(row2).toMatchObject({
      task_id: 'task_2',
      home_peer_fingerprint: 'fp_peer_2',
      protocol_version: 1,
      capability_hash: null,
      pane_key: null,
      process_incarnation: null,
      state: 'stopped',
      stage: 'agent_exited',
      worktree_id: null,
      terminal_handle: null,
      to_worker_imported_sequence: 0,
      last_error: null
    })

    raw2.close()
  })

  it('a mid-rebuild failure leaves user_version at 38 — the CHECK rebuild is inside the atomic migration transaction', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-v39-rollback-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    // Rebuild remote_dispatch_attachments into its genuine PRE-v39 shape (old CHECK, no new
    // columns) so migrate() actually re-enters the current<39 block instead of short-circuiting
    // on a table that already has the shape it would produce.
    raw.exec(`
      DROP INDEX IF EXISTS idx_rda_terminal_handle;
      ALTER TABLE remote_dispatch_attachments RENAME TO remote_dispatch_attachments_v38shape;
      CREATE TABLE remote_dispatch_attachments (
        dispatch_id             TEXT PRIMARY KEY,
        task_id                 TEXT NOT NULL,
        home_peer_fingerprint   TEXT NOT NULL,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        runtime_epoch           TEXT NOT NULL,
        capability_hash         TEXT,
        pane_key                TEXT,
        process_incarnation     TEXT,
        state                   TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                   TEXT NOT NULL DEFAULT 'accepted',
        worktree_id             TEXT,
        terminal_handle         TEXT,
        setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
        effects                 TEXT NOT NULL DEFAULT '[]',
        residual_resources      TEXT NOT NULL DEFAULT '[]',
        to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
        last_error              TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      DROP TABLE remote_dispatch_attachments_v38shape;
      DROP TABLE IF EXISTS peer_run_grants;
    `)
    raw.pragma('user_version = 38')
    // Force the CHECK-rebuild's `CREATE TABLE remote_dispatch_attachments_new` to fail by
    // pre-occupying that name — the whole v38->v39 migration runs inside one BEGIN IMMEDIATE
    // transaction (migrate()'s outer try/catch), so this failure must roll back everything,
    // including the earlier ALTER TABLE ADD COLUMN statements in the same block.
    raw.exec(`CREATE TABLE remote_dispatch_attachments_new (poison INTEGER)`)
    raw.close()

    expect(() => {
      db = new OrchestrationDb(dbPath)
    }).toThrow()
    db = undefined

    const raw2 = new Database(dbPath)
    expect(raw2.pragma('user_version', { simple: true })).toBe(38)
    // The ALTERs from the same transaction must also have rolled back.
    const hasColumn = (
      raw2.prepare(`PRAGMA table_info(remote_dispatch_attachments)`).all() as { name: string }[]
    ).some((c) => c.name === 'agent_exited_at')
    expect(hasColumn).toBe(false)
    raw2.close()
  })
})
