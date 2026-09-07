// S10-21c B2 (design §2 S8, chair synthesis S8 = framing B's D9, "a restore may not resume a
// session into a different worktree than the agent's own"). `restoreOneRegisteredPane` builds
// the resume from two independent sources — the worktree from the agents row (`R.worktree_id`,
// the `worktreeId` param here, always sets the spawn cwd) and the placement from the launch
// row's `pane_key` (`parsed.tabId`, only ever matters when a placement is offered) — and nothing
// checked they agree. New dep `resolveTabWorktreeId(tabId, hostId?)` resolves the tab's OWNING
// worktree from the persisted workspace session's `tabsByWorktree`.
//
// [S10-21c B2b, D-R145 blocking 1+2] RELOCATED after the remote exclusion, the
// unrecorded-launch supersession check, `decideEarlyRows`, and the routing/offerPlacement
// decision — so it fences a tab only when a placement is actually at stake, and never runs
// ahead of the arms it used to pre-empt. Two arms: (a) DISAGREEMENT — the tab resolves to a
// worktree that differs from the agents row's own -> Layer-3 `sweep_worktree_mismatch:
// tab_disagrees <w1>|<w2>`, no `ensure` call. (b) UNRESOLVABLE — the tab is in no
// `tabsByWorktree` bucket -> NOT a refusal (the base tree restores this candidate): withhold
// placement only (`offerPlacement=false`), note it (`placement_withheld: tab_unresolvable
// <tabId>`), and let the restore proceed background.
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
    expect(reasonCode).toContain('tab_disagrees wt-tab|wt-agent')
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('[D-R145 blocking 1] an unresolvable tab (absent from tabsByWorktree) -> NOT a refusal: proceeds without placement, note only', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000022'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f0e2'
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
    // Fresh pane key (Layer 2, no leaf to preserve) -- same shape as the "agreeing" fixture
    // below, so this test isolates the fence's own proceed-without-placement behaviour.
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-22',
        paneKey: freshPaneKey,
        worktreeId: 'wt-agent',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
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
    // Base behaviour preserved: an unresolvable tab still restores the candidate, exactly the
    // shape `routeDeadCandidate`'s own withheld-placement fallback already produces for other
    // "cannot place" reasons — never a refusal.
    expect(outcome.kind).toBe('layer2')
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    const noteRows = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code LIKE 'placement_withheld:%'`)
      .all() as { verb: string; reason_code: string }[]
    expect(noteRows).toHaveLength(1)
    expect(noteRows[0]!.verb).toBe('sweep_note')
    expect(noteRows[0]!.reason_code).toBe('placement_withheld: tab_unresolvable tab1')
    const mismatchRows = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code LIKE 'sweep_worktree_mismatch%'`)
      .all()
    expect(mismatchRows).toHaveLength(0)
  })

  it('[D-R145 blocking 2] a remote (SSH) pane still audits its own exclusion code — the fence is never reached', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000025'
    insertAgent(db, {
      id: 'agent-25',
      display_name: 'chair-25',
      pane_key: predPaneKey,
      worktree_id: 'wt-agent'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-25',
      launchGeneration: PRIOR_GEN,
      executionHostId: 'ssh:ssh-1',
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    // A tab that WOULD mismatch/refuse if the fence ran — proves it never gets the chance to.
    const resolveTabWorktreeId = vi.fn(() => undefined)
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, resolveTabWorktreeId }),
      orchestrationDb!,
      HOST_ID,
      'agent-25',
      null,
      'wt-agent',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer3')
    expect((outcome as { reasonCode: string }).reasonCode).toBe('sweep_remote_pane_excluded')
    expect(resolveTabWorktreeId).not.toHaveBeenCalled()
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('[D-R145 blocking 2] a daemon-survived pane still returns skipped_daemon_survived — the fence is never reached', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000026'
    insertAgent(db, {
      id: 'agent-26',
      display_name: 'chair-26',
      pane_key: predPaneKey,
      worktree_id: 'wt-agent',
      process_incarnation: 'pty-alive:inc-alive'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-26',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const resolveTabWorktreeId = vi.fn(() => undefined)
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { resolveTabWorktreeId }),
      orchestrationDb!,
      HOST_ID,
      'agent-26',
      'pty-alive:inc-alive',
      'wt-agent',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      {
        allLivePtyIds: new Set(['pty-alive']),
        terminalIdentityByPtyId: new Map([
          ['pty-alive', { handle: 'handle-alive', incarnationId: 'inc-alive' }]
        ])
      }
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(resolveTabWorktreeId).not.toHaveBeenCalled()
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
