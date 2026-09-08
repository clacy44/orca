// S10-21a C7d (Ruling 34 Addendum 23): the same-pane-key "narrowed identity rebind" sibling of
// rebindRestoredPane (C5) — updates terminal_handle/process_incarnation ONLY, never pane_key.
// [S10-21c B-final F1, D-R159 finding 1, SCENARIO_CORRECTION] Every "canonical, parseable
// identity" fixture below is now UUID-shaped in its incarnation half — parseProcessIncarnation's
// new explicit shape check (agent-process-identity.ts) requires one. The bare-id-refusal test
// (item 1 below) is intentionally unaffected: its whole point is an unparseable value.
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
      processIncarnation: 'pty-new:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'
    })

    expect(result).toMatchObject({ ok: true, agentId: 'agent-respawn', pactsToUnpause: [] })
    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-respawn')
    expect(row?.pane_key).toBe(paneKey)
    expect(row?.terminal_handle).toBe('term_new')
    expect(row?.process_incarnation).toBe('pty-new:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5')
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
      processIncarnation: 'pty-x:ffffffff-ffff-4fff-8fff-fffffffffff6',
      agentId: 'agent-by-id'
    })
    expect(result).toMatchObject({ ok: true, agentId: 'agent-by-id' })

    const targetRow = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-by-id')
    expect(targetRow?.terminal_handle).toBe('term-new')
    expect(targetRow?.process_incarnation).toBe('pty-x:ffffffff-ffff-4fff-8fff-fffffffffff6')

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
      processIncarnation: 'pty-chain:11111111-2222-4333-8444-555555555556'
    })
    expect(result).toMatchObject({ ok: true, agentId: 'agent-chain' })

    const row = orchestrationDb!.getAgentByIdIncludingTombstoned('agent-chain')
    const identity = parseProcessIncarnation(row?.process_incarnation ?? null)
    expect(identity).toEqual({
      ptyId: 'pty-chain',
      incarnationId: '11111111-2222-4333-8444-555555555556'
    })

    // The next sweep's inventory round lists the respawned pty under the SAME incarnation.
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(['pty-chain']),
      terminalIdentityByPtyId: new Map([
        ['pty-chain', { handle: 'term_new', incarnationId: '11111111-2222-4333-8444-555555555556' }]
      ])
    }
    expect(agentAlive(identity, inventory)).toBe('alive')
  })

  // [S10-21d R110] diag-r106-r110-2026-09-08.md: the daemon-survived arm never called
  // recordLaunch, so the pane's newest launch row stayed on the PREVIOUS generation forever and
  // sessionLaunchKnown (orchestration-agents-directory.ts) flipped false after a desktop
  // relaunch. `currentLaunchGeneration` closes that gap in the SAME transaction as the handle
  // refresh.
  it('R110: currentLaunchGeneration records a fresh daemon_survived launch row in the new generation', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-daemon-survived'
    insertAgent(db, {
      id: 'agent-daemon-survived',
      display_name: 'chair-daemon-survived',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })
    const priorLaunch = orchestrationDb!.recordLaunch({
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-1',
      launchGeneration: 'gen-old',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    expect(priorLaunch.ok).toBe(true)
    const rowsBefore = db.prepare(`SELECT COUNT(*) AS n FROM agent_launch_sessions`).get() as {
      n: number
    }

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      processIncarnation: 'pty-ds:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      agentId: 'agent-daemon-survived',
      currentLaunchGeneration: 'gen-new'
    })
    expect(result).toMatchObject({ ok: true, agentId: 'agent-daemon-survived' })

    const newest = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)
    expect(newest).toMatchObject({
      session_id: 'sess-1',
      launch_generation: 'gen-new',
      evidence: 'daemon_survived'
    })

    const rowsAfter = db.prepare(`SELECT COUNT(*) AS n FROM agent_launch_sessions`).get() as {
      n: number
    }
    expect(rowsAfter.n).toBe(rowsBefore.n + 1)

    const currentSessionRow = db
      .prepare(`SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?`)
      .get(HOST_ID, paneKey) as { session_id: string } | undefined
    expect(currentSessionRow?.session_id).toBe('sess-1')

    const handleRefreshAudit = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all()
    expect(handleRefreshAudit).toHaveLength(1)
  })

  it('R110: omitting currentLaunchGeneration leaves the launch ledger untouched (byte-identical prior behaviour)', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-daemon-survived-omit'
    insertAgent(db, {
      id: 'agent-daemon-survived-omit',
      display_name: 'chair-daemon-survived-omit',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })
    orchestrationDb!.recordLaunch({
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-2',
      launchGeneration: 'gen-old',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const rowsBefore = db.prepare(`SELECT COUNT(*) AS n FROM agent_launch_sessions`).get() as {
      n: number
    }

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      agentId: 'agent-daemon-survived-omit'
    })
    expect(result).toMatchObject({ ok: true })

    const rowsAfter = db.prepare(`SELECT COUNT(*) AS n FROM agent_launch_sessions`).get() as {
      n: number
    }
    expect(rowsAfter.n).toBe(rowsBefore.n)
    expect(orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)).toMatchObject({
      launch_generation: 'gen-old',
      evidence: 'host_launch'
    })
  })

  // [S10-21d D-R162 M-1] The daemon_survived row was inserted with agent_id NULL — every sibling
  // writer binds it (agent-restore-rebind.ts:196,357,408; agent-lineage-mismatch.ts:387) — so
  // retiring the agent left an orphan newest row that suppresses S5 bootstrap for the pane's next
  // occupant (agent-lineage-mismatch.ts). FIX: setLaunchAgentId in the same transaction.
  it('R162 M-1: the fresh daemon_survived launch row is bound to the agent id, and retire deletes it', () => {
    const db = rawDb()
    const paneKey = 'tab1:leaf-daemon-survived-m1'
    insertAgent(db, {
      id: 'agent-daemon-survived-m1',
      display_name: 'chair-daemon-survived-m1',
      pane_key: paneKey,
      terminal_handle: 'term_old'
    })
    orchestrationDb!.recordLaunch({
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-m1',
      launchGeneration: 'gen-old',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })

    const result = orchestrationDb!.refreshAgentHandleAfterRespawn({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_new',
      agentId: 'agent-daemon-survived-m1',
      currentLaunchGeneration: 'gen-new'
    })
    expect(result).toMatchObject({ ok: true, agentId: 'agent-daemon-survived-m1' })

    const newestRow = db
      .prepare(
        `SELECT agent_id FROM agent_launch_sessions WHERE host_id = ? AND pane_key = ?
           ORDER BY seq DESC LIMIT 1`
      )
      .get(HOST_ID, paneKey) as { agent_id: string | null }
    expect(newestRow.agent_id).toBe('agent-daemon-survived-m1')

    orchestrationDb!.retireAgent('agent-daemon-survived-m1')
    const boundRowsAfterRetire = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_launch_sessions WHERE agent_id = 'agent-daemon-survived-m1'`
      )
      .get() as { n: number }
    expect(boundRowsAfterRetire.n).toBe(0)
  })
})
