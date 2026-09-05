// S10-21a C7j (Ruling 34 Addendum 27, row 7): "a self-resume audited since this process started
// holds the leaf." Split out of restore-registered-agent-panes-decision-table.test.ts (rows 1-11
// minus row 7) to stay under the max-lines ratchet.
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

describe('S10-21a C7j: row 7, the self-resume watermark (Ruling 34 Addendum 27)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('row 7 fires: dead, no launch row this generation, a launch_self_resume audit for this pane newer than the watermark — skipped_leaf_held, never spawns', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000b007'
    insertAgent(db, { id: 'agent-row7a', display_name: 'chair-row7a', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row7a',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    // Baseline row so the watermark is a real, non-null seq, THEN capture it.
    orchestrationDb!.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: HOST_ID,
      verb: 'sweep_note',
      outcome: 'proceeded',
      reasonCode: 'baseline'
    })
    const watermark = orchestrationDb!.newestAgentAuditSeq()
    expect(watermark).not.toBeNull()
    // A self-resume audited AFTER the watermark, same pane.
    orchestrationDb!.writeAgentAudit({
      agentId: null,
      actorPaneKey: paneKey,
      actorHostId: HOST_ID,
      verb: 'launch_self_resume',
      outcome: 'admitted',
      reasonCode: 'caller'
    })
    const selfResumeSeq = orchestrationDb!.newestAgentAuditSeq()
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-row7a',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory(),
      watermark
    )
    expect(outcome.kind).toBe('skipped_leaf_held')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip'
           AND reason_code = ?`
      )
      .all(`leaf_held: self_resume_audited_this_process seq=${selfResumeSeq}`)
    expect(rows).toHaveLength(1)
  })

  it('row 7 does not fire for a self-resume audit older than the watermark — falls through to row 8, restores normally', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000b008'
    insertAgent(db, { id: 'agent-row7b', display_name: 'chair-row7b', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-row7b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    // Self-resume audited BEFORE the watermark is captured.
    orchestrationDb!.writeAgentAudit({
      agentId: null,
      actorPaneKey: paneKey,
      actorHostId: HOST_ID,
      verb: 'launch_self_resume',
      outcome: 'admitted',
      reasonCode: 'caller'
    })
    const watermark = orchestrationDb!.newestAgentAuditSeq()
    expect(watermark).not.toBeNull()
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-row7b',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, isLeafInPersistedLayout: () => true }),
      orchestrationDb!,
      HOST_ID,
      'agent-row7b',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory(),
      watermark
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensureAgentSession).toHaveBeenCalledTimes(1)
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip'
           AND reason_code LIKE 'leaf_held: self_resume_audited_this_process%'`
      )
      .all()
    expect(rows).toHaveLength(0)
  })

  it('watermark absent (db not attached at capture) — row 7 skipped, ONE sweep_note per sweep, rows 8-11 proceed for every candidate', async () => {
    const db = rawDb()
    const paneKeyA = 'tab1:00000000-0000-4000-8000-00000000b009'
    const paneKeyB = 'tab1:00000000-0000-4000-8000-00000000b010'
    for (const [id, paneKey, sessionId] of [
      ['agent-row7c-a', paneKeyA, 'sess-row7c-a'],
      ['agent-row7c-b', paneKeyB, 'sess-row7c-b']
    ] as const) {
      insertAgent(db, { id, display_name: id, pane_key: paneKey })
      recordLaunch(db, {
        hostId: HOST_ID,
        paneKey,
        agentType: 'claude',
        sessionId,
        launchGeneration: PRIOR_GEN,
        executionHostId: EXEC_HOST_ID,
        evidence: 'host_launch'
      })
    }
    const ensureAgentSession = vi.fn().mockImplementation((request: { placement?: unknown }) =>
      Promise.resolve({
        terminal: {
          handle: `handle-${JSON.stringify(request.placement)}`,
          paneKey: null,
          worktreeId: 'wt-1',
          title: null,
          executionHostId: EXEC_HOST_ID
        },
        disposition: 'created'
      })
    )
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        isLeafInPersistedLayout: () => true,
        getSelfResumeWatermark: () => null
      })
    )
    expect(summary.layer1).toBe(2)
    expect(ensureAgentSession).toHaveBeenCalledTimes(2)
    const noteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'self_resume_signal_unavailable: watermark_not_captured'`
      )
      .all()
    expect(noteRows).toHaveLength(1)
    const heldRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE reason_code LIKE 'leaf_held: self_resume_audited_this_process%'`
      )
      .all()
    expect(heldRows).toHaveLength(0)
  })
})
