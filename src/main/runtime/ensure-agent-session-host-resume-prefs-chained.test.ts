/**
 * [S10-21d C2] The REAL-PATH chained proof for the Gate-3 defect: the restart sweep and
 * `chair-restore` both pass `launchPreferences` into `ensureAgentSession`'s REQUEST, but before
 * this brief's C1 fix (orca-runtime.ts's two `createTerminal` call sites inside
 * `ensureAgentSession`/`createAgentSession`), that field never reached `createTerminal`'s own
 * `opts.launchPreferences` — so every cold-restart HOST_RESUME/HOST_MINTED row was written with
 * NULL pref_model/pref_effort.
 *
 * What is REAL here, and what is faked (the one thing this file exists to answer precisely):
 *   REAL:  OrcaRuntimeService#ensureAgentSession -> #createTerminal -> RuntimePtyController#spawn
 *          (the production wrapper `registerPtyHandlers` installs in pty.ts, INCLUDING its
 *          `launchAdmissionBundle` call) -> `admitAgentLaunch` (agent-launch-admission.ts,
 *          `resolveHostResumeRecordLaunch`) -> `db.recordLaunch` (agent-launch-sessions.ts). The
 *          launch row is written by this production chain, never by the test.
 *   FAKED: only the lowest level under `RuntimePtyController#spawn` — the raw OS/node-pty
 *          process spawn, via `setLocalPtyProvider` (mirrors
 *          `pty-controller-host-resume-admission-threading.test.ts`'s own
 *          `installDaemonTestProvider`) — plus `OrcaRuntimeService#resolveTerminalWorkspaceLaunchScope`
 *          (workspace/worktree existence, orthogonal to launch admission; the same stub
 *          `restore-registered-agent-panes-real-createterminal.test.ts` (T2) and
 *          `restore-sweep-t11-end-to-end.test.ts` (T11) already treat as legitimate scaffolding
 *          — neither of THOSE files exercises real admission, since both bare-stub
 *          `runtime.setPtyController` directly, skipping pty.ts's wrapper entirely. This file is
 *          the first to combine T2/T11's real-`OrcaRuntimeService`-drives-`ensureAgentSession`
 *          shape with `pty-controller-host-resume-admission-threading.test.ts`'s
 *          real-admission wiring, so the row assertion below is the production admission code's
 *          own write, not a test double's.
 *
 * `requestChairRestore` (chair-restore.ts) is NOT additionally driven here: it requires a live
 * registered chair row, holder-generation bookkeeping, and mail-repoint fixtures on top of
 * everything this file already sets up, and its own `ensureAgentSession` call
 * (chair-restore.ts:~294-310) spreads `launchPreferences` into the SAME request field this file
 * proves reaches `createTerminal` — the seam under test (C1's fix site) is identical for both
 * callers, so a second full harness would re-prove the same fixed line, not a different one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync as realMkdirSync } from 'node:fs'
import type * as Wsl from '../wsl'
import { OrchestrationDb } from './orchestration/db'

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

const HOST_ID = 'local'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('S10-21d C2: ensureAgentSession(host-restore, launchPreferences) writes pref_* through the REAL admission chain', () => {
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
      })
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

  it('a host-restore ensureAgentSession request naming model+ultracode effort writes pref_model/pref_effort/pref_source=launch on the HOST_RESUME row the production admission chain records', async () => {
    db = new OrchestrationDb(':memory:')
    installDaemonTestProvider({
      spawn: vi.fn(async () => ({ id: 'pty-c2-chained', incarnationId: 'inc-c2-chained' })),
      // [S10-21d C2] `agentSessionEnsure`'s post-spawn `isLive` check (pty.ts's `isLive:` on
      // `agentSessionOwners.ensure`, mirrored from
      // `pty-controller-host-resume-admission-threading.test.ts`'s Case D1 override) reads this.
      listProcesses: vi.fn(async () => [{ id: 'pty-c2-chained', incarnationId: 'inc-c2-chained' }])
    })
    const runtime = buildRealRuntimeWithRealController()

    const sessionId = 'sess-c2-chained-ultracode'
    const ticket = runtime.mintRestoreTicket({
      // [S10-21d b3, DEC-2] null predecessor: the "unheld restore" shape
      // (agent-launch-admission-host-resume-adoption.test.ts's own negative 3), the simplest
      // host-resume admission that still classifies host_resume — no prior pane/row needed.
      predecessorPaneKey: null,
      sessionId,
      executionHostId: HOST_ID,
      launchGeneration: runtime.getLaunchGenerationId()
    })

    const created = await runtime.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: 'id:wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: sessionId },
        presentation: 'background',
        // The exact field this brief's C1 fix threads from `request` into `createTerminal`'s
        // `opts.launchPreferences` (orca-runtime.ts, `ensureAgentSession`, ~:28076-28089).
        launchPreferences: { model: 'opus', effort: 'ultracode' }
      },
      {},
      // Mirrors `chair-restore.ts`'s own `ensureAgentSession` call shape (~:294-310) and
      // `restore-registered-agent-panes.ts`'s (~:230): a redeemed in-process ticket, evidence
      // 'host_restore'.
      { restoreProvenance: { kind: 'host-restore', ticket, evidence: 'host_restore' } }
    )

    const paneKey = created.terminal.paneKey
    expect(paneKey).toBeTruthy()
    const row = db.newestLaunchForPane(HOST_ID, paneKey as string)
    expect(row?.session_id).toBe(sessionId)
    expect(row?.evidence).toBe('host_restore')
    expect(row?.pref_model).toBe('opus')
    expect(row?.pref_effort).toBe('ultracode')
    expect(row?.pref_source).toBe('launch')
  })
})
