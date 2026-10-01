// R326 (train 10z.7): the manual "Restart daemon" holds the pty exits of the ptys it kills and
// announces them through R315's session-loss handler after the new provider is bound. This suite
// pins the hold module and its pty.ts wiring: held exits are recorded and NOT forwarded, `hasPty`
// answers null while held, local `pty:spawn` waits for the hold (counted in flight so the
// announcement skips it), and a failed restart releases the held ids with today's exits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync as realMkdirSync } from 'node:fs'
import { join } from 'node:path'
import type * as Wsl from '../wsl'

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

const HOST_ID = 'local'
const SESSION_ID = 'sess-crash-gate'
const FIRST_INCARNATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SECOND_INCARNATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

describe('R326: manual restart hold (pty.ts wiring)', () => {
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
    options: { gateSpawn?: Promise<void> } = {}
  ) {
    let exitListener:
      | ((payload: { id: string; code: number; incarnationId?: string }) => void)
      | null = null
    let next = 0
    const alive = new Set<string>()
    return {
      alive,
      routesFreshSpawnsToLocalProvider: true,
      spawn: vi.fn(async () => {
        await options.gateSpawn
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
          exitListener = callback
          return () => {
            exitListener = null
          }
        }
      ),
      onSessionsLostToDaemonDeath: vi.fn(() => () => {}),
      hasPty: vi.fn((id: string) => alive.has(id)),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      fireExit: (payload: { id: string; code: number; incarnationId?: string }) =>
        exitListener?.(payload)
    }
  }

  function setUp(
    spawns: { id: string; incarnationId: string }[],
    options: { gateSpawn?: Promise<void> } = {}
  ) {
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

  const TAB = '99999999-9999-4999-8999-cccccccc0c01'
  const LEAF = '99999999-9999-4999-8999-cccccccc0c02'
  const channelsSent = (): string[] =>
    mainWindow.webContents.send.mock.calls.map((call) => call[0] as string)
  const exitsSent = (): string[] =>
    mainWindow.webContents.send.mock.calls
      .filter((call) => call[0] === 'pty:exit')
      .map((call) => (call[1] as { id: string }).id)

  afterEach(async () => {
    // Why: a test that leaves the hold open must not fence the next test's spawns.
    await releaseRestartExitHold({ mode: 'exit' })
  })

  describe('exit listener', () => {
    it('records a held id exit without forwarding it (no renderer pty:exit, no main exit semantics) and forwards an unheld id', () => {
      const { runtime, provider } = setUp([])
      const onPtyExit = vi.spyOn(runtime, 'onPtyExit')
      beginRestartExitHold(['held-1'])

      provider.fireExit({ id: 'held-1', code: -1, incarnationId: FIRST_INCARNATION })

      expect(exitsSent()).toEqual([])
      expect(onPtyExit).not.toHaveBeenCalled()

      provider.fireExit({ id: 'other-1', code: 0 })
      expect(exitsSent()).toEqual(['other-1'])
    })

    it('forwards the same id normally once the hold is released', async () => {
      const { provider } = setUp([])
      beginRestartExitHold(['held-1'])
      await releaseRestartExitHold({ mode: 'exit' })
      mainWindow.webContents.send.mockClear()

      provider.fireExit({ id: 'held-1', code: 0 })

      expect(exitsSent()).toEqual(['held-1'])
    })
  })

  describe('pty:hasPty', () => {
    it('is null for a held id even when the (old) provider would say an authoritative false, and false again after release', async () => {
      setUp([])
      const hasPty = handlers.get('pty:hasPty')!
      expect(await hasPty(mainWindowIpcEvent, { id: 'held-1' })).toBe(false)

      beginRestartExitHold(['held-1'])
      expect(await hasPty(mainWindowIpcEvent, { id: 'held-1' })).toBeNull()
      expect(await hasPty(mainWindowIpcEvent, { id: 'other-1' })).toBe(false)

      await releaseRestartExitHold({ mode: 'exit' })
      expect(await hasPty(mainWindowIpcEvent, { id: 'held-1' })).toBe(false)
    })
  })

  describe('announce', () => {
    it('sends the sessions-lost notice with the shared epoch BEFORE main clears pane state, writes no second audit row, and never sends pty:exit', async () => {
      const { runtime, db, provider, auditSpy } = setUp([
        { id: 'pty-held', incarnationId: FIRST_INCARNATION }
      ])
      const paneKey = makePaneKey(TAB, LEAF)
      seedRegisteredChair(db, paneKey)
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      expect(getPaneKeyForPtyId('pty-held')).toBe(paneKey)
      const onPtyExit = vi.spyOn(runtime, 'onPtyExit')
      const clearsBefore = clearAgentHookPaneStateMock.mock.calls.length

      // The restart: audit at step 1, hold, the old adapter's synthetic exit, then bind the new provider.
      auditSpy(['pty-held'])
      expect(auditSpy).toHaveBeenCalledTimes(1)
      auditSpy.mockClear()
      beginRestartExitHold(['pty-held'])
      provider.fireExit({ id: 'pty-held', code: -1, incarnationId: FIRST_INCARNATION })
      expect(onPtyExit).not.toHaveBeenCalled()
      swapProvider(createProvider(runtime, []))
      await releaseRestartExitHold({ mode: 'announce', epoch: 4242 })

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:sessionsLostToDaemonDeath', {
        epoch: 4242,
        sessions: [{ id: 'pty-held', paneKey, reanchor: false }]
      })
      expect(exitsSent()).toEqual([])
      expect(auditSpy).not.toHaveBeenCalled()
      expect(db.newestDaemonDeathOrRebindVerbForPane(paneKey, HOST_ID)).toBe('daemon_died')
      expect(onPtyExit).toHaveBeenCalledWith('pty-held', -1, FIRST_INCARNATION)
      const sendIndex = mainWindow.webContents.send.mock.calls.findIndex(
        ([channel]) => channel === 'pty:sessionsLostToDaemonDeath'
      )
      const clearIndex = clearAgentHookPaneStateMock.mock.calls.findIndex(
        ([key], index) => index >= clearsBefore && key === paneKey
      )
      expect(clearIndex).toBeGreaterThanOrEqual(0)
      expect(mainWindow.webContents.send.mock.invocationCallOrder[sendIndex]).toBeLessThan(
        clearAgentHookPaneStateMock.mock.invocationCallOrder[clearIndex]!
      )
    })

    it('a second release after the announcement is a no-op (nothing re-announced)', async () => {
      const { runtime, provider } = setUp([{ id: 'pty-held', incarnationId: FIRST_INCARNATION }])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      beginRestartExitHold(['pty-held'])
      provider.fireExit({ id: 'pty-held', code: -1, incarnationId: FIRST_INCARNATION })
      swapProvider(createProvider(runtime, []))
      await releaseRestartExitHold({ mode: 'announce', epoch: 1 })
      mainWindow.webContents.send.mockClear()

      await releaseRestartExitHold({ mode: 'announce', epoch: 2 })
      await releaseRestartExitHold({ mode: 'exit' })

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    })
  })

  describe('exit mode (failed restart)', () => {
    it("gives each held current id today's exit (renderer pty:exit + main semantics), skips a spawn-in-flight id, and never notifies", async () => {
      const { runtime, provider } = setUp([{ id: 'pty-a', incarnationId: FIRST_INCARNATION }])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      const onPtyExit = vi.spyOn(runtime, 'onPtyExit')

      beginRestartExitHold(['pty-a', 'pty-b'])
      provider.fireExit({ id: 'pty-a', code: -1, incarnationId: FIRST_INCARNATION })
      provider.fireExit({ id: 'pty-b', code: -1 })
      // A reveal re-attach of pty-b is mid-flight (fenced on the hold).
      const spawning = handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-b'))
      // Why a macrotask: the handler reaches the fence after its own awaits.
      await new Promise((resolve) => setTimeout(resolve, 20))

      await releaseRestartExitHold({ mode: 'exit' })

      expect(exitsSent()).toEqual(['pty-a'])
      expect(onPtyExit).toHaveBeenCalledTimes(1)
      expect(onPtyExit).toHaveBeenCalledWith('pty-a', -1, FIRST_INCARNATION)
      expect(channelsSent()).not.toContain('pty:sessionsLostToDaemonDeath')
      await Promise.resolve(spawning).catch(() => {})
    })
  })

  describe('pty:spawn fence', () => {
    it('a local spawn issued while held does not reach any provider until the hold settles, then lands on the NEW provider; the old provider never spawns', async () => {
      const { runtime, provider: oldProvider } = setUp([
        { id: 'pty-held', incarnationId: FIRST_INCARNATION }
      ])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      oldProvider.spawn.mockClear()
      beginRestartExitHold(['pty-held'])
      oldProvider.fireExit({ id: 'pty-held', code: -1, incarnationId: FIRST_INCARNATION })

      const spawning = handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-held'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      // Fenced: neither provider has been asked to spawn while the hold is open.
      expect(oldProvider.spawn).not.toHaveBeenCalled()

      const newProvider = createProvider(runtime, [
        { id: 'pty-held', incarnationId: SECOND_INCARNATION }
      ])
      swapProvider(newProvider)
      await releaseRestartExitHold({ mode: 'announce', epoch: 77 })
      await spawning

      expect(newProvider.spawn).toHaveBeenCalledTimes(1)
      expect(oldProvider.spawn).not.toHaveBeenCalled()
    })

    it('the fenced same-id spawn is counted in flight at announce, so the announcement neither notifies nor exits that id', async () => {
      const { runtime, provider: oldProvider } = setUp([
        { id: 'pty-held', incarnationId: FIRST_INCARNATION }
      ])
      await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(TAB, LEAF))
      const onPtyExit = vi.spyOn(runtime, 'onPtyExit')
      beginRestartExitHold(['pty-held'])
      oldProvider.fireExit({ id: 'pty-held', code: -1, incarnationId: FIRST_INCARNATION })
      const spawning = handlers.get('pty:spawn')!(mainWindowIpcEvent, sessionSpawnArgs('pty-held'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      const newProvider = createProvider(runtime, [
        { id: 'pty-held', incarnationId: SECOND_INCARNATION }
      ])
      swapProvider(newProvider)

      await releaseRestartExitHold({ mode: 'announce', epoch: 78 })
      await spawning

      expect(channelsSent()).not.toContain('pty:sessionsLostToDaemonDeath')
      expect(onPtyExit).not.toHaveBeenCalledWith('pty-held', -1, FIRST_INCARNATION)
      expect(exitsSent()).toEqual([])
    })

    it('an SSH spawn (connectionId) is not fenced by the local hold', async () => {
      setUp([])
      beginRestartExitHold(['pty-held'])
      const result = handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24,
        connectionId: 'ssh-conn-1'
      })
      const outcome = await Promise.race([
        Promise.resolve(result).then(
          () => 'settled',
          () => 'settled'
        ),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 200))
      ])

      expect(outcome).toBe('settled')
    })
  })
})
