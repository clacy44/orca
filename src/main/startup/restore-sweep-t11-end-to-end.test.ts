// S10-21a C12 (design v3.2 §6.1 T11, restated in the C12 brief): the 10j regression, driven
// truly end to end through the actual production entry point — `runRestoreSweep` against a REAL
// `OrcaRuntimeService` + a real (stubbed-provider) `createTerminal`, exactly the harness
// restore-registered-agent-panes-real-createterminal.test.ts already proved sound for T2.
//
// What "end to end" means here, and why the existing coverage did not already prove it: T16 and
// "T11 (delivery half)" in s10-21a-c9-mail-restore-honesty.test.ts call
// `runtime.notifyRebindDelivery(agentId)` DIRECTLY — proving the delivery primitive works, never
// that the SWEEP itself reaches it. Separately, restore-registered-agent-panes.test.ts's own
// T1/T3b prove Layer1/Layer2 + the audit/mark bookkeeping through a MOCKED `ensureAgentSession`,
// never a real spawn or a real mailbox. This file composes all three real mechanisms through one
// call: a registered pane with a prior-generation launch row and unread mail (the "sleeping
// record" state a restart finds), `takeControllerInventoryForSweep` reporting the recorded
// identity ABSENT from the one daemon-inventory round (per errata 5(af)/Ruling 34 Addenda 27-30:
// the boot-time sweep is the production restore path — pty.ts's daemon-respawn refresh gate
// never fires), `runRestoreSweep` deciding Layer 1 or 2 and calling `notifyRebindDelivery` on its
// own (restore-registered-agent-panes.ts:252), and the pane's own first-observed-idle edge
// (Ruling 32 Addendum 11 F2's `deliverPendingMessagesForLeaf` -> `resolveAgentMailboxForPaneKey`)
// delivering the mail that was withheld because the pane had not been observed live yet — all
// without a single `register` call, per the design's own closing assertion in §6.1 T11.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRestoreSweep, type RestoreSweepDeps } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'
const PRIOR_GEN = 'gen-prior'

function stubLaunchScope(runtime: OrcaRuntimeService): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
      id: string
      path: string
      connectionId: string | null
      repo: null
      folderWorkspace: null
    }>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

function buildDeps(runtime: OrcaRuntimeService): RestoreSweepDeps {
  return {
    getOrchestrationDb: () => runtime.getOrchestrationDb(),
    getOrchestrationCompatibilityHostId: () => runtime.getOrchestrationCompatibilityHostId(),
    getLaunchGenerationId: () => runtime.getLaunchGenerationId(),
    findConnectedLeafOccupant: (leafId, connectionId) =>
      runtime.findConnectedLeafOccupant(leafId, connectionId ?? null),
    findConnectedPtyForPane: (paneKey) => runtime.findConnectedPtyForPane(paneKey),
    isLeafInPersistedLayout: (tabId, leafId, hostId) =>
      runtime.isLeafInPersistedLayout(tabId, leafId, hostId ?? null),
    getPersistedPtyIdForLeaf: (tabId, leafId, hostId) =>
      runtime.getPersistedPtyIdForLeaf(tabId, leafId, hostId ?? null),
    ensureAgentSession: (request, caller, internal) =>
      runtime.ensureAgentSession(request, caller, internal),
    takeControllerInventoryForSweep: () => runtime.takeControllerInventoryForSweep(),
    getSelfResumeWatermark: () => runtime.getSelfResumeWatermark(),
    collectIncumbentEvidence: (paneKey, ptyId, now, preFetchedInventory) =>
      runtime.collectIncumbentEvidence(paneKey, ptyId, now, preFetchedInventory),
    getTerminalProcessIncarnation: (handle) => runtime.getTerminalProcessIncarnation(handle),
    mintRestoreTicket: (payload) => runtime.mintRestoreTicket(payload),
    notifyRebindDelivery: (agentId) => runtime.notifyRebindDelivery(agentId)
  }
}

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('orca orchestration check')
  )
}

function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

function driveIdleTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
  runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
}

describe('S10-21a C12, T11 end to end: registered pane + unread mail -> boot-time sweep -> delivery, no register', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
    _resetRestoreSweepLockForTest()
  })

  it("a registered pane whose recorded identity is absent from the one inventory round is restored (Layer 1 or 2), its waiting mail is delivered on the pane's first idle edge, and the identity is visible with the same id -- no register call anywhere in this test", async () => {
    vi.useFakeTimers()
    try {
      db = new OrchestrationDb(':memory:')
      const runtime = new OrcaRuntimeService({
        getSettings: () => ({
          disabledTuiAgents: [],
          agentCmdOverrides: {},
          agentDefaultArgs: {},
          agentDefaultEnv: {}
        })
      } as never)
      runtime.setOrchestrationDb(db)
      stubLaunchScope(runtime)
      const write = vi.fn(() => true)
      const spawnedPtyId = randomUUID()
      runtime.setPtyController({
        spawn: async () => ({ id: spawnedPtyId, isReattach: false }),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })

      // The "sleeping record" a restart finds: a registered pane (chair) with a prior-generation
      // launch row, whose recorded process identity (`inc-old`) will not appear in the one
      // daemon-inventory round below -- the "recorded identity absent from the inventory" shape
      // the brief names, judged by the sweep's own survival predicate (agents.process_incarnation
      // joined against takeControllerInventoryForSweep), never by leaf occupancy.
      const predPaneKey = `tab-old:${randomUUID()}`
      const created = db.upsertAgentByPaneSuffix({
        displayName: 'chair-t11',
        role: null,
        hostId: HOST_ID,
        paneKey: predPaneKey,
        terminalHandle: 'term_old_t11',
        processIncarnation: 'inc-old-t11',
        worktreeId: 'wt-1',
        worktreePath: null,
        branch: null,
        title: null,
        agentLabel: null,
        originHandle: 'term_old_t11',
        originHostId: HOST_ID
      })
      if (created.outcome === 'name_taken') {
        throw new Error('fixture setup failed')
      }
      const agentId = created.agent.id
      const launched = db.recordLaunch({
        hostId: HOST_ID,
        paneKey: predPaneKey,
        agentType: 'claude',
        sessionId: 'sess-t11',
        launchGeneration: PRIOR_GEN,
        executionHostId: EXEC_HOST_ID,
        evidence: 'host_launch'
      })
      if (!launched.ok) {
        throw new Error('fixture launch row failed')
      }

      // Unread mail waiting on the durable identity mailbox before the restart -- exactly T11's
      // "registered row + unread mail" setup.
      db.insertMessage({
        from: 'peer',
        to: `agent:${agentId}`,
        subject: 'waiting since before the restart (T11 end to end)'
      })
      expect(db.getUndeliveredUnreadMessages(`agent:${agentId}`).length).toBeGreaterThan(0)

      const deps = buildDeps(runtime)
      // The one daemon-inventory round: empty, i.e. the recorded identity is absent from it.
      // Orthogonal to the identity verdict itself (which reads agents.process_incarnation, per
      // errata 5(af)/Ruling 34 Addendum 27) -- an empty-but-non-null round, matching the T2
      // fixture's own reasoning (a null round defers every candidate unconditionally, per Ruling
      // 34 Addendum 28 item 2, which this test does not want to exercise).
      deps.takeControllerInventoryForSweep = async () => ({
        allLivePtyIds: new Set(),
        terminalIdentityByPtyId: new Map()
      })
      // The recorded identity is provably absent (no live pty at all this round) -- a direct D1
      // proven-exit verdict, the same simplification T2 in the real-createterminal fence uses,
      // since incumbent-death's own D1/D2/D3 combination logic is already covered elsewhere
      // (incumbent-death.test.ts / collect-incumbent-evidence.test.ts) and is orthogonal to what
      // this fence proves (the sweep's OWN reach into delivery and directory visibility).
      deps.collectIncumbentEvidence = async (paneKey) => ({
        paneKey,
        d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
        d2: { inventory: 'unknown' },
        d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
      })

      const summary = await runRestoreSweep(deps)

      expect(summary.errors).toBe(0)
      // Layer 1 (same leaf preserved) or Layer 2 (rebound to a fresh pane) -- either is a pass
      // per the design's own T11 wording ("Layer 1 or 2"); this fixture (a fresh pane, no prior
      // leaf to preserve) always lands Layer 2, asserted directly rather than with an OR to keep
      // the fence a precise statement of what this fixture actually drives.
      expect(summary.layer1).toBe(0)
      expect(summary.layer2).toBe(1)

      const restoredRow = db.getAgentByIdIncludingTombstoned(agentId)
      expect(restoredRow?.id).toBe(agentId)
      expect(restoredRow?.pane_key).not.toBe(predPaneKey)
      expect(restoredRow?.pane_key).not.toBeNull()
      expect(restoredRow?.tombstoned_at).toBeNull()

      // The sweep already called notifyRebindDelivery(agentId) on its own (restore-registered-
      // agent-panes.ts:252) -- but the freshly-minted pane has not been observed live this
      // generation yet, so delivery is withheld (T16's `awaiting_idle_edge`), not yet written.
      expect(write).not.toHaveBeenCalled()

      // The pane's first observed idle edge (Ruling 32 Addendum 11 F2): resolves the pane's
      // agent:<id> mailbox and delivers the withheld record -- no register call anywhere in this
      // test, matching the brief's "agents show reports the same id with no register".
      driveIdleTitle(runtime, spawnedPtyId)
      expect(pointerCalls(write, spawnedPtyId)).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, spawnedPtyId)).toHaveLength(1)

      // "agents show" surface, read directly off the directory (no register call was made
      // anywhere in this test) -- the same id, alive, on the new pane.
      const finalRow = db.getAgentByIdIncludingTombstoned(agentId)
      expect(finalRow?.id).toBe(agentId)
      expect(finalRow?.display_name).toBe('chair-t11')
      expect(finalRow?.tombstoned_at).toBeNull()
      expect(finalRow?.derived).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })
})
