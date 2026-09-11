// S10-21d b3b (D-R163 H3 fix): requestChairRestore refuses a non-local worktree target BEFORE
// gathering any death-signal evidence or minting a ticket — conjunct B ("both
// LOCAL_EXECUTION_HOST_ID") is vacuous otherwise (getOrchestrationCompatibilityHostId() is a
// constant, never the resolved worktree's actual execution host).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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
  // [S10-21f b2-10q R143] Explicit "no reporters" — see dead-holder-adoption-e2e.test.ts's own
  // makeRuntime() for why this is now required under the fail-closed default.
  runtime.setLiveReportPanesForSessionCheck(() => [])
  return runtime
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

  // [S10-21f b2-10q R142] A holder launch row with no execution_host_id must never silently
  // read as local (`?? hostId`) — the schema's NOT NULL keeps this from happening through the
  // normal recordLaunch path, so this proves the DEFENSIVE gate directly against a row the real
  // accessor could return under legacy/malformed data, via a stub on `db.newestLaunchForPane`.
  it("R142: a holder launch row with an empty execution_host_id is refused, never defaulted to 'local'", async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime, { connectionId: null, repo: null })
    const spawnSpy = vi.fn()
    runtime.setPtyController({
      spawn: spawnSpy,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const hostId = runtime.getOrchestrationCompatibilityHostId()
    const holderPaneKey = `tab-old:${randomUUID()}`
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-r142-host',
      role: null,
      hostId,
      paneKey: holderPaneKey,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: hostId
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const launched = db.recordLaunch({
      hostId,
      paneKey: holderPaneKey,
      agentType: 'claude',
      sessionId: 'sess-r142-host',
      launchGeneration: 'gen-r142-host-prior',
      executionHostId: hostId,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    const realRow = db.newestLaunchForPane(hostId, holderPaneKey)
    if (!realRow) {
      throw new Error('fixture launch row missing')
    }
    // Simulate a legacy/malformed row: the schema's NOT NULL cannot produce this through
    // recordLaunch, so the stub is the only way to exercise the defensive branch.
    vi.spyOn(db, 'newestLaunchForPane').mockReturnValue({ ...realRow, execution_host_id: '' })

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: 'sess-r142-host',
      displayName: 'chair-r142-host'
    })

    expect(result).toEqual({
      ok: false,
      reason: 'holder_execution_host_missing',
      holderPaneKey
    })
    expect(spawnSpy).not.toHaveBeenCalled()
    // The holder's binding is untouched — no supersede, no new row.
    expect(
      (db as unknown as { db: { prepare: (sql: string) => { get: () => unknown } } }).db
        .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions')
        .get()
    ).toEqual({ n: 1 })
  })
})
