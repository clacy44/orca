/**
 * 10z.5 R289 (T12, N6): `ensureAgentSession` fills missing launch pins for a CALLER resume of a
 * session attributed to a registered identity. Same REAL chain as
 * `ensure-agent-session-host-resume-prefs-chained.test.ts` (OrcaRuntimeService#ensureAgentSession ->
 * createTerminal -> the production `registerPtyHandlers` controller -> `admitAgentLaunch` ->
 * `db.recordLaunch`); only the raw provider spawn and the workspace scope stub are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync as realMkdirSync } from 'node:fs'
import type * as Wsl from '../wsl'
import { OrchestrationDb } from './orchestration/db'
import {
  configureHostIntegrityForTests,
  resetHostIntegrityForTests
} from '../host-integrity/host-integrity-guard'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  chmodSyncMock,
  getPathMock,
  loginPreflightExecFileMock,
  spawnMock,
  openCodeBuildPtyEnvMock,
  openCodeClearPtyMock,
  mimoCodeBuildPtyEnvMock,
  buildAgentHookEnvMock,
  clearAgentHookPaneStateMock,
  registerPaneKeyAliasMock,
  piBuildPtyEnvMock,
  piClearPtyMock,
  isPwshAvailableMock,
  wslUncDirectoryExistsAsyncMock,
  trackMock,
  classifyErrorMock,
  registerPtyMock,
  unregisterPtyMock,
  setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKeyMock,
  clearPaneKeyAliasesForPtyMock,
  recordCodexPaneAccountMock,
  forgetCodexPaneAccountMock,
  getCodexPaneAccountMock,
  ensureCodexBackfillRecoveryMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  chmodSyncMock: vi.fn(),
  getPathMock: vi.fn(),
  loginPreflightExecFileMock: vi.fn(),
  spawnMock: vi.fn(),
  openCodeBuildPtyEnvMock: vi.fn(),
  mimoCodeBuildPtyEnvMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  wslUncDirectoryExistsAsyncMock: vi.fn(),
  openCodeClearPtyMock: vi.fn(),
  buildAgentHookEnvMock: vi.fn(),
  clearAgentHookPaneStateMock: vi.fn(),
  registerPaneKeyAliasMock: vi.fn(),
  piBuildPtyEnvMock: vi.fn(),
  piClearPtyMock: vi.fn(),
  trackMock: vi.fn(),
  classifyErrorMock: vi.fn(),
  registerPtyMock: vi.fn(),
  unregisterPtyMock: vi.fn(),
  setMigrationUnsupportedPtyMock: vi.fn(),
  clearMigrationUnsupportedPtyMock: vi.fn(),
  clearMigrationUnsupportedPtysForPaneKeyMock: vi.fn(),
  clearPaneKeyAliasesForPtyMock: vi.fn(),
  recordCodexPaneAccountMock: vi.fn(),
  forgetCodexPaneAccountMock: vi.fn(),
  getCodexPaneAccountMock: vi.fn(),
  ensureCodexBackfillRecoveryMock: vi.fn(() => Promise.resolve())
}))

vi.mock('electron', () => ({
  BrowserWindow: undefined,
  app: {
    isPackaged: true,
    getPath: getPathMock,
    getVersion: () => '0.0.0-test'
  },
  powerMonitor: {
    on: vi.fn()
  },
  nativeTheme: {
    shouldUseDarkColors: true
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: chmodSyncMock,
  constants: {
    X_OK: 1,
    R_OK: 4
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: loginPreflightExecFileMock
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: {
    buildPtyEnv: openCodeBuildPtyEnvMock,
    clearPty: openCodeClearPtyMock
  }
}))

vi.mock('../mimo/hook-service', () => ({
  mimoCodeHookService: {
    buildPtyEnv: mimoCodeBuildPtyEnvMock
  }
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    buildPtyEnv: buildAgentHookEnvMock,
    clearPaneState: clearAgentHookPaneStateMock,
    registerPaneKeyAlias: registerPaneKeyAliasMock,
    clearPaneKeyAliasesForPty: clearPaneKeyAliasesForPtyMock
  }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: {
    buildPtyEnv: piBuildPtyEnvMock,
    clearPty: piClearPtyMock
  }
}))

vi.mock('../pwsh', () => ({
  isPwshAvailableAsync: isPwshAvailableMock
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof Wsl>()),
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/classify-error', () => ({
  classifyError: classifyErrorMock
}))

vi.mock('../cli/linux-terminal-orca-cli-shim', () => ({
  ensureLinuxTerminalOrcaCliShimDir: (options: { userDataPath: string }) =>
    join(options.userDataPath, 'linux-orca-cli-shim')
}))

vi.mock('../memory/pty-registry', () => ({
  registerPty: registerPtyMock,
  unregisterPty: unregisterPtyMock
}))

vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPty: setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPty: clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKey: clearMigrationUnsupportedPtysForPaneKeyMock
}))

vi.mock('../codex/codex-pane-account-registry', () => ({
  recordCodexPaneAccount: recordCodexPaneAccountMock,
  forgetCodexPaneAccount: forgetCodexPaneAccountMock,
  getCodexPaneAccount: getCodexPaneAccountMock
}))

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: ensureCodexBackfillRecoveryMock
}))

import {
  LocalPtyProvider,
  _resetLocalPtyProviderStateForTest
} from '../providers/local-pty-provider'
import { registerPtyHandlers, setLocalPtyProvider, unregisterSshPtyProvider } from '../ipc/pty'
import { _resetHiddenRendererPtyDeliveryGateForTest } from '../ipc/pty-hidden-delivery-gate'
import { _resetWslCachesForTests } from '../wsl'
import { __resetShellStartupEnvCache } from '../pty/shell-startup-env'
import { OrcaRuntimeService } from './orca-runtime'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { _resetRestoreSweepLockForTest } from './restore-sweep-lock'

const HOST_ID = 'local'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('10z.5 R289: caller-kind ensureAgentSession pins through the REAL admission chain', () => {
  const mainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn()
    }
  }

  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
  const savedOrcaUserDataPath = process.env.ORCA_USER_DATA_PATH

  let db: OrchestrationDb | undefined

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    accessSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    chmodSyncMock.mockReset()
    getPathMock.mockReset()
    loginPreflightExecFileMock.mockReset()
    spawnMock.mockReset()
    openCodeBuildPtyEnvMock.mockReset()
    mimoCodeBuildPtyEnvMock.mockReset()
    openCodeClearPtyMock.mockReset()
    buildAgentHookEnvMock.mockReset()
    clearAgentHookPaneStateMock.mockReset()
    registerPaneKeyAliasMock.mockReset()
    piBuildPtyEnvMock.mockReset()
    piClearPtyMock.mockReset()
    isPwshAvailableMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
    trackMock.mockReset()
    classifyErrorMock.mockReset()
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
    setMigrationUnsupportedPtyMock.mockReset()
    clearMigrationUnsupportedPtyMock.mockReset()
    clearMigrationUnsupportedPtysForPaneKeyMock.mockReset()
    clearPaneKeyAliasesForPtyMock.mockReset()
    recordCodexPaneAccountMock.mockReset()
    forgetCodexPaneAccountMock.mockReset()
    getCodexPaneAccountMock.mockReset()
    ensureCodexBackfillRecoveryMock.mockReset()
    ensureCodexBackfillRecoveryMock.mockResolvedValue(undefined)
    mainWindow.webContents.on.mockReset()
    mainWindow.webContents.send.mockReset()
    mainWindow.webContents.removeListener.mockReset()
    _resetHiddenRendererPtyDeliveryGateForTest()
    __resetShellStartupEnvCache()

    getPathMock.mockReturnValue('/tmp/orca-user-data')
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-user-data'
    // [S10-21a C3-v2, Ruling 34 Addendum 13] node:sqlite (OrchestrationDb) opens a REAL file at
    // this mocked userData path, bypassing the `fs` mock above entirely (native binding).
    realMkdirSync('/tmp/orca-user-data', { recursive: true })
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    readFileSyncMock.mockReturnValue('')
    openCodeBuildPtyEnvMock.mockImplementation((_ptyId: string, existingConfigDir?: string) => ({
      ORCA_OPENCODE_HOOK_PORT: '4567',
      ORCA_OPENCODE_HOOK_TOKEN: 'opencode-token',
      ORCA_OPENCODE_PTY_ID: 'test-pty',
      OPENCODE_CONFIG_DIR: existingConfigDir
        ? '/tmp/orca-opencode-overlay'
        : '/tmp/orca-opencode-config'
    }))
    mimoCodeBuildPtyEnvMock.mockImplementation((_ptyId: string, existingHome?: string) => ({
      MIMOCODE_HOME: existingHome ? '/tmp/orca-mimocode-overlay' : '/tmp/orca-mimocode-shared'
    }))
    buildAgentHookEnvMock.mockReturnValue({
      ORCA_AGENT_HOOK_PORT: '5678',
      ORCA_AGENT_HOOK_TOKEN: 'agent-token'
    })
    piBuildPtyEnvMock.mockImplementation(
      (
        _ptyId: string,
        existingAgentDir?: string,
        kind?: string,
        options?: { materializeDefaultHome?: boolean }
      ) => {
        const materializeDefaultHome = options?.materializeDefaultHome !== false
        if (kind === 'omp') {
          if (!existingAgentDir && !materializeDefaultHome) {
            return {
              ORCA_OMP_STATUS_EXTENSION:
                '/tmp/orca-user-data/omp-managed-status-extension/orca-agent-status.ts'
            }
          }
          return {
            ORCA_OMP_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-omp-agent',
            ORCA_OMP_STATUS_EXTENSION: `${existingAgentDir ?? '/tmp/default-omp-agent'}/extensions/orca-agent-status.ts`
          }
        }
        if (kind === 'prime-agent') {
          if (!existingAgentDir && !materializeDefaultHome) {
            return {}
          }
          return {
            ORCA_PRIME_AGENT_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-prime-agent'
          }
        }
        if (!existingAgentDir && !materializeDefaultHome) {
          return {}
        }
        return {
          ORCA_PI_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-pi-agent'
        }
      }
    )
    isPwshAvailableMock.mockReturnValue(false)
    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    })
  })

  afterEach(() => {
    db?.close()
    db = undefined
    _resetLocalPtyProviderStateForTest()
    _resetWslCachesForTests()
    vi.useRealTimers()
    for (const leakedConnectionId of ['c2-fence-leak']) {
      unregisterSshPtyProvider(leakedConnectionId)
    }
    setLocalPtyProvider(new LocalPtyProvider())
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedOrcaUserDataPath !== undefined) {
      process.env.ORCA_USER_DATA_PATH = savedOrcaUserDataPath
    } else {
      delete process.env.ORCA_USER_DATA_PATH
    }
  })

  // [S10-21d C2] Mirrors pty-controller-host-resume-admission-threading.test.ts's own
  // `installDaemonTestProvider` — the ONE fake in this file, at the lowest level
  // `registerPtyHandlers`'s real wrapper allows: the raw provider spawn (node-pty/daemon),
  // never `admitAgentLaunch`/`recordLaunch` themselves.
  function installDaemonTestProvider(overrides: Record<string, unknown> = {}) {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    const provider = {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      confirmForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      ...overrides
    }
    setLocalPtyProvider(provider as never)
    return spawn
  }

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

  // Builds a REAL `OrcaRuntimeService` and wires it to the REAL `registerPtyHandlers` controller
  // (with the raw provider spawn faked, per `installDaemonTestProvider` above) — same
  // `OrcaRuntimeService` construction T2 (`restore-registered-agent-panes-real-createterminal
  // .test.ts`) and T11 (`restore-sweep-t11-end-to-end.test.ts`) use, except THOSE files then call
  // `runtime.setPtyController({ spawn: async () => ({...}) })` directly — a bare stub that
  // bypasses `registerPtyHandlers`'s wrapper (and therefore `launchAdmissionBundle`/
  // `admitAgentLaunch`) entirely. This file never calls `setPtyController` itself; only
  // `registerPtyHandlers` does, so whatever it installs is the production controller.
  function buildRealRuntimeWithRealController(): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      }),
      // [R142b] `registerAgentForPane` (requestChairRestore's own registration step) walks
      // `listTerminals` -> `getResolvedWorktreeMap` -> `computeResolvedWorktrees`, which needs
      // these two store methods present even for a run with no real worktrees — harmless no-ops
      // for the file's original (non-chair-restore) test, which never reaches this path.
      getWorkspaceSession: () => ({ tabsByWorktree: {} }),
      getAllWorktreeMeta: () => ({}),
      getRepos: () => []
    } as never)
    runtime.setOrchestrationDb(db!)
    stubLaunchScope(runtime)
    // 6th positional arg (`store`): only `persistPtyBinding` is exercised, by
    // `persistHostSessionBinding: true` (always set by `ensureAgentSession`'s createTerminal
    // call) — a minimal stub, same as the real store's public write surface for this one path.
    registerPtyHandlers(mainWindow as never, runtime, undefined, undefined, undefined, {
      persistPtyBinding: vi.fn(() => true)
    } as never)
    return runtime
  }

  const X = '55555555-5555-4555-8555-555555555555'
  const OLD_PANE = 'tab-old:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let tempHome: string | undefined
  let originalHome: string | undefined

  beforeEach(async () => {
    originalHome = process.env.HOME
    tempHome = await mkdtemp(join(tmpdir(), 'orca-r289-'))
    process.env.HOME = tempHome
    const projectDir = join(tempHome, '.claude', 'projects', '-repo-app')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, `${X}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
    )
  })

  afterEach(async () => {
    _resetRestoreSweepLockForTest()
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true })
      tempHome = undefined
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    }
  })

  async function writeManifest(entry: Record<string, unknown>): Promise<void> {
    await mkdir(join(tempHome as string, '.orca'), { recursive: true })
    await writeFile(
      join(tempHome as string, '.orca', 'chairs.json'),
      JSON.stringify({
        version: 1,
        chairs: [
          {
            name: 'chair-r289',
            conversationId: X,
            worktree: '/repo/app',
            agent: 'claude',
            ...entry
          }
        ]
      })
    )
  }

  // A session attributed to a registered identity through an earlier launch row; the old pane no
  // longer holds X, so the caller resume below records a fresh `caller_resume` row.
  function seedAttributedSession(prefs?: { model?: string; effort?: string }): void {
    const created = db!.upsertAgentByPaneSuffix({
      displayName: 'chair-r289',
      role: null,
      hostId: HOST_ID,
      paneKey: OLD_PANE,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: HOST_ID
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const launched = db!.recordLaunch({
      hostId: HOST_ID,
      paneKey: OLD_PANE,
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-old',
      executionHostId: HOST_ID,
      evidence: 'host_launch',
      ...(prefs ? { prefs: { ...prefs, source: 'launch' as const } } : {})
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    db!.setLaunchAgentId({ seq: launched.row.seq }, created.agent.id)
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('DELETE FROM current_sessions WHERE pane_key = ?')
      .run(OLD_PANE)
  }

  function freshRuntime() {
    const spawn = vi.fn(async () => ({ id: 'pty-r289', incarnationId: 'inc-r289' }))
    installDaemonTestProvider({
      spawn,
      listProcesses: vi.fn(async () => [{ id: 'pty-r289', incarnationId: 'inc-r289' }])
    })
    const runtime = buildRealRuntimeWithRealController()
    runtime.setLiveReportPanesForSessionCheck(() => [])
    return { runtime, spawn }
  }

  const request = (extra: Record<string, unknown> = {}) => ({
    kind: 'explicit' as const,
    worktree: 'id:wt-1',
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: X },
    presentation: 'background' as const,
    ...extra
  })
  const spawnedCommand = (spawn: ReturnType<typeof vi.fn>): string =>
    String(((spawn.mock.calls[0] as unknown[])[0] as { command?: string }).command).replaceAll(
      "'",
      ''
    )

  it('an attributed caller ensure puts --model/--effort before --resume and records pref_source launch', async () => {
    db = new OrchestrationDb(':memory:')
    seedAttributedSession({ model: 'opus' })
    await writeManifest({ effort: 'high' })
    const { runtime, spawn } = freshRuntime()
    const created = await runtime.ensureAgentSession(request())
    const command = spawnedCommand(spawn)
    expect(command).toMatch(/--model opus --effort high --resume /)
    const row = db.newestLaunchForPane(HOST_ID, created.terminal.paneKey as string)
    expect(row?.evidence).toBe('caller_resume')
    expect(row?.pref_model).toBe('opus')
    expect(row?.pref_effort).toBe('high')
    expect(row?.pref_source).toBe('launch')
  })

  it('an explicit request launchPreferences wins over the resolved pins', async () => {
    db = new OrchestrationDb(':memory:')
    seedAttributedSession({ model: 'opus', effort: 'high' })
    const { runtime, spawn } = freshRuntime()
    const created = await runtime.ensureAgentSession(
      request({ launchPreferences: { model: 'sonnet' } })
    )
    const command = spawnedCommand(spawn)
    expect(command).toContain('--model sonnet')
    expect(command).not.toContain('opus')
    const row = db.newestLaunchForPane(HOST_ID, created.terminal.paneKey as string)
    expect(row?.pref_model).toBe('sonnet')
    expect(row?.pref_effort).toBeNull()
  })

  it('an unattributed session is byte-identical: no pins in the command, NULL pref columns', async () => {
    db = new OrchestrationDb(':memory:')
    await writeManifest({ model: 'opus', effort: 'high' })
    const { runtime, spawn } = freshRuntime()
    const created = await runtime.ensureAgentSession(request())
    const command = spawnedCommand(spawn)
    expect(command).not.toContain('--model')
    expect(command).not.toContain('--effort')
    expect(command).toContain(`--resume ${X}`)
    const row = db.newestLaunchForPane(HOST_ID, created.terminal.paneKey as string)
    expect(row?.pref_model).toBeNull()
    expect(row?.pref_effort).toBeNull()
    expect(row?.pref_source).toBeNull()
  })

  it('an internal host-restore ensure resolves nothing, even for an attributed session', async () => {
    db = new OrchestrationDb(':memory:')
    seedAttributedSession({ model: 'opus', effort: 'high' })
    const { runtime, spawn } = freshRuntime()
    const ticket = runtime.mintRestoreTicket({
      predecessorPaneKey: null,
      sessionId: X,
      executionHostId: HOST_ID,
      launchGeneration: runtime.getLaunchGenerationId()
    })
    const created = await runtime.ensureAgentSession(
      request(),
      {},
      {
        restoreProvenance: { kind: 'host-restore', ticket, evidence: 'host_restore' }
      }
    )
    const command = spawnedCommand(spawn)
    expect(command).not.toContain('--model')
    expect(command).not.toContain('--effort')
    const row = db.newestLaunchForPane(HOST_ID, created.terminal.paneKey as string)
    expect(row?.pref_model).toBeNull()
    expect(row?.pref_effort).toBeNull()
  })

  it('the R266 host-integrity refusal throws before any R289 resolution', async () => {
    db = new OrchestrationDb(':memory:')
    seedAttributedSession({ model: 'opus' })
    const { runtime, spawn } = freshRuntime()
    const lookup = vi.spyOn(db, 'newestHostScopedLaunchForSession')
    configureHostIntegrityForTests({ probe: async () => ({ level: 'high', detail: 'r266 order' }) })
    try {
      await expect(runtime.ensureAgentSession(request())).rejects.toMatchObject({
        code: 'host_elevated_refused'
      })
    } finally {
      resetHostIntegrityForTests()
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
