// S10-22a WAVE 2 (Wave 2 contract, D-R217): `chairs restore`'s launch passes manifest
// `launchArgs` verbatim into the spawned command, same as `chair-succession-hold.ts`'s
// `launchSuccessor` does for `createAgentSession`. Same real-`OrcaRuntimeService` harness shape as
// `chairs-restore-e2e.test.ts` — the fake pty controller is the only double, exactly as that file
// documents (real spawn is unreachable from a bare test double).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { _resetRestoreSweepLockForTest } from '../restore-sweep-lock'
import { runChairsRestore, type ChairsRestoreExecutorDeps } from './chairs-restore-execute'
import { resolveResumeTranscript } from '../../startup/resolve-resume-transcript'
import type { ChairsManifest } from './chairs-manifest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

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

describe('S10-22a Wave 2: chairs restore launches with manifest launchArgs', () => {
  let db: OrchestrationDb
  let originalHome: string | undefined
  let tempHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
  })

  afterEach(async () => {
    db?.close()
    _resetRestoreSweepLockForTest()
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true })
      tempHome = undefined
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    }
  })

  it("a restore with manifest launchArgs ['--autocompact', '200000'] launches with those args", async () => {
    db = new OrchestrationDb(':memory:')
    tempHome = await mkdtemp(join(tmpdir(), 'orca-chairs-launch-args-'))
    process.env.HOME = tempHome
    expect(homedir()).toBe(tempHome)
    const projectDir = join(tempHome, '.claude', 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'sess-launch-args.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
    )

    const runtime = new OrcaRuntimeService({
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

    const seenCommands: string[] = []
    runtime.setPtyController({
      spawn: async (opts) => {
        seenCommands.push((opts as { command: string }).command)
        const id = randomUUID()
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

    const manifest: ChairsManifest = {
      version: 1,
      chairs: [
        {
          name: 'chair-launch-args',
          worktree: 'id:wt-1',
          agent: 'claude',
          conversationId: 'sess-launch-args',
          launchArgs: ['--autocompact', '200000']
        }
      ]
    }
    const deps = buildDeps(runtime, db)
    const summary = await runChairsRestore(manifest, deps)
    expect(summary.exitNonZero).toBe(false)
    expect(summary.rows[0]).toMatchObject({ kind: 'launch', ok: true })
    expect(seenCommands).toHaveLength(1)
    expect(seenCommands[0]).toContain('--autocompact')
    expect(seenCommands[0]).toContain('200000')
  })
})
