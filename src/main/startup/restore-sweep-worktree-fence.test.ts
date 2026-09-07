// S10-21c B2 (design §2 S8, chair synthesis S8 = framing B's D9, "a restore may not resume a
// session into a different worktree than the agent's own"). `restoreOneRegisteredPane` builds
// the resume from two independent sources — the worktree from the agents row (`R.worktree_id`,
// the `worktreeId` param here) and the placement from the launch row's `pane_key` (`parsed.tabId`)
// — and nothing checked they agree. New dep `resolveTabWorktreeId(tabId, hostId?)` resolves the
// tab's OWNING worktree from the persisted workspace session's `tabsByWorktree`; a mismatch, or
// an unresolvable tab, refuses Layer-3 `sweep_worktree_mismatch: tab=<w1> agent=<w2>` — never
// "assume it matches".
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

describe('S10-21c B2/S8: worktree fence on restore', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it("agents row worktree W2 vs the pane's tab owned by W1 -> Layer-3 sweep_worktree_mismatch, no ensure call", async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000020'
    insertAgent(db, {
      id: 'agent-20',
      display_name: 'chair-20',
      pane_key: predPaneKey,
      worktree_id: 'wt-agent'
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
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        resolveTabWorktreeId: () => 'wt-tab'
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-20',
      null,
      'wt-agent',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer3')
    const reasonCode = (outcome as { reasonCode: string }).reasonCode
    expect(reasonCode).toContain('sweep_worktree_mismatch')
    expect(reasonCode).toContain('tab=wt-tab')
    expect(reasonCode).toContain('agent=wt-agent')
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('an unresolvable tab (absent from tabsByWorktree) -> Layer-3 sweep_worktree_mismatch, never assumed to match', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000022'
    insertAgent(db, {
      id: 'agent-22',
      display_name: 'chair-22',
      pane_key: predPaneKey,
      worktree_id: 'wt-agent'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-22',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        resolveTabWorktreeId: () => undefined
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-22',
      null,
      'wt-agent',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer3')
    expect((outcome as { reasonCode: string }).reasonCode).toContain('sweep_worktree_mismatch')
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('agreeing worktree ids proceed unchanged (Layer 2)', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000021'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f0e1'
    insertAgent(db, {
      id: 'agent-21',
      display_name: 'chair-21',
      pane_key: predPaneKey,
      worktree_id: 'wt-custom'
    })
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
        paneKey: freshPaneKey,
        worktreeId: 'wt-custom',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        resolveTabWorktreeId: () => 'wt-custom',
        // [design §2.1b, D-R110 (δ)] forces Layer 2 routing the same way T21 does, so this test
        // isolates the worktree-fence comparison from the rest of the decision table.
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-21',
      null,
      'wt-custom',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    expect(ensureAgentSession).toHaveBeenCalled()
  })
})
