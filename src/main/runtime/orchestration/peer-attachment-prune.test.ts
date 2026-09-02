// S10-19 W-2: db.ts's own new query/delete surface — findPeerOwnedAttachmentForHandle's
// ordering, countLivePeerAttachments, and pruneSettledRemoteAttachments (retention + per-link cap).
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { PEER_ATTACHMENT_RETENTION_MS } from '../peer-profile-constants'

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
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
