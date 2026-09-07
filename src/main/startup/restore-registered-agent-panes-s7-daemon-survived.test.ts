// S10-21c B5 (design §2 S7): the `skipped_daemon_survived` arm gets its handle refreshed and its
// mail delivery armed, host-triggered — split into its own file (rather than growing
// restore-registered-agent-panes-decision-table.test.ts or restore-registered-agent-panes.test.ts,
// both already near the max-lines ratchet) per _common-rules.md's "split modules if needed and
// say so".
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane, runRestoreSweepBody } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21c B5, design §2 S7: skipped_daemon_survived refreshes the handle and arms delivery', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it("calls refreshAgentHandleAfterRespawn with the candidate's own agentId, then notifyRebindDelivery once", async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a7a0'
    insertAgent(db, {
      id: 'agent-s7',
      display_name: 'chair-s7',
      pane_key: paneKey,
      process_incarnation: 'pty-s7:inc-s7'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-s7',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-s7']),
      terminalIdentityByPtyId: new Map([
        ['pty-s7', { handle: 'term_fresh_s7', incarnationId: 'inc-s7' }]
      ])
    })
    const notifyRebindDelivery = vi.fn()
    const refreshSpy = vi.spyOn(orchestrationDb!, 'refreshAgentHandleAfterRespawn')
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { notifyRebindDelivery }),
      orchestrationDb!,
      HOST_ID,
      'agent-s7',
      'pty-s7:inc-s7',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(refreshSpy).toHaveBeenCalledWith({
      hostId: HOST_ID,
      paneKey,
      newTerminalHandle: 'term_fresh_s7',
      processIncarnation: 'pty-s7:inc-s7',
      agentId: 'agent-s7'
    })
    expect(notifyRebindDelivery).toHaveBeenCalledTimes(1)
    expect(notifyRebindDelivery).toHaveBeenCalledWith('agent-s7')
  })

  it('a throw from refreshAgentHandleAfterRespawn is audited as a sweep note, never a failed skip — notifyRebindDelivery is not reached', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a7b0'
    insertAgent(db, {
      id: 'agent-s7b',
      display_name: 'chair-s7b',
      pane_key: paneKey,
      process_incarnation: 'pty-s7b:inc-s7b'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-s7b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-s7b']),
      terminalIdentityByPtyId: new Map([
        ['pty-s7b', { handle: 'term_fresh_s7b', incarnationId: 'inc-s7b' }]
      ])
    })
    const notifyRebindDelivery = vi.fn()
    vi.spyOn(orchestrationDb!, 'refreshAgentHandleAfterRespawn').mockImplementation(() => {
      throw new Error('refresh boom')
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { notifyRebindDelivery }),
      orchestrationDb!,
      HOST_ID,
      'agent-s7b',
      'pty-s7b:inc-s7b',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(notifyRebindDelivery).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'daemon_survived_refresh_failed: refresh boom'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('a throw from notifyRebindDelivery is audited as a sweep note, never a failed skip, after the handle refresh already committed', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000a7c0'
    insertAgent(db, {
      id: 'agent-s7c',
      display_name: 'chair-s7c',
      pane_key: paneKey,
      process_incarnation: 'pty-s7c:inc-s7c'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-s7c',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-s7c']),
      terminalIdentityByPtyId: new Map([
        ['pty-s7c', { handle: 'term_fresh_s7c', incarnationId: 'inc-s7c' }]
      ])
    })
    const notifyRebindDelivery = vi.fn(() => {
      throw new Error('notify boom')
    })
    const refreshSpy = vi.spyOn(orchestrationDb!, 'refreshAgentHandleAfterRespawn')
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { notifyRebindDelivery }),
      orchestrationDb!,
      HOST_ID,
      'agent-s7c',
      'pty-s7c:inc-s7c',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'daemon_survived_refresh_failed: notify boom'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it("no other candidate's agent id is ever passed — two daemon-survived panes each get only their OWN id/handle", async () => {
    const db = rawDb()
    const paneKeyA = 'tab1:00000000-0000-4000-8000-00000000a7d0'
    insertAgent(db, {
      id: 'agent-s7d-a',
      display_name: 'chair-s7d-a',
      pane_key: paneKeyA,
      process_incarnation: 'pty-s7d-a:inc-s7d-a'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: paneKeyA,
      agentType: 'claude',
      sessionId: 'sess-s7d-a',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const paneKeyB = 'tab1:00000000-0000-4000-8000-00000000a7e0'
    insertAgent(db, {
      id: 'agent-s7d-b',
      display_name: 'chair-s7d-b',
      pane_key: paneKeyB,
      process_incarnation: 'pty-s7d-b:inc-s7d-b'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: paneKeyB,
      agentType: 'claude',
      sessionId: 'sess-s7d-b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const notifyRebindDelivery = vi.fn()
    const refreshSpy = vi.spyOn(orchestrationDb!, 'refreshAgentHandleAfterRespawn')
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        notifyRebindDelivery,
        takeControllerInventoryForSweep: async () =>
          emptyInventory({
            allLivePtyIds: new Set(['pty-s7d-a', 'pty-s7d-b']),
            terminalIdentityByPtyId: new Map([
              ['pty-s7d-a', { handle: 'term_fresh_s7d_a', incarnationId: 'inc-s7d-a' }],
              ['pty-s7d-b', { handle: 'term_fresh_s7d_b', incarnationId: 'inc-s7d-b' }]
            ])
          })
      })
    )
    expect(summary.skippedDaemonSurvived).toBe(2)
    expect(refreshSpy).toHaveBeenCalledTimes(2)
    expect(refreshSpy).toHaveBeenCalledWith({
      hostId: HOST_ID,
      paneKey: paneKeyA,
      newTerminalHandle: 'term_fresh_s7d_a',
      processIncarnation: 'pty-s7d-a:inc-s7d-a',
      agentId: 'agent-s7d-a'
    })
    expect(refreshSpy).toHaveBeenCalledWith({
      hostId: HOST_ID,
      paneKey: paneKeyB,
      newTerminalHandle: 'term_fresh_s7d_b',
      processIncarnation: 'pty-s7d-b:inc-s7d-b',
      agentId: 'agent-s7d-b'
    })
    expect(notifyRebindDelivery).toHaveBeenCalledTimes(2)
    expect(notifyRebindDelivery).toHaveBeenCalledWith('agent-s7d-a')
    expect(notifyRebindDelivery).toHaveBeenCalledWith('agent-s7d-b')
  })
})
