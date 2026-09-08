// S10-21c B6 (design §2 S9): a successful Layer-2 restore records its surface for desktop
// materialization; a Layer-1 restore never does (the renderer never lost that pane's tab) —
// split into its own file (rather than growing restore-registered-agent-panes.test.ts, already
// near the max-lines ratchet) per _common-rules.md's "split modules if needed and say so",
// mirroring restore-registered-agent-panes-s7-daemon-survived.test.ts's own split.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21c B6, design §2 S9: Layer-2 restore records the desktop-materialization surface', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('a Layer-2 restore records {paneKey, worktreeId, tabId, leafId, ptyId, expectedProcessIdentity} for the NEW pane', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000020'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f020'
    insertAgent(db, {
      id: 'agent-20',
      display_name: 'chair-20',
      pane_key: predPaneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-20',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-20',
        paneKey: freshPaneKey,
        ptyId: 'pty-20',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const recordRestoredPaneForDesktopMaterialization = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        // [design §2.1b, D-R110 (δ)] someone else's live pty on the old leaf — forces Layer 2.
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' }),
        getTerminalProcessIncarnation: () => 'pty-20:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        recordRestoredPaneForDesktopMaterialization
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-20',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    expect(recordRestoredPaneForDesktopMaterialization).toHaveBeenCalledTimes(1)
    expect(recordRestoredPaneForDesktopMaterialization).toHaveBeenCalledWith({
      paneKey: freshPaneKey,
      agentId: 'agent-20',
      worktreeId: 'wt-1',
      tabId: 'tab2',
      leafId: '00000000-0000-4000-8000-00000000f020',
      ptyId: 'pty-20',
      title: null,
      launchAgent: 'claude',
      // [D-R153-b6 F5] The BARE incarnation, never the composite `agents.process_incarnation`
      // form `getTerminalProcessIncarnation` returns.
      expectedProcessIdentity: {
        terminalHandle: 'handle-20',
        incarnationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      }
    })
  })

  it('a Layer-1 restore (same leaf, no rebind) never records a desktop-materialization surface', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000021'
    insertAgent(db, { id: 'agent-21', display_name: 'chair-21', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-21',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-21',
        paneKey: predPaneKey,
        ptyId: 'pty-21',
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const recordRestoredPaneForDesktopMaterialization = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty-21:inc-21',
        recordRestoredPaneForDesktopMaterialization
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-21',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(recordRestoredPaneForDesktopMaterialization).not.toHaveBeenCalled()
  })

  it('an incomplete surface (no ptyId from ensureAgentSession) is audited and dropped, not queued half-built', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000022'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f022'
    insertAgent(db, { id: 'agent-22', display_name: 'chair-22', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-22',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-22',
        paneKey: freshPaneKey,
        // ptyId deliberately omitted — an incomplete surface.
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const recordRestoredPaneForDesktopMaterialization = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' }),
        getTerminalProcessIncarnation: () => 'pty-22:inc-22',
        recordRestoredPaneForDesktopMaterialization
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-22',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    expect(recordRestoredPaneForDesktopMaterialization).not.toHaveBeenCalled()
    // [not asserting total sweep_note count for this agent — other, unrelated sweep_note rows
    // (e.g. early-rows notes) can legitimately land alongside this one]
    const auditRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = ? AND verb = 'sweep_note' AND reason_code = ?`
      )
      .all('agent-22', 'desktop_materialize_refused: incomplete_surface') as {
      reason_code: string
    }[]
    expect(auditRows).toHaveLength(1)
  })
})
