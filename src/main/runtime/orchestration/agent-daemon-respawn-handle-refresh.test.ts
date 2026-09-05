// S10-21a C7d (Ruling 34 Addendum 23): the same-pane-key "narrowed identity rebind" sibling of
// rebindRestoredPane (C5) — updates terminal_handle/process_incarnation ONLY, never pane_key.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { AgentRow } from './types'
import {
  agentAlive,
  parseProcessIncarnation,
  type ControllerInventory
} from './agent-process-identity'

const HOST_ID = 'local'

describe('S10-21a C7d: refreshAgentHandleAfterRespawn', () => {
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
    overrides: Partial<AgentRow> & { id: string; display_name: string; pane_key: string | null }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         quarantined_at, tombstoned_at, origin_kind, origin_pane_key, origin_handle,
         origin_host_id
       ) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'idle', ?, ?, ?, ?,
         'pane', ?, ?, ?)`
    ).run(
      overrides.id,
      overrides.display_name,
      overrides.host_id ?? HOST_ID,
      overrides.pane_key,
      overrides.terminal_handle ?? null,
      overrides.derived ?? 0,
      overrides.quarantined ?? 0,
      overrides.quarantined_at ?? null,
      overrides.tombstoned_at ?? null,
      overrides.pane_key,
      overrides.terminal_handle ?? null,
      overrides.origin_host_id ?? HOST_ID
    )
  }

  it('updates terminal_handle/process_incarnation only — pane_key untouched — and audits rebind/reminted', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-respawn'
    insertAgent(db, {
      id: 'agent-respawn',
      display_name: 'chair-respawn',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })

    // [S10-21a C7l, Ruling 34 Addendum 29, SCENARIO_CORRECTION] Was:
    //   processIncarnation: 'inc-new' ... expect(row?.process_incarnation).toBe('inc-new')
    // A bare incarnation id is not a parseable identity (agent-process-identity.ts
    // parseProcessIncarnation) — this encoded the bug C7l fixes. The canonical
    // "<ptyId>:<incarnationId>" form is written verbatim; bare-id refusal is its own test below.
    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      processIncarnation: 'pty-new:inc-new'
    })

    expect(result).toMatchObject({ ok: true, agentId: 'agent-respawn', pactsToUnpause: [] })
    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-respawn')
    expect(row?.pane_key).toBe(paneKey)
    expect(row?.terminal_handle).toBe('term_new')
    expect(row?.process_incarnation).toBe('pty-new:inc-new')
    const audit = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all()
    expect(audit).toHaveLength(1)
  })

  it('[S10-21a C7l item 1] refuses to write a bare incarnation id — handle update proceeds, note recorded', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-bare'
    insertAgent(db, {
      id: 'agent-bare',
      display_name: 'chair-bare',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      processIncarnation: 'inc-new'
    })

    expect(result).toMatchObject({ ok: true, agentId: 'agent-bare', pactsToUnpause: [] })
    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-bare')
    expect(row?.terminal_handle).toBe('term_new')
    expect(row?.process_incarnation).toBeNull()
    const audit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'
           AND reason_code LIKE '%identity_unavailable_at_refresh: unparseable%'`
      )
      .all()
    expect(audit).toHaveLength(1)
  })

  it('[S10-21a C7l item 1] refuses to write a null identity — handle update proceeds, note recorded', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-null'
    insertAgent(db, {
      id: 'agent-null',
      display_name: 'chair-null',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      processIncarnation: null
    })

    expect(result).toMatchObject({ ok: true, agentId: 'agent-null', pactsToUnpause: [] })
    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-null')
    expect(row?.terminal_handle).toBe('term_new')
    expect(row?.process_incarnation).toBeNull()
    const audit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'
           AND reason_code LIKE '%identity_unavailable_at_refresh: null%'`
      )
      .all()
    expect(audit).toHaveLength(1)
  })

  it('refuses (no_registered_row) when nothing is registered on the pane, audited', () => {
    const db = rawDb()
    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-none',
      newTerminalHandle: 'term_new'
    })
    expect(result).toEqual({ ok: false, reason: 'no_registered_row' })
    const audit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'refused'
           AND reason_code LIKE '%no_registered_row%'`
      )
      .all()
    expect(audit).toHaveLength(1)
  })

  it('refuses on a tombstoned row and leaves it untouched', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-tombstoned'
    insertAgent(db, {
      id: 'agent-tombstoned',
      display_name: 'chair-tombstoned',
      pane_key: paneKey,
      tombstoned_at: '2026-01-01 00:00:00'
    })
    // getAgentByPaneKey excludes tombstoned rows entirely, so this reads as no_registered_row —
    // the same refusal shape a plain `pane_key IS NULL` (already-retired) row would produce.
    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new'
    })
    expect(result).toEqual({ ok: false, reason: 'no_registered_row' })
  })

  // [S10-21a C7k, Ruling 34 Addendum 28, item 6] `agentId`, when given, selects the row by id —
  // never re-derived by pane suffix. `paneKey` here deliberately names a DIFFERENT row's own
  // pane/suffix to prove the id wins outright, not merely "usually agrees with the suffix".
  it('agentId selects the row by id, bypassing the pane-suffix lookup entirely', () => {
    const db = rawDb()
    insertAgent(db, {
      id: 'agent-by-id',
      display_name: 'chair-by-id',
      pane_key: 'tab1:leaf-by-id',
      terminal_handle: 'term-by-id-old'
    })
    insertAgent(db, {
      id: 'agent-other',
      display_name: 'chair-other',
      pane_key: 'tab2:leaf-other',
      terminal_handle: 'term-other-old'
    })

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      // Names the OTHER row's own pane/suffix — a pane-suffix lookup would find 'agent-other'.
      paneKey: 'tab2:leaf-other',
      newTerminalHandle: 'term-new',
      processIncarnation: 'pty-x:inc-x',
      agentId: 'agent-by-id'
    })
    expect(result).toMatchObject({ ok: true, agentId: 'agent-by-id' })

    const targetRow = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-by-id')
    expect(targetRow?.terminal_handle).toBe('term-new')
    expect(targetRow?.process_incarnation).toBe('pty-x:inc-x')

    const otherRow = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-other')
    expect(otherRow?.terminal_handle).toBe('term-other-old')
  })

  it('refuses on a quarantined row, audited, row unchanged', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-quarantined'
    insertAgent(db, {
      id: 'agent-quarantined',
      display_name: 'chair-quarantined',
      pane_key: paneKey,
      terminal_handle: 'term_old',
      quarantined: 1,
      quarantined_at: '2026-01-01 00:00:00'
    })
    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new'
    })
    expect(result).toEqual({ ok: false, reason: 'row_quarantined' })
    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-quarantined')
    expect(row?.terminal_handle).toBe('term_old')
  })

  it('[S10-21a C7l item 1] identity chain: a canonical refresh reads alive at the next boot inventory round', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-respawn-chain'
    insertAgent(db, {
      id: 'agent-chain',
      display_name: 'chair-chain',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      processIncarnation: 'pty-chain:inc-chain'
    })
    expect(result).toMatchObject({ ok: true, agentId: 'agent-chain' })

    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-chain')
    const identity = parseProcessIncarnation(row?.process_incarnation ?? null)
    expect(identity).toEqual({ ptyId: 'pty-chain', incarnationId: 'inc-chain' })

    // The next sweep's inventory round lists the respawned pty under the SAME incarnation.
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(['pty-chain']),
      terminalIdentityByPtyId: new Map([
        ['pty-chain', { handle: 'term_new', incarnationId: 'inc-chain' }]
      ])
    }
    expect(agentAlive(identity, inventory)).toBe('alive')
  })
})
