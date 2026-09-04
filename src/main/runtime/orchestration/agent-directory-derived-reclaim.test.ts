// F-19 (Ruling 33(a)): split out of agent-directory.test.ts to stay under the max-lines
// ratchet — same precedent as this repo's other topic-split test files. Covers B1's
// derived-placeholder reclaim branch in upsertAgentByPaneSuffix (agent-directory.ts).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { upsertAgentByPaneSuffix, type UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('F-19 (Ruling 33(a)): derived-placeholder reclaim on rename collision', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function baseParams(
    overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
  ): UpsertAgentByPaneSuffixParams {
    return {
      displayName: 'merge-restructure-backend',
      role: 'backend for the merge restructure',
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      terminalHandle: 'term_a',
      processIncarnation: 'inc1',
      worktreeId: 'wt1',
      worktreePath: '/wt/merge-restructure',
      branch: 'merge-restructure',
      title: 'sanitized title',
      agentLabel: 'Claude Code',
      originHandle: 'term_a',
      originHostId: 'local',
      ...overrides
    }
  }

  // A restart mints a derived row bound to THIS pane's suffix (agent-directory-rpc-liveness.ts
  // via agent-directory-rpc-liveness.ts / derived-agent-rows.ts) — simulated directly here the
  // same shape those mint, rather than going through the RPC layer this unit test doesn't have.
  function insertDerivedRow(
    db: Database.Database,
    params: { id: string; paneKey: string; quarantined?: number }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         origin_kind, origin_pane_key, origin_handle, origin_host_id
       ) VALUES (?, ?, NULL, 'local', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'gone', 1, ?,
         'derived', ?, NULL, 'local')`
    ).run(params.id, params.id, params.paneKey, params.quarantined ?? 0, params.paneKey)
  }

  it('T1: derived row on caller pane + dead-pane name holder -> reminted, id preserved, derived row tombstoned, suffix uniquely held', () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    insertDerivedRow(db, { id: 'agt_derived1', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')
    if (result.outcome === 'reminted') {
      expect(result.agent.id).toBe(holderId)
      expect(result.agent.pane_key).toBe('tab2:leaf-bbb')
      expect(result.agent.derived).toBe(0)
    }
    const derivedRow = db
      .prepare('SELECT tombstoned_at, pane_key FROM agents WHERE id = ?')
      .get('agt_derived1') as { tombstoned_at: string | null; pane_key: string | null }
    expect(derivedRow.tombstoned_at).not.toBeNull()
    expect(derivedRow.pane_key).toBeNull()
    const suffixHolders = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agents
         WHERE tombstoned_at IS NULL AND substr(pane_key, instr(pane_key, ':') + 1) = 'leaf-bbb'`
      )
      .get() as { c: number }
    expect(suffixHolders.c).toBe(1)
  })

  it('T2: unread mail on the derived row is repointed onto the reclaimed id with a mailbox_repoint audit row', () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    insertDerivedRow(db, { id: 'agt_derived2', paneKey: 'tab2:leaf-bbb' })
    db.prepare(
      `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
       VALUES ('msg_derived_mail', 'run_peer_local', 'peer', 'agent:agt_derived2', 'poke', 'status', 'normal', 0)`
    ).run()

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')
    const moved = db
      .prepare(`SELECT to_handle, read FROM messages WHERE id = 'msg_derived_mail'`)
      .get() as { to_handle: string; read: number }
    expect(moved.to_handle).toBe(`agent:${holderId}`)
    const audit = db
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'mailbox_repoint' ORDER BY seq DESC LIMIT 1`
      )
      .get(holderId) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('succession')
    expect(audit?.reason_code).toContain('agt_derived2')
  })

  it('T3: derived row + LIVE name holder -> name_taken, holderPaneDead false', () => {
    const db = rawDb()
    upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    insertDerivedRow(db, { id: 'agt_derived3', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: (paneKey) => paneKey === 'tab1:leaf-aaa'
      })
    )
    expect(result.outcome).toBe('name_taken')
    if (result.outcome === 'name_taken') {
      expect(result.holderPaneDead).toBe(false)
    }
    const derivedRow = db
      .prepare('SELECT tombstoned_at FROM agents WHERE id = ?')
      .get('agt_derived3') as { tombstoned_at: string | null }
    expect(derivedRow.tombstoned_at).toBeNull()
  })

  it('T4a: a quarantined name holder still refuses even when the caller pane is derived', () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    db.prepare('UPDATE agents SET quarantined = 1 WHERE id = ?').run(holderId)
    insertDerivedRow(db, { id: 'agt_derived4', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('name_taken')
    const derivedRow = db
      .prepare('SELECT tombstoned_at FROM agents WHERE id = ?')
      .get('agt_derived4') as { tombstoned_at: string | null }
    expect(derivedRow.tombstoned_at).toBeNull()
  })

  it('T4b: a quarantined derived row on the caller pane still refuses (never reclaims through a locked row)', () => {
    const db = rawDb()
    upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    insertDerivedRow(db, { id: 'agt_derived5', paneKey: 'tab2:leaf-bbb', quarantined: 1 })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('name_taken')
    const derivedRow = db
      .prepare('SELECT tombstoned_at FROM agents WHERE id = ?')
      .get('agt_derived5') as { tombstoned_at: string | null }
    expect(derivedRow.tombstoned_at).toBeNull()
  })
})
