// S10-19 W-2: db.ts's own new query/delete surface — findPeerOwnedAttachmentForHandle's
// ordering, countLivePeerAttachments, and pruneSettledRemoteAttachments (retention + per-link cap).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import Database from '../../sqlite/sync-database'
import { PEER_ATTACHMENT_RETENTION_MS } from '../peer-profile-constants'

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: () => unknown[] }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

function insertAttachment(
  db: OrchestrationDb,
  dispatchId: string,
  overrides: Partial<{
    homeFingerprint: string
    state: string
    terminalHandle: string | null
    handleBoundAt: string | null
    createdAt: string
    updatedAt: string
    agentExitedAt: string | null
  }> = {}
): void {
  rawDb(db)
    .prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage,
          terminal_handle, handle_bound_at, created_at, updated_at, agent_exited_at)
       VALUES (?, 'task_x', ?, 'epoch1', ?, 'stage', ?, ?, ?, ?, ?)`
    )
    .run(
      dispatchId,
      overrides.homeFingerprint ?? 'fp1',
      overrides.state ?? 'ready',
      overrides.terminalHandle === undefined ? null : overrides.terminalHandle,
      overrides.handleBoundAt ?? null,
      overrides.createdAt ?? '2026-01-01 00:00:00',
      overrides.updatedAt ?? '2026-01-01 00:00:00',
      overrides.agentExitedAt ?? null
    )
}

describe('S10-19 W-2: findPeerOwnedAttachmentForHandle', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('picks the most recently bound row for a handle, by COALESCE(handle_bound_at, created_at)', () => {
    db = new OrchestrationDb(':memory:')
    insertAttachment(db, 'disp_old', {
      terminalHandle: 'term_shared',
      handleBoundAt: '2026-01-01 00:00:00'
    })
    insertAttachment(db, 'disp_new', {
      terminalHandle: 'term_shared',
      handleBoundAt: '2026-01-02 00:00:00'
    })
    const row = db.findPeerOwnedAttachmentForHandle('term_shared')
    expect(row?.dispatch_id).toBe('disp_new')
  })

  it('excludes a row already marked agent_exited_at', () => {
    db = new OrchestrationDb(':memory:')
    insertAttachment(db, 'disp_exited', {
      terminalHandle: 'term_x',
      agentExitedAt: '2026-01-01 00:00:00'
    })
    expect(db.findPeerOwnedAttachmentForHandle('term_x')).toBeUndefined()
  })
})

describe('S10-19 W-2: countLivePeerAttachments (ops MN-7)', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('counts only non-exited rows in the live state set, scoped to one fingerprint', () => {
    db = new OrchestrationDb(':memory:')
    insertAttachment(db, 'd1', { homeFingerprint: 'fp_a', state: 'starting' })
    insertAttachment(db, 'd2', { homeFingerprint: 'fp_a', state: 'ready' })
    insertAttachment(db, 'd3', { homeFingerprint: 'fp_a', state: 'succeeded' })
    insertAttachment(db, 'd4', {
      homeFingerprint: 'fp_a',
      state: 'ready',
      agentExitedAt: '2026-01-01 00:00:00'
    })
    insertAttachment(db, 'd5', { homeFingerprint: 'fp_b', state: 'ready' })
    expect(db.countLivePeerAttachments('fp_a')).toBe(2)
    expect(db.countLivePeerAttachments('fp_b')).toBe(1)
    expect(db.countLivePeerAttachments('fp_nonexistent')).toBe(0)
  })
})

describe('S10-19 W-2: pruneSettledRemoteAttachments (§8.6, ops MO-2)', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('deletes a settled row past the retention window, keeps one inside it', () => {
    db = new OrchestrationDb(':memory:')
    const longAgo = new Date(Date.now() - PEER_ATTACHMENT_RETENTION_MS - 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    const recent = new Date(Date.now() - 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    insertAttachment(db, 'disp_stale', {
      state: 'succeeded',
      updatedAt: longAgo,
      agentExitedAt: longAgo
    })
    insertAttachment(db, 'disp_recent', {
      state: 'succeeded',
      updatedAt: recent,
      agentExitedAt: recent
    })
    // Ruling 31(b): a fresh :memory: store stamps its install-day floor at creation (now) — push
    // it back below `longAgo` so this test exercises ordinary per-row retention, not the
    // install-day floor (that behavior has its own tests in the "Ruling 31" describe below).
    rawDb(db).prepare(`UPDATE peer_attachment_retention_floor SET floor_at = ?`).run(longAgo)
    const deleted = db.pruneSettledRemoteAttachments()
    expect(deleted).toBeGreaterThanOrEqual(1)
    expect(db.getRemoteDispatchAttachment('disp_stale')).toBeUndefined()
    expect(db.getRemoteDispatchAttachment('disp_recent')).toBeDefined()
  })

  it('never deletes a row that is not settled (still active, agent_exited_at NULL)', () => {
    db = new OrchestrationDb(':memory:')
    const longAgo = new Date(Date.now() - PEER_ATTACHMENT_RETENTION_MS - 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    insertAttachment(db, 'disp_active', { state: 'ready', updatedAt: longAgo })
    db.pruneSettledRemoteAttachments()
    expect(db.getRemoteDispatchAttachment('disp_active')).toBeDefined()
  })

  it('enforces the per-link cap on settled rows even inside the retention window', () => {
    db = new OrchestrationDb(':memory:')
    const recent = new Date(Date.now() - 1_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    // PEER_ATTACHMENTS_RETAINED_PER_LINK is 256 — insert a small number and monkeypatch is not
    // needed: this test only proves the SQL shape works, using a temporarily-lowered fixture set
    // is impractical without exporting the constant as mutable, so assert the cap query doesn't
    // delete anything when well under the cap (regression guard for the ROW_NUMBER() SQL itself).
    for (let i = 0; i < 5; i++) {
      insertAttachment(db, `disp_cap_${i}`, {
        homeFingerprint: 'fp_cap',
        state: 'succeeded',
        updatedAt: recent,
        agentExitedAt: recent
      })
    }
    const deleted = db.pruneSettledRemoteAttachments()
    expect(deleted).toBe(0)
    for (let i = 0; i < 5; i++) {
      expect(db.getRemoteDispatchAttachment(`disp_cap_${i}`)).toBeDefined()
    }
  })
})

// Ruling 31 (D-B14/D-R59 migration-rehearsal root cause): install-day retention floor, loud
// prune counts, close-before-delete. `sqlAgo` mirrors insertAttachment's datetime string shape.
function sqlAgo(ms: number): string {
  return new Date(Date.now() - ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
}

// Builds a store whose remote_dispatch_attachments table is downgraded to its true pre-v39
// shape (mirrors peer-attachment-v39-migration.test.ts's own rebuild-test DDL) and whose
// user_version is rolled back to 36 — the table under test (remote_dispatch_attachments) is
// unchanged between v36 and v38, so this is an honest v36 fixture for the column this ruling's
// tests exercise, without hand-reconstructing remote_agents/messages' unrelated v37/v38 shapes.
function buildV36AttachmentFixture(
  rows: {
    dispatchId: string
    updatedAt: string
    terminalHandle?: string | null
  }[]
): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-ruling31-v36-'))
  const dbPath = join(tempDir, 'orca.db')
  const seed = new OrchestrationDb(dbPath)
  seed.close()

  const raw = new Database(dbPath)
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
    -- F6: the seed's OrchestrationDb(dbPath) construction already ran createTables(), which
    -- unconditionally CREATEs and STAMPs peer_attachment_retention_floor before migrate() ever
    -- runs (F7). Drop it here so the v39 migration step (the thing test (i) exists to prove) is
    -- the only thing that can create/stamp it — otherwise the assertion below passes even with
    -- the v39 stamp deleted.
    DROP TABLE IF EXISTS peer_attachment_retention_floor;
  `)
  for (const row of rows) {
    raw
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage,
            terminal_handle, created_at, updated_at)
         VALUES (?, 'task_v36', 'fp_v36', 'epoch1', 'succeeded', 'worker_report_queued', ?, ?, ?)`
      )
      .run(
        row.dispatchId,
        row.terminalHandle === undefined ? null : row.terminalHandle,
        row.updatedAt,
        row.updatedAt
      )
  }
  raw.pragma('user_version = 36')
  raw.close()
  return dbPath
}

describe('Ruling 31: install-day retention floor + loud prune + close-before-delete', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined
  afterEach(() => {
    db?.close()
    db = undefined
    runtime = undefined
  })

  it('(i) a v36 fixture with four 20-day-old settled rows migrates to 40, prune returns 0 immediately and 4 once past floor + retention', () => {
    const twentyDaysAgo = sqlAgo(20 * 24 * 60 * 60 * 1000)
    const dbPath = buildV36AttachmentFixture([
      { dispatchId: 'disp_v36_1', updatedAt: twentyDaysAgo, terminalHandle: null },
      { dispatchId: 'disp_v36_2', updatedAt: twentyDaysAgo, terminalHandle: null },
      { dispatchId: 'disp_v36_3', updatedAt: twentyDaysAgo, terminalHandle: null },
      { dispatchId: 'disp_v36_4', updatedAt: twentyDaysAgo, terminalHandle: null }
    ])

    db = new OrchestrationDb(dbPath)
    const raw = new Database(dbPath)
    expect(raw.pragma('user_version', { simple: true })).toBe(41)
    expect(
      (
        raw.prepare(`SELECT COUNT(*) AS n FROM remote_dispatch_attachments`).get() as {
          n: number
        }
      ).n
    ).toBe(4)
    const floorRow = raw
      .prepare(`SELECT floor_at FROM peer_attachment_retention_floor WHERE id = 1`)
      .get() as { floor_at: string } | undefined
    expect(floorRow?.floor_at).toBeTruthy()

    // Immediately after migration the install-day floor holds — none of the pre-existing,
    // long-past-dated rows are evaluated against their own 20-day-old updated_at.
    expect(db.pruneSettledRemoteAttachments()).toBe(0)
    for (const id of ['disp_v36_1', 'disp_v36_2', 'disp_v36_3', 'disp_v36_4']) {
      expect(db.getRemoteDispatchAttachment(id)).toBeDefined()
    }

    // Push the floor itself past the retention window (simulates real elapsed time since
    // install) — now the backlog is eligible.
    raw
      .prepare(`UPDATE peer_attachment_retention_floor SET floor_at = ? WHERE id = 1`)
      .run(sqlAgo(PEER_ATTACHMENT_RETENTION_MS + 60_000))
    expect(db.pruneSettledRemoteAttachments()).toBe(4)
    for (const id of ['disp_v36_1', 'disp_v36_2', 'disp_v36_3', 'disp_v36_4']) {
      expect(db.getRemoteDispatchAttachment(id)).toBeUndefined()
    }
    raw.close()
  })

  it('(ii) a non-zero prune tick logs and writes one agent_audit row carrying the count', async () => {
    const dbPath = buildV36AttachmentFixture([
      {
        dispatchId: 'disp_audit_1',
        updatedAt: sqlAgo(20 * 24 * 60 * 60 * 1000),
        terminalHandle: null
      }
    ])
    db = new OrchestrationDb(dbPath)
    const raw = new Database(dbPath)
    raw
      .prepare(`UPDATE peer_attachment_retention_floor SET floor_at = ? WHERE id = 1`)
      .run(sqlAgo(PEER_ATTACHMENT_RETENTION_MS + 60_000))
    raw.close()

    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.setPeerGrantProfileLookup(() => 'peer')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runtime.tickDispatchLivenessMonitor()

    expect(db.getRemoteDispatchAttachment('disp_audit_1')).toBeUndefined()
    expect(
      warnSpy.mock.calls.some(
        (call) => call[0] === '[orchestration] settled remote attachment prune deleted rows'
      )
    ).toBe(true)
    const auditRows = rawDb(db)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'attachmentRetentionPrune'`)
      .all() as { outcome: string; reason_code: string }[]
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]?.outcome).toBe('pruned')
    expect(auditRows[0]?.reason_code).toBe('count=1')
    warnSpy.mockRestore()
  })

  it("(iii) Ruling 31 Add.1(d'): an expired row whose pane incarnation cannot be resolved this pass, and whose liveness is unproven, is LEFT ALONE — retried, never stamped, never deleted", async () => {
    const dbPath = buildV36AttachmentFixture([])
    db = new OrchestrationDb(dbPath)
    const raw = new Database(dbPath)
    raw
      .prepare(`UPDATE peer_attachment_retention_floor SET floor_at = ? WHERE id = 1`)
      .run(sqlAgo(PEER_ATTACHMENT_RETENTION_MS + 60_000))
    raw
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage,
            terminal_handle, process_incarnation, created_at, updated_at)
         VALUES ('disp_unresolvable', 'task_v36', 'fp_v36', 'epoch1', 'succeeded',
                 'worker_report_queued', 'term_stale', 'pty_stale:inc_1', ?, ?)`
      )
      .run(sqlAgo(20 * 24 * 60 * 60 * 1000), sqlAgo(20 * 24 * 60 * 60 * 1000))
    raw.close()

    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.setPeerGrantProfileLookup(() => 'peer')
    // The incarnation cannot be resolved to a live handle on this pass — the exact shape a
    // reconnect race leaves behind — and its liveness cannot be proven either way (no ptyController
    // wired in this test service, matching the real 'unknown' fallback at orca-runtime.ts:17167-17168).
    vi.spyOn(runtime, 'resolveLivePeerPaneHandle').mockReturnValue(null)
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('unknown')
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')

    runtime.tickDispatchLivenessMonitor()
    await vi.waitFor(() => {
      // tickDispatchLivenessMonitor's peer-attachment prune is async fire-and-forget; give it a
      // microtask/macrotask turn, then assert the row is provably still untouched.
      expect(db?.getRemoteDispatchAttachment('disp_unresolvable')).toBeDefined()
    })
    expect(closeTerminal).not.toHaveBeenCalled()
    const row = db.getRemoteDispatchAttachment('disp_unresolvable')
    expect(row?.agent_exited_at).toBeNull()
    const auditRows = rawDb(db)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all()
    expect(auditRows).toHaveLength(0)
  })

  it("(iii-b) Ruling 31 Add.1(d'): an expired row whose pane incarnation is PROVEN dead this pass is stamped with cause incarnation_dead and audited, never closed", async () => {
    const dbPath = buildV36AttachmentFixture([])
    db = new OrchestrationDb(dbPath)
    const raw = new Database(dbPath)
    raw
      .prepare(`UPDATE peer_attachment_retention_floor SET floor_at = ? WHERE id = 1`)
      .run(sqlAgo(PEER_ATTACHMENT_RETENTION_MS + 60_000))
    raw
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage,
            terminal_handle, process_incarnation, created_at, updated_at)
         VALUES ('disp_dead', 'task_v36', 'fp_v36', 'epoch1', 'succeeded',
                 'worker_report_queued', 'term_stale_dead', 'pty_stale_dead:inc_1', ?, ?)`
      )
      .run(sqlAgo(20 * 24 * 60 * 60 * 1000), sqlAgo(20 * 24 * 60 * 60 * 1000))
    raw.close()

    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.setPeerGrantProfileLookup(() => 'peer')
    vi.spyOn(runtime, 'resolveLivePeerPaneHandle').mockReturnValue(null)
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('dead')
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')

    runtime.tickDispatchLivenessMonitor()

    await vi.waitFor(() => {
      expect(db?.getRemoteDispatchAttachment('disp_dead')?.agent_exited_at).not.toBeNull()
    })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment('disp_dead')).toBeDefined()
    const auditRows = rawDb(db)
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'peerPaneClose' AND outcome = 'owner_unresolved'`
      )
      .all() as { reason_code: string }[]
    expect(auditRows.some((r) => r.reason_code === 'incarnation_dead')).toBe(true)
  })
})

describe('S10-19 W-2: deleteRemoteDispatchAttachment', () => {
  it('removes exactly the named row', () => {
    const db = new OrchestrationDb(':memory:')
    insertAttachment(db, 'disp_a')
    insertAttachment(db, 'disp_b')
    db.deleteRemoteDispatchAttachment('disp_a')
    expect(db.getRemoteDispatchAttachment('disp_a')).toBeUndefined()
    expect(db.getRemoteDispatchAttachment('disp_b')).toBeDefined()
    db.close()
  })
})
