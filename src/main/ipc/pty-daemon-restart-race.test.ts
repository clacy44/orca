// R326 repair (train 10z.7, F1): the manual restart's spawn fence, drain and ticket guard. The hold
// basics live in pty-daemon-restart-hold.test.ts, the pure state in
// pty-daemon-restart-hold-state.test.ts, the kill-path items in pty-daemon-restart-kill-paths.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync as realMkdirSync } from 'node:fs'
import { join } from 'node:path'
import type * as Wsl from '../wsl'

const { breadcrumbMock } = vi.hoisted(() => ({ breadcrumbMock: vi.fn() }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDurableCrashBreadcrumb: breadcrumbMock
}))

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
  // Why defined-but-undefined: the real OrcaRuntimeService guards BrowserWindow with `?.`; vitest throws on reading exports the mock omits.
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

// Why: this suite forces darwin on non-macOS hosts; isolate the PAM probe while preserving other child_process APIs.
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

// Why: the real ensure writes to process.resourcesPath (absent under vitest); env assembly only needs the returned dir path.
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
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  beginRestartExitHold,
  _setRestartTimeoutsForTest,
  awaitRestartSpawnDrain,
  closeRestartSpawnFence,
  getPaneKeyForPtyId,
  rebindLocalProviderListeners,
  registerPtyHandlers,
  releaseRestartExitHold,
  setLocalPtyProvider
} from './pty'
import { _resetHiddenRendererPtyDeliveryGateForTest } from './pty-hidden-delivery-gate'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { writeDaemonDiedAuditRows } from '../runtime/orchestration/daemon-died-audit'
import { setDaemonDiedFanoutHandler } from '../daemon/daemon-died-fanout-registry'
import { _resetWslCachesForTests } from '../wsl'
import { __resetShellStartupEnvCache } from '../pty/shell-startup-env'

function makeDisposable() {
  return { dispose: vi.fn() }
}

type GateOptions = {
  gateSpawn?: Promise<void>
  gateFor?: (callIndex: number) => Promise<void> | undefined
}

const HOST_ID = 'local'
const SESSION_ID = 'sess-crash-gate'
const FIRST_INCARNATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SECOND_INCARNATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

describe('R326 repair: restart race (pty.ts wiring)', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
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
  const mainWindowIpcEvent = { sender: mainWindow.webContents }
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    breadcrumbMock.mockReset()
    paneCounter += 1
    TAB = `99999999-9999-4999-8999-cccc${String(paneCounter).padStart(8, '0')}`
    LEAF = `99999999-9999-4999-8999-dddd${String(paneCounter).padStart(8, '0')}`
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: forced darwin makes the TCC login(1) wrapper rewrite every asserted argv; its own test below re-enables it.
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_CONFIG_DIR
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    delete process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    delete process.env.ORCA_PI_CODING_AGENT_DIR
    delete process.env.ORCA_CODEX_HOME
    delete process.env.ORCA_OMP_SOURCE_AGENT_DIR
    delete process.env.ORCA_OMP_CODING_AGENT_DIR
    delete process.env.ORCA_OMP_STATUS_EXTENSION
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    delete process.env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    delete process.env.ORCA_PRIME_AGENT_STATUS_EXTENSION
    handlers.clear()
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
    // Why: hidden-delivery gate state is module-level (PTY-keyed), so tests must not leak hidden bits across cases.
    _resetHiddenRendererPtyDeliveryGateForTest()
    __resetShellStartupEnvCache()

    // Why: mirror real Electron — ipcMain.handle throws on a duplicate channel, catching re-registration that forgot removeHandler.
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    })
    removeHandlerMock.mockImplementation((channel: string) => {
      handlers.delete(channel)
    })
    // Why: production gates PTY sends on pty:rendererDispatcherReady; model a live page by firing the handshake as soon as it registers.
    onMock.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'pty:rendererDispatcherReady') {
        listener(mainWindowIpcEvent)
        // Drain the handshake's empty flush so it can't later perturb send-timing assertions.
        if (vi.isFakeTimers()) {
          vi.advanceTimersByTime(0)
        }
      }
    })
    getPathMock.mockReturnValue('/tmp/orca-user-data')
    // Why: wrapper roots resolve from ORCA_USER_DATA_PATH; mirror the mocked userData so ZDOTDIR/wrapper assertions match.
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-user-data'
    // [S10-21a C3-v2, Ruling 34 Addendum 13] node:sqlite (OrchestrationDb) opens a REAL file at
    // this mocked userData path and bypasses the `fs` mock above entirely (native binding, not
    // the `fs` module) — real Electron auto-creates userData, so this mirrors that contract for
    // the handful of tests that construct a real `OrcaRuntimeService` and call
    // `getOrchestrationDb()` (admission's `getDb()`).
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
          // Why: bare shells no longer create ~/.omp; only a userData status path is set (#10196).
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
    setDaemonDiedFanoutHandler(null)
    _resetLocalPtyProviderStateForTest()
    _resetWslCachesForTests()
    setLocalPtyProvider(new LocalPtyProvider())
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    delete process.env.ORCA_USER_DATA_PATH
  })

  // A daemon-backed provider double. Each instance hands out its own ptyIds (with incarnations),
  // exposes the exit listener pty.ts bound, and answers hasPty from `alive`.
  function createProvider(
    runtime: OrcaRuntimeService,
    spawns: { id: string; incarnationId: string }[],
    options: GateOptions = {}
  ) {
    let calls = 0
    // Why a set: pty.ts's kill helper subscribes its own short-lived exit listener beside the bound one.
    const exitListeners = new Set<
      (payload: { id: string; code: number; incarnationId?: string }) => void
    >()
    let next = 0
    const alive = new Set<string>()
    return {
      alive,
      routesFreshSpawnsToLocalProvider: true,
      spawn: vi.fn(async () => {
        const callIndex = calls++
        await (options.gateFor ? options.gateFor(callIndex) : options.gateSpawn)
        const planned = spawns[next++]!
        runtime.preAllocateHandleForPty(planned.id)
        runtime.onPtySpawned(planned.id, planned.incarnationId)
        alive.add(planned.id)
        return planned
      }),
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
      onExit: vi.fn(
        (callback: (payload: { id: string; code: number; incarnationId?: string }) => void) => {
          exitListeners.add(callback)
          return () => {
            exitListeners.delete(callback)
          }
        }
      ),
      onSessionsLostToDaemonDeath: vi.fn(() => () => {}),
      hasPty: vi.fn((id: string) => alive.has(id)),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      fireExit: (payload: { id: string; code: number; incarnationId?: string }) => {
        for (const listener of exitListeners) {
          listener(payload)
        }
      }
    }
  }

  function setUp(spawns: { id: string; incarnationId: string }[], options: GateOptions = {}) {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.getOrchestrationDb = () => db
    registerPtyHandlers(mainWindow as never, runtime)
    const provider = createProvider(runtime, spawns, options)
    setLocalPtyProvider(provider as never)
    rebindLocalProviderListeners()
    const auditSpy = vi.fn((ptyIds: readonly string[]) =>
      writeDaemonDiedAuditRows({ db, hostId: HOST_ID, ptyIds, paneKeyOf: getPaneKeyForPtyId })
    )
    setDaemonDiedFanoutHandler(auditSpy)
    return { runtime, db, provider, auditSpy }
  }

  // Mirrors the restart's step 6 + 7: swap the provider, rebind the listeners to it.
  function swapProvider(provider: ReturnType<typeof createProvider>): void {
    setLocalPtyProvider(provider as never)
    rebindLocalProviderListeners()
  }

  const spawnArgs = (tabId: string, leafId: string) => ({
    cols: 80,
    rows: 24,
    cwd: '/tmp/restart-hold',
    command: `claude --resume ${SESSION_ID}`,
    launchAgent: 'claude',
    worktreeId: 'repo-1::/tmp/restart-hold',
    tabId,
    leafId,
    env: { ORCA_PANE_KEY: makePaneKey(tabId, leafId) }
  })

  const sessionSpawnArgs = (sessionId: string) => ({
    cols: 80,
    rows: 24,
    cwd: '/tmp/restart-hold',
    sessionId
  })

  function seedRegisteredChair(db: OrchestrationDb, paneKey: string): void {
    const result = db.upsertAgentByPaneSuffix({
      displayName: `agent-${paneKey}`,
      role: null,
      hostId: HOST_ID,
      paneKey,
      terminalHandle: 'term_old',
      processIncarnation: 'pty-old:inc-old',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: HOST_ID
    })
    if (result.outcome !== 'created') {
      throw new Error(`seed: expected 'created', got ${result.outcome}`)
    }
  }

  // Why per test: pane reservations are module state, so a stuck spawn must not poison the next test.
  let paneCounter = 0
  let TAB = ''
  let LEAF = ''
  const exitsSent = (): string[] =>
    mainWindow.webContents.send.mock.calls
      .filter((call) => call[0] === 'pty:exit')
      .map((call) => (call[1] as { id: string }).id)

  const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const noticesSent = (): { epoch: number; sessions: { id: string }[] }[] =>
    mainWindow.webContents.send.mock.calls
      .filter((call) => call[0] === 'pty:sessionsLostToDaemonDeath')
      .map((call) => call[1] as { epoch: number; sessions: { id: string }[] })
  const breadcrumbNames = (): string[] => breadcrumbMock.mock.calls.map((call) => call[0] as string)
  const breadcrumbData = (name: string): Record<string, unknown> | undefined =>
    breadcrumbMock.mock.calls.find((call) => call[0] === name)?.[1] as
      | Record<string, unknown>
      | undefined

  afterEach(async () => {
    // Why: a test that leaves a window open must not fence the next test's spawns.
    await releaseRestartExitHold({ mode: 'exit' })
    _setRestartTimeoutsForTest()
  })

  describe('F1: no spawn completes on a replaced adapter', () => {
    it('G1 P2: a spawn past the fence when the snapshot lands is rejected at completion and its session torn down', async () => {
      const gate = Promise.withResolvers<void>()
      const { runtime, provider: oldProvider } = setUp(
        [{ id: 'pty-late', incarnationId: FIRST_INCARNATION }],
        { gateSpawn: gate.promise }
      )
      const spawning = handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-late'))
      const outcome = Promise.resolve(spawning).then(
        () => 'resolved',
        (error: Error) => error.message
      )
      await vi.waitFor(() => expect(oldProvider.spawn).toHaveBeenCalledTimes(1))

      beginRestartExitHold([])
      const newProvider = createProvider(runtime, [])
      swapProvider(newProvider)
      await releaseRestartExitHold({ mode: 'announce', epoch: 501 })
      gate.resolve()

      await expect(outcome).resolves.toMatch(/restarted while this terminal was starting/)
      expect(oldProvider.shutdown).toHaveBeenCalledWith(
        'pty-late',
        expect.objectContaining({ immediate: true })
      )
      expect(newProvider.spawn).not.toHaveBeenCalled()
      expect(noticesSent()).toEqual([])
      expect(breadcrumbNames()).toContain('daemon_restart_spawn_superseded')
    })

    it('a spawn that completes BEFORE the snapshot is held, killed and announced (not rejected)', async () => {
      const {
        runtime,
        db,
        provider: oldProvider
      } = setUp([{ id: 'pty-held', incarnationId: FIRST_INCARNATION }])
      seedRegisteredChair(db, makePaneKey(TAB, LEAF))
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))

      closeRestartSpawnFence()
      await awaitRestartSpawnDrain()
      beginRestartExitHold([...oldProvider.alive])
      oldProvider.fireExit({ id: 'pty-held', code: -1, incarnationId: FIRST_INCARNATION })
      swapProvider(createProvider(runtime, []))
      await releaseRestartExitHold({ mode: 'announce', epoch: 502 })

      expect(noticesSent()).toEqual([
        { epoch: 502, sessions: [expect.objectContaining({ id: 'pty-held' })] }
      ])
      expect(exitsSent()).toEqual([])
    })

    it('second press during the relaunch burst: the relaunch that finishes before the snapshot is announced once by N+1, never spawned on P3', async () => {
      const {
        runtime,
        db,
        provider: p1
      } = setUp([{ id: 'pty-a', incarnationId: FIRST_INCARNATION }])
      const paneKey = makePaneKey(TAB, LEAF)
      seedRegisteredChair(db, paneKey)
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))

      // Restart N: pty-a is held and announced (epoch 701); the relaunch below lands on P2.
      closeRestartSpawnFence()
      await awaitRestartSpawnDrain()
      beginRestartExitHold([...p1.alive])
      p1.fireExit({ id: 'pty-a', code: -1, incarnationId: FIRST_INCARNATION })
      const gate = Promise.withResolvers<void>()
      const p2 = createProvider(runtime, [{ id: 'pty-a2', incarnationId: SECOND_INCARNATION }], {
        gateSpawn: gate.promise
      })
      swapProvider(p2)
      await releaseRestartExitHold({ mode: 'announce', epoch: 701 })
      expect(noticesSent().map((notice) => notice.epoch)).toEqual([701])

      // The relaunch passes the fence and is gated inside P2.spawn.
      const relaunch = handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      await vi.waitFor(() => expect(p2.spawn).toHaveBeenCalledTimes(1))

      // Restart N+1: the second press closes the fence; the drain waits for the relaunch.
      closeRestartSpawnFence()
      let drained = false
      const draining = awaitRestartSpawnDrain().then(() => {
        drained = true
      })
      await tick()
      expect(drained).toBe(false)

      gate.resolve()
      await relaunch
      await draining
      expect(drained).toBe(true)
      expect([...p2.alive]).toEqual(['pty-a2'])

      beginRestartExitHold([...p2.alive])
      p2.fireExit({ id: 'pty-a2', code: -1, incarnationId: SECOND_INCARNATION })
      const p3 = createProvider(runtime, [])
      swapProvider(p3)
      await releaseRestartExitHold({ mode: 'announce', epoch: 702 })

      const notices = noticesSent()
      expect(notices.map((notice) => notice.epoch)).toEqual([701, 702])
      expect(notices[1]?.sessions.map((session) => session.id)).toEqual(['pty-a2'])
      expect(p3.spawn).not.toHaveBeenCalled()
      expect(exitsSent()).toEqual([])
    })

    it('a drain timeout writes its breadcrumb; the straggler is then rejected, torn down and not announced', async () => {
      _setRestartTimeoutsForTest({ drainMs: 20 })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const gate = Promise.withResolvers<void>()
      const { runtime, provider: p1 } = setUp(
        [{ id: 'pty-late', incarnationId: FIRST_INCARNATION }],
        { gateSpawn: gate.promise }
      )
      const outcome = Promise.resolve(
        handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-late'))
      ).then(
        () => 'resolved',
        (error: Error) => error.message
      )
      await vi.waitFor(() => expect(p1.spawn).toHaveBeenCalledTimes(1))

      closeRestartSpawnFence()
      await awaitRestartSpawnDrain()
      expect(breadcrumbData('daemon_restart_spawn_drain_timeout')).toEqual({ pending: 1 })
      beginRestartExitHold([])
      const p2 = createProvider(runtime, [])
      swapProvider(p2)
      await releaseRestartExitHold({ mode: 'announce', epoch: 601 })
      gate.resolve()

      await expect(outcome).resolves.toMatch(/restarted while this terminal was starting/)
      expect(p1.shutdown).toHaveBeenCalledWith('pty-late', expect.anything())
      expect(noticesSent()).toEqual([])
      expect(p2.spawn).not.toHaveBeenCalled()
    })

    it('a same-id reattach of a held id that times out in the drain is notified (not counted in flight) and its spawn rejects', async () => {
      _setRestartTimeoutsForTest({ drainMs: 20 })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const gate = Promise.withResolvers<void>()
      const {
        runtime,
        db,
        provider: p1
      } = setUp(
        [
          { id: 'pty-s', incarnationId: FIRST_INCARNATION },
          { id: 'pty-s', incarnationId: SECOND_INCARNATION }
        ],
        { gateFor: (call) => (call === 1 ? gate.promise : undefined) }
      )
      seedRegisteredChair(db, makePaneKey(TAB, LEAF))
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      const reattach = Promise.resolve(
        handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-s'))
      ).then(
        () => 'resolved',
        (error: Error) => error.message
      )
      await vi.waitFor(() => expect(p1.spawn).toHaveBeenCalledTimes(2))

      closeRestartSpawnFence()
      await awaitRestartSpawnDrain()
      beginRestartExitHold(['pty-s'])
      p1.fireExit({ id: 'pty-s', code: -1, incarnationId: FIRST_INCARNATION })
      swapProvider(createProvider(runtime, []))
      await releaseRestartExitHold({ mode: 'announce', epoch: 602 })
      gate.resolve()

      expect(noticesSent()).toEqual([
        { epoch: 602, sessions: [expect.objectContaining({ id: 'pty-s' })] }
      ])
      await expect(reattach).resolves.toMatch(/restarted while this terminal was starting/)
    })

    it('a spawn waiting at the fence re-checks after its window settles: a new window opened in the same tick still holds it', async () => {
      const { provider } = setUp([{ id: 'pty-w', incarnationId: FIRST_INCARNATION }])
      closeRestartSpawnFence()
      const spawning = Promise.resolve(
        handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-w'))
      ).catch(() => {})
      await tick()
      expect(provider.spawn).not.toHaveBeenCalled()

      void releaseRestartExitHold({ mode: 'exit' })
      beginRestartExitHold(['other'])
      await tick()
      expect(provider.spawn).not.toHaveBeenCalled()

      await releaseRestartExitHold({ mode: 'exit' })
      await spawning
      expect(provider.spawn).toHaveBeenCalledTimes(1)
    })

    it('a failure before the snapshot (fenced phase) releases the window so spawns proceed', async () => {
      const { provider } = setUp([{ id: 'pty-w', incarnationId: FIRST_INCARNATION }])
      closeRestartSpawnFence()
      const spawning = Promise.resolve(
        handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-w'))
      )
      await tick()
      expect(provider.spawn).not.toHaveBeenCalled()

      await releaseRestartExitHold({ mode: 'exit' })
      await spawning

      expect(provider.spawn).toHaveBeenCalledTimes(1)
    })

    it('an SSH spawn takes no ticket and is not fenced', async () => {
      setUp([])
      closeRestartSpawnFence()
      const outcome = await Promise.race([
        Promise.resolve(
          handlers.get('pty:spawn')!(mainWindowIpcEvent, {
            cols: 80,
            rows: 24,
            connectionId: 'ssh-1'
          })
        ).then(
          () => 'settled',
          () => 'settled'
        ),
        tick(200).then(() => 'blocked')
      ])
      expect(outcome).toBe('settled')
    })
  })
})
