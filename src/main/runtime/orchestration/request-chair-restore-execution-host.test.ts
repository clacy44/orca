// S10-21d b3b (D-R163 H3 fix): requestChairRestore refuses a non-local worktree target BEFORE
// gathering any death-signal evidence or minting a ticket — conjunct B ("both
// LOCAL_EXECUTION_HOST_ID") is vacuous otherwise (getOrchestrationCompatibilityHostId() is a
// constant, never the resolved worktree's actual execution host).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function stubLaunchScope(
  runtime: OrcaRuntimeService,
  scope: { connectionId: string | null; repo: unknown }
): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
      id: string
      path: string
      connectionId: string | null
      repo: unknown
      folderWorkspace: null
    }>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: scope.connectionId,
    repo: scope.repo,
    folderWorkspace: null
  })
}

function makeRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService({
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
}

describe('D-R163 H3: requestChairRestore refuses a non-local worktree target', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('an SSH worktree selector is refused restore_target_not_local — no ticket, no DB write', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime, { connectionId: 'ssh-target-1', repo: null })
    const spawnSpy = vi.fn()
    runtime.setPtyController({
      spawn: spawnSpy,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-ssh',
      sessionId: 'sess-ssh-1',
      displayName: 'chair-ssh'
    })

    expect(result).toEqual({ ok: false, reason: 'restore_target_not_local' })
    expect(spawnSpy).not.toHaveBeenCalled()
    const hostId = runtime.getOrchestrationCompatibilityHostId()
    expect(db.paneHoldingSession(hostId, 'sess-ssh-1')).toBeUndefined()
    expect(
      (db as unknown as { db: { prepare: (sql: string) => { get: () => unknown } } }).db
        .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions')
        .get()
    ).toEqual({ n: 0 })
  })
})
