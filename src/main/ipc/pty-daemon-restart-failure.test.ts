// FX-3 (train 10z.8): a restart that fails before the provider swap hands its held ids back as an
// unannounced crash instead of closing their panes; the reinstated adapter then recovers them (R315).
// Copies the kill-paths harness; the provider mock also captures its sessions-lost listener.
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
  closeRestartSpawnFence,
  _setRestartTimeoutsForTest,
  getPaneKeyForPtyId,
  rebindLocalProviderListeners,
  registerPtyHandlers,
  releaseRestartExitHold,
  restorePtyIncarnation,
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

type LostSession = { id: string; incarnationId?: string; auditWritten?: true }

const HOST_ID = 'local'
const SESSION_ID = 'sess-crash-gate'
const FIRST_INCARNATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SECOND_INCARNATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

describe('FX-3: failed restart hands casualties back (pty.ts wiring)', () => {
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
    const lostListeners = new Set<(event: { epoch: number; sessions: LostSession[] }) => void>()
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
      onSessionsLostToDaemonDeath: vi.fn(
        (callback: (event: { epoch: number; sessions: LostSession[] }) => void) => {
          lostListeners.add(callback)
          return () => {
            lostListeners.delete(callback)
          }
        }
      ),
      hasPty: vi.fn((id: string) => alive.has(id)),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      fireLost: (event: { epoch: number; sessions: LostSession[] }) => {
        for (const listener of lostListeners) {
          listener(event)
        }
      },
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

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve()
    }
  }
  const second = (value: string): string => value.replace('cccc', 'eeee').replace('dddd', 'ffff')

  // The failed restart's synchronous block: hold, the fanout's exit, then the handback release.
  async function handBack(
    provider: ReturnType<typeof createProvider>,
    ids: string[],
    adopt: (
      held: { id: string; incarnationId?: string }[]
    ) => { id: string; incarnationId?: string }[]
  ): Promise<void> {
    beginRestartExitHold(ids)
    for (const id of ids) {
      provider.fireExit({ id, code: -1, incarnationId: FIRST_INCARNATION })
    }
    await releaseRestartExitHold({ mode: 'handback', adopt })
  }

  describe('FX-3: handback (T14-T18)', () => {
    it('T14: handback keeps the pane alive: no pty:exit, no main exit state, adopt gets the id with its incarnation, hasPty is null until settle', async () => {
      const { provider } = setUp([{ id: 'pty-c', incarnationId: FIRST_INCARNATION }])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      clearAgentHookPaneStateMock.mockClear()
      const adopt = vi.fn((_held: { id: string; incarnationId?: string }[]) => [])
      let duringRelease: unknown

      await handBack(provider, ['pty-c'], (held) => {
        duringRelease = handlers.get('pty:hasPty')!(mainWindowIpcEvent, { id: 'pty-c' })
        return adopt(held)
      })

      expect(adopt).toHaveBeenCalledWith([{ id: 'pty-c', incarnationId: FIRST_INCARNATION }])
      expect(exitsSent()).toEqual([])
      expect(clearAgentHookPaneStateMock).not.toHaveBeenCalled()
      expect(await duringRelease).toBeNull()
      expect(await handlers.get('pty:hasPty')!(mainWindowIpcEvent, { id: 'pty-c' })).not.toBeNull()
      expect(breadcrumbData('daemon_restart_hold_handed_back')).toMatchObject({
        count: 1,
        adopted: 1,
        exited: 0
      })
    })

    it.each([
      ['queueMicrotask', (fn: () => void) => queueMicrotask(fn)],
      ['setTimeout 0', (fn: () => void) => void setTimeout(fn, 0)]
    ])(
      'O3 synchrony: an exit queued (%s) before the handback release never reaches the renderer before adopt',
      async (_label, queueExit) => {
        const { provider } = setUp([{ id: 'pty-c', incarnationId: FIRST_INCARNATION }])
        await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
        const adopted: string[] = []
        let exitsInsideAdopt: string[] | undefined
        let queuedExitFired = false
        beginRestartExitHold(['pty-c'])
        provider.fireExit({ id: 'pty-c', code: -1, incarnationId: FIRST_INCARNATION })
        queueExit(() => {
          queuedExitFired = true
          provider.fireExit({ id: 'pty-c', code: -1, incarnationId: FIRST_INCARNATION })
        })

        await releaseRestartExitHold({
          mode: 'handback',
          adopt: (held) => {
            exitsInsideAdopt = exitsSent()
            adopted.push(...held.map(({ id }) => id))
            return []
          }
        })
        await tick()

        expect(exitsInsideAdopt).toEqual([])
        expect(adopted).toEqual(['pty-c'])
        // Positive control: the queued exit did fire, so the inside-adopt check is not vacuous. Where a post-settle exit is routed is not pinned here.
        expect(queuedExitFired).toBe(true)
      }
    )

    it('T14 control: exit mode, the shape 10z.7 shipped, gives the pane its renderer exit', async () => {
      const { provider } = setUp([{ id: 'pty-c', incarnationId: FIRST_INCARNATION }])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      beginRestartExitHold(['pty-c'])
      provider.fireExit({ id: 'pty-c', code: -1, incarnationId: FIRST_INCARNATION })

      await releaseRestartExitHold({ mode: 'exit' })

      expect(exitsSent()).toEqual(['pty-c'])
    })

    it('T15: the adapter-announced event (auditWritten) sends the notice before the main exit and writes no second audit row', async () => {
      const { provider, auditSpy } = setUp([{ id: 'pty-c', incarnationId: FIRST_INCARNATION }])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      await handBack(provider, ['pty-c'], () => [])
      clearAgentHookPaneStateMock.mockClear()
      mainWindow.webContents.send.mockClear()

      provider.fireLost({
        epoch: 5,
        sessions: [{ id: 'pty-c', incarnationId: FIRST_INCARNATION, auditWritten: true }]
      })
      await vi.waitFor(() => expect(noticesSent()).toHaveLength(1))

      expect(noticesSent()[0]).toMatchObject({ epoch: 5, sessions: [{ id: 'pty-c' }] })
      expect(auditSpy).not.toHaveBeenCalled()
      expect(exitsSent()).toEqual([])
      const sendOrder = mainWindow.webContents.send.mock.invocationCallOrder[0]!
      expect(sendOrder).toBeLessThan(clearAgentHookPaneStateMock.mock.invocationCallOrder[0]!)
    })

    it("T16: ids the adapter declines get today's exit inside the handback block; adopted ids do not", async () => {
      const { provider } = setUp([
        { id: 'pty-c', incarnationId: FIRST_INCARNATION },
        { id: 'pty-d', incarnationId: FIRST_INCARNATION }
      ])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(second(TAB), second(LEAF)))

      await handBack(provider, ['pty-c', 'pty-d'], (held) =>
        held.filter(({ id }) => id === 'pty-d')
      )

      expect(exitsSent()).toEqual(['pty-d'])
      expect(breadcrumbData('daemon_restart_hold_handed_back')).toMatchObject({
        count: 2,
        adopted: 1,
        exited: 1
      })
    })

    it('T17: a reveal-first same-id spawn is served once; the late event is neither noticed nor exited', async () => {
      const gate = Promise.withResolvers<void>()
      const { provider } = setUp(
        [
          { id: 'pty-c', incarnationId: FIRST_INCARNATION },
          { id: 'pty-c', incarnationId: SECOND_INCARNATION }
        ],
        { gateFor: (callIndex) => (callIndex === 1 ? gate.promise : undefined) }
      )
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      await handBack(provider, ['pty-c'], () => [])
      expect(exitsSent()).toEqual([])
      mainWindow.webContents.send.mockClear()

      const reveal = Promise.resolve(
        handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-c'))
      )
      await flush()
      provider.fireLost({
        epoch: 6,
        sessions: [{ id: 'pty-c', incarnationId: FIRST_INCARNATION, auditWritten: true }]
      })
      await tick(60)
      expect(noticesSent()).toEqual([])
      expect(exitsSent()).toEqual([])

      gate.resolve()
      await reveal

      expect(provider.spawn).toHaveBeenCalledTimes(2)
      expect(noticesSent()).toEqual([])
      expect(exitsSent()).toEqual([])
    })

    it('T18: an event from the first recovery that lands after the id moved to a newer incarnation is stale and skipped', async () => {
      const { provider } = setUp([{ id: 'pty-c', incarnationId: FIRST_INCARNATION }])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      await handBack(provider, ['pty-c'], () => [])
      expect(exitsSent()).toEqual([])
      mainWindow.webContents.send.mockClear()
      restorePtyIncarnation('pty-c', SECOND_INCARNATION)

      provider.fireLost({
        epoch: 7,
        sessions: [{ id: 'pty-c', incarnationId: FIRST_INCARNATION, auditWritten: true }]
      })
      await tick(60)

      expect(noticesSent()).toEqual([])
      expect(exitsSent()).toEqual([])
      expect(breadcrumbData('daemon_sessions_lost')).toMatchObject({ count: 0, stale: 1 })
    })
  })

  describe('FX-3 (a): the spawn fence outlasts the longest legitimate restart', () => {
    it('a spawn waiting through a 31 s restart is served, not rejected', async () => {
      setUp([{ id: 'pty-w', incarnationId: FIRST_INCARNATION }])
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      let outcome: string
      try {
        closeRestartSpawnFence()
        const spawning = Promise.resolve(
          handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-w'))
        ).then(
          () => 'served',
          (error: Error) => error.message
        )
        await vi.advanceTimersByTimeAsync(31_000)
        await releaseRestartExitHold({ mode: 'exit' })
        vi.useRealTimers()
        outcome = await spawning
      } finally {
        vi.useRealTimers()
      }

      expect(outcome).toBe('served')
      expect(breadcrumbNames()).not.toContain('daemon_restart_spawn_fence_timeout')
    })

    it('the fence bound is derived from, and exceeds, predecessor wait + quiesce + step 4', async () => {
      const bounds = await import('../daemon/restart-duration-bounds')

      expect(bounds.RESTART_SPAWN_FENCE_MS).toBeGreaterThan(
        bounds.DAEMON_RPC_SHUTDOWN_PROCESS_EXIT_WAIT_MS +
          bounds.RESTART_RESPAWN_QUIESCE_MS +
          bounds.DAEMON_STARTUP_MS
      )
      expect(Number.isFinite(bounds.RESTART_SPAWN_FENCE_MS)).toBe(true)
    })
  })
})
