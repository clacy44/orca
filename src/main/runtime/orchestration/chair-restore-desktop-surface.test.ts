// A chair restored by `orca chairs restore` must end with exactly ONE visible tab attached to its
// pty: the restore queues the pty for desktop materialization (like the startup sweep does), and
// main pushes fresh live-session marks so a later resume pass in the renderer never opens a second
// tab for the same conversation. Same real-`OrcaRuntimeService` harness as
// `chair-restore-launch-args.test.ts` — the fake pty controller is the only double.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { _resetRestoreSweepLockForTest } from '../restore-sweep-lock'
import { runChairsRestore, type ChairsRestoreExecutorDeps } from './chairs-restore-execute'
import { resolveResumeTranscript } from '../../startup/resolve-resume-transcript'
import type { ChairsManifest } from './chairs-manifest'
import type { LiveAgentSessionMark } from '../../../shared/sweep-restore-mark-list'
import type { RestoredPaneMaterializeSurface } from '../../startup/restore-sweep-desktop-materialize-queue'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const SESSION_ID = 'sess-desktop-surface'

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

function buildDeps(runtime: OrcaRuntimeService, db: OrchestrationDb): ChairsRestoreExecutorDeps {
  const hostId = runtime.getOrchestrationCompatibilityHostId()
  return {
    hostId,
    machineId: hostId,
    getAgentByName: (h, name) => db.getAgentByName(h, name),
    paneHoldingSession: (h, sessionId) => db.paneHoldingSession(h, sessionId),
    newestLaunchForPane: (h, paneKey) => db.newestLaunchForPane(h, paneKey),
    isPaneLive: (paneKey) => {
      const signals = runtime.getAgentDirectoryLivenessSignals(paneKey)
      return signals.terminalHandle !== null || signals.observedLive
    },
    requestChairRestore: (request) => runtime.requestChairRestore(request),
    hasLiveHookReportOfSession: (sessionId) => runtime.hasLiveHookReportOfSession(sessionId),
    hasResumableTranscriptTurn: async (agentType, sessionId) => {
      const result = await resolveResumeTranscript(agentType, sessionId)
      return result !== null && 'hasTurn' in result && result.hasTurn
    }
  }
}

const manifest = (): ChairsManifest => ({
  version: 1,
  chairs: [
    {
      name: 'chair-desktop-surface',
      worktree: 'id:wt-1',
      agent: 'claude',
      conversationId: SESSION_ID
    }
  ]
})

describe('chairs restore leaves one visible tab for the restored chair', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let spawnedPtyIds: string[]
  let originalHome: string | undefined
  let tempHome: string | undefined

  beforeEach(async () => {
    originalHome = process.env.HOME
    db = new OrchestrationDb(':memory:')
    tempHome = await mkdtemp(join(tmpdir(), 'orca-chairs-desktop-surface-'))
    process.env.HOME = tempHome
    const projectDir = join(tempHome, '.claude', 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
    )
    runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      }),
      getWorkspaceSession: () => ({ tabsByWorktree: {} }),
      getAllWorktreeMeta: () => ({}),
      getRepos: () => []
    } as never)
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    spawnedPtyIds = []
    runtime.setPtyController({
      spawn: async (opts) => {
        const id = randomUUID()
        spawnedPtyIds.push(id)
        const admission = (opts as { launchAdmission?: { kind: string } }).launchAdmission
        if (admission && admission.kind === 'host-resume') {
          const hostResume = admission as unknown as {
            sessionId: string
            predecessorPaneKey: string | null
            executionHostId: string
            launchGeneration: string
            evidence?: 'sweep_record' | 'host_restore'
          }
          const { tabId, leafId } = opts as { tabId: string; leafId: string }
          db.recordLaunch({
            hostId: runtime.getOrchestrationCompatibilityHostId(),
            paneKey: `${tabId}:${leafId}`,
            agentType: 'claude',
            sessionId: hostResume.sessionId,
            launchGeneration: hostResume.launchGeneration,
            executionHostId: hostResume.executionHostId,
            evidence: hostResume.evidence ?? 'sweep_record',
            ...(hostResume.predecessorPaneKey
              ? { supersedePaneKey: hostResume.predecessorPaneKey }
              : {})
          })
        }
        return { id, isReattach: false }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
  })

  afterEach(async () => {
    db?.close()
    _resetRestoreSweepLockForTest()
    vi.restoreAllMocks()
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true })
      tempHome = undefined
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    }
  })

  // M1
  it('queues the restored chair pty for desktop materialization, once, with its real identity', async () => {
    const recorded: RestoredPaneMaterializeSurface[] = []
    vi.spyOn(runtime, 'recordRestoredPaneForDesktopMaterialization').mockImplementation(
      (surface) => {
        recorded.push(surface)
      }
    )
    const summary = await runChairsRestore(manifest(), buildDeps(runtime, db))
    expect(summary.exitNonZero).toBe(false)
    const row = summary.rows[0]
    expect(row).toMatchObject({ kind: 'launch', ok: true })
    expect(recorded).toHaveLength(1)
    const surface = recorded[0]!
    const rowPaneKey = (row as { paneKey: string }).paneKey
    expect(surface.paneKey).toBe(rowPaneKey)
    expect(`${surface.tabId}:${surface.leafId}`).toBe(rowPaneKey)
    expect(surface.ptyId).toBe(spawnedPtyIds[0])
    expect(surface.agentId).toBe(db.getAgentByName('local', 'chair-desktop-surface')?.id)
    expect(surface.launchAgent).toBe('claude')
  })

  // M2
  it('materializes the queued chair pty through revealTerminalSession and clears its surfaceless mark', async () => {
    const reveals: { worktreeId: string; opts: Record<string, unknown> }[] = []
    runtime.setNotifier({
      revealTerminalSession: async (worktreeId: string, opts: Record<string, unknown>) => {
        reveals.push({ worktreeId, opts })
        return {
          tabId: opts.tabId as string,
          identity: {
            worktreeId,
            tabId: opts.tabId as string,
            leafId: opts.leafId as string,
            ptyId: opts.ptyId as string
          }
        }
      }
    } as never)
    const surfaceless = (runtime as unknown as { surfacelessBackgroundPtyIds: Set<string> })
      .surfacelessBackgroundPtyIds
    const summary = await runChairsRestore(manifest(), buildDeps(runtime, db))
    expect(summary.rows[0]).toMatchObject({ kind: 'launch', ok: true })
    const ptyId = spawnedPtyIds[0]!
    expect(surfaceless.has(ptyId)).toBe(true)
    expect(reveals).toHaveLength(0)

    await runtime.materializeRestoredAgentPanes()

    expect(reveals).toHaveLength(1)
    const [paneTabId, paneLeafId] = (summary.rows[0] as { paneKey: string }).paneKey.split(':')
    expect(reveals[0]!.worktreeId).toBe('wt-1')
    expect(reveals[0]!.opts).toMatchObject({
      ptyId,
      tabId: paneTabId,
      leafId: paneLeafId,
      presentation: 'background'
    })
    expect(surfaceless.has(ptyId)).toBe(false)
  })

  // M3
  describe('publishLiveAgentSessionMarks', () => {
    const marks: LiveAgentSessionMark[] = [
      {
        ptyId: 'pty-1',
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: 'sess-1'
      }
    ]

    it('forwards non-null marks to the notifier', async () => {
      const changed = vi.fn()
      runtime.setNotifier({ liveAgentSessionsChanged: changed } as never)
      vi.spyOn(runtime, 'getLiveAgentSessionMarks').mockResolvedValue(marks)
      await runtime.publishLiveAgentSessionMarks()
      expect(changed).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledWith(marks)
    })

    it('skips a null result and never throws', async () => {
      const changed = vi.fn()
      runtime.setNotifier({ liveAgentSessionsChanged: changed } as never)
      const spy = vi.spyOn(runtime, 'getLiveAgentSessionMarks').mockResolvedValue(null)
      await runtime.publishLiveAgentSessionMarks()
      expect(changed).not.toHaveBeenCalled()
      spy.mockRejectedValue(new Error('inventory exploded'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(runtime.publishLiveAgentSessionMarks()).resolves.toBeUndefined()
      expect(changed).not.toHaveBeenCalled()
    })
  })

  // M4
  it('pushes marks that include a background agent pty as soon as it is created', async () => {
    const changed = vi.fn()
    runtime.setNotifier({ liveAgentSessionsChanged: changed } as never)
    // The harness controller cannot list processes; report every spawned pty as live.
    const internals = runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: () => Promise<unknown>
      getResolvedWorktreeMap: () => Promise<Map<string, unknown>>
    }
    vi.spyOn(internals, 'getResolvedWorktreeMap').mockResolvedValue(new Map())
    vi.spyOn(internals, 'refreshPtyWorktreeRecordsWithControllerInventory').mockImplementation(
      async () => ({
        livePtyIds: new Set(spawnedPtyIds),
        allLivePtyIds: new Set(spawnedPtyIds),
        terminalIdentityByPtyId: new Map()
      })
    )
    // The spawn-time publish is debounced; fake only the debounce timer.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const summary = await runChairsRestore(manifest(), buildDeps(runtime, db))
    expect(summary.rows[0]).toMatchObject({ kind: 'launch', ok: true })
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    vi.useRealTimers()
    const pushed = changed.mock.calls.flatMap((call) => call[0] as LiveAgentSessionMark[])
    expect(pushed).toContainEqual(
      expect.objectContaining({
        ptyId: spawnedPtyIds[0],
        paneKey: (summary.rows[0] as { paneKey: string }).paneKey,
        agent: 'claude',
        providerSessionId: SESSION_ID
      })
    )
  })

  // R-4: spawn-time publishes are coalesced.
  describe('schedulePublishLiveAgentSessionMarks', () => {
    const schedule = (): void =>
      (
        runtime as unknown as { schedulePublishLiveAgentSessionMarks: () => void }
      ).schedulePublishLiveAgentSessionMarks()

    beforeEach(() => {
      vi.useFakeTimers()
      runtime.setNotifier({ liveAgentSessionsChanged: vi.fn() } as never)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('collapses a burst of schedules within the window into one inventory round', async () => {
      const marksSpy = vi.spyOn(runtime, 'getLiveAgentSessionMarks').mockResolvedValue([])
      schedule()
      await vi.advanceTimersByTimeAsync(100)
      schedule()
      schedule()
      expect(marksSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(150)
      expect(marksSpy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(marksSpy).toHaveBeenCalledTimes(1)
    })

    it('a schedule while a publish is in flight costs exactly one more publish after it finishes', async () => {
      let finishFirst!: () => void
      const marksSpy = vi
        .spyOn(runtime, 'getLiveAgentSessionMarks')
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishFirst = () => resolve([])
            })
        )
        .mockResolvedValue([])
      schedule()
      await vi.advanceTimersByTimeAsync(250)
      expect(marksSpy).toHaveBeenCalledTimes(1)

      // Three more spawns land while the first round is still running.
      schedule()
      schedule()
      schedule()
      await vi.advanceTimersByTimeAsync(250)
      expect(marksSpy).toHaveBeenCalledTimes(1)

      finishFirst()
      await vi.advanceTimersByTimeAsync(250)
      expect(marksSpy).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(marksSpy).toHaveBeenCalledTimes(2)
    })
  })
})
