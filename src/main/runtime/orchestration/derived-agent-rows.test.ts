// S10-21c B-final (D-R158-b4d finding 7): regression coverage for `getAgentByPaneKey`'s ORDER BY
// tie-break. The finding's own scenario — two non-tombstoned agent rows sharing a leaf suffix,
// with the query returning an arbitrary one — cannot be constructed here: `idx_agents_pane_suffix`
// (db.ts) is a UNIQUE index on `(host_id, suffix) WHERE tombstoned_at IS NULL`, so inserting a
// second non-tombstoned row on the same suffix raises a constraint violation, not silent
// ambiguity. These tests instead pin the query's pre-existing, still-required behaviour under the
// new ORDER BY clause: exact match found, host_id scoping preserved, tombstoned rows excluded.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { getAgentByPaneKey, listAgentsByPaneKeySuffix } from './derived-agent-rows'

describe('S10-21c B-final, D-R158-b4d finding 7: getAgentByPaneKey ORDER BY tie-break', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function insertAgent(
    db: Database.Database,
    over: {
      id: string
      display_name: string
      host_id?: string
      pane_key: string | null
      tombstoned_at?: string | null
    }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
         origin_host_id
       ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'idle', 0, 0,
         NULL, ?, 'pane', ?, NULL, ?)`
    ).run(
      over.id,
      over.display_name,
      over.host_id ?? 'local',
      over.pane_key,
      over.tombstoned_at ?? null,
      over.pane_key,
      over.host_id ?? 'local'
    )
  }

  it('finds the row by exact pane key (regression: the new ORDER BY must not change the single-row case)', () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'chair-1', pane_key: 'tab1:leaf-a' })
    expect(getAgentByPaneKey(db, 'local', 'tab1:leaf-a')?.id).toBe('agt_1')
  })

  it('is scoped by host_id — a same-suffix row on a DIFFERENT host is never returned', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agt_remote',
      display_name: 'remote',
      host_id: 'vps-1',
      pane_key: 'tab1:leaf-a'
    })
    expect(getAgentByPaneKey(db, 'local', 'tab1:leaf-a')).toBeUndefined()
    expect(getAgentByPaneKey(db, 'vps-1', 'tab1:leaf-a')?.id).toBe('agt_remote')
  })

  it('excludes a tombstoned row even when a live row exists on the SAME suffix (the tombstoned one is outside the UNIQUE index, so this is the one legitimate two-row-same-suffix state)', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agt_dead',
      display_name: 'retired',
      pane_key: 'tab1:leaf-a',
      tombstoned_at: '2026-01-01T00:00:00.000Z'
    })
    insertAgent(db, { id: 'agt_live', display_name: 'current', pane_key: 'tab2:leaf-a' })
    expect(getAgentByPaneKey(db, 'local', 'tab2:leaf-a')?.id).toBe('agt_live')
  })
})

// [S10-21d b3b, D-R163 LOW fix] conjunct F's defense-in-depth accessor — every live row
// sharing a pane's suffix, not just one `getAgentByPaneKey` pick.
describe('listAgentsByPaneKeySuffix (D-R163 LOW)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function insertAgent(
    db: Database.Database,
    over: {
      id: string
      display_name: string
      host_id?: string
      pane_key: string | null
      tombstoned_at?: string | null
    }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
         origin_host_id
       ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'idle', 0, 0,
         NULL, ?, 'pane', ?, NULL, ?)`
    ).run(
      over.id,
      over.display_name,
      over.host_id ?? 'local',
      over.pane_key,
      over.tombstoned_at ?? null,
      over.pane_key,
      over.host_id ?? 'local'
    )
  }

  it('returns the one row sharing the suffix', () => {
    const db = rawDb()
    insertAgent(db, { id: 'agt_1', display_name: 'chair-1', pane_key: 'tab1:leaf-a' })
    const rows = listAgentsByPaneKeySuffix(db, 'local', 'tab2:leaf-a')
    expect(rows.map((r) => r.id)).toEqual(['agt_1'])
  })

  it('is scoped by host_id', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agt_remote',
      display_name: 'remote',
      host_id: 'vps-1',
      pane_key: 'tab1:leaf-a'
    })
    expect(listAgentsByPaneKeySuffix(db, 'local', 'tab1:leaf-a')).toEqual([])
    expect(listAgentsByPaneKeySuffix(db, 'vps-1', 'tab1:leaf-a').map((r) => r.id)).toEqual([
      'agt_remote'
    ])
  })

  it('excludes tombstoned rows', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agt_dead',
      display_name: 'retired',
      pane_key: 'tab1:leaf-a',
      tombstoned_at: '2026-01-01T00:00:00.000Z'
    })
    expect(listAgentsByPaneKeySuffix(db, 'local', 'tab2:leaf-a')).toEqual([])
  })

  it('returns [] when nothing matches', () => {
    const db = rawDb()
    expect(listAgentsByPaneKeySuffix(db, 'local', 'tab1:leaf-a')).toEqual([])
  })
})
