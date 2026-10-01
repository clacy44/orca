// R315 (T4): a daemon CRASH now writes the `daemon_died` audit rows that arm the post-spawn
// respawn gate (pty.ts), so a SELF_RESUME(caller) relaunch into the lost pane refreshes the
// registered row's handle/incarnation and writes the resolving `rebind`. Without the audit
// (today's behaviour after a crash) the gate never fires. Real OrcaRuntimeService, real in-memory
// OrchestrationDb, real admission and the real audit writer; only the provider is a double.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync as realMkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import type * as Wsl from '../wsl'
import type { PtySessionsLostToDaemonDeathEvent } from '../providers/types'

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
  getPaneKeyForPtyId,
  rebindLocalProviderListeners,
  registerPtyHandlers,
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

describe('R315: daemon crash arms the post-spawn respawn gate', () => {
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

  // A daemon-backed provider double: spawn hands out ptyIds in order (each with its own
  // incarnation), and the double can announce "sessions lost to daemon death" like the adapter.
  function createCrashableProvider(
    runtime: OrcaRuntimeService,
    spawns: { id: string; incarnationId: string }[]
  ) {
    let lostListener: ((event: PtySessionsLostToDaemonDeathEvent) => void) | null = null
    let next = 0
    return {
      routesFreshSpawnsToLocalProvider: true,
      spawn: vi.fn(async () => {
        const planned = spawns[next++]!
        runtime.preAllocateHandleForPty(planned.id)
        runtime.onPtySpawned(planned.id, planned.incarnationId)
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
      onExit: vi.fn(() => () => {}),
      onSessionsLostToDaemonDeath: vi.fn(
        (callback: (event: PtySessionsLostToDaemonDeathEvent) => void) => {
          lostListener = callback
          return () => {
            lostListener = null
          }
        }
      ),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      announceLost: (event: PtySessionsLostToDaemonDeathEvent) => lostListener?.(event)
    }
  }

  function setUp(spawns: { id: string; incarnationId: string }[]) {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.getOrchestrationDb = () => db
    registerPtyHandlers(mainWindow as never, runtime)
    const provider = createCrashableProvider(runtime, spawns)
    setLocalPtyProvider(provider as never)
    rebindLocalProviderListeners()
    // Mirrors index.ts: the SAME writer index.ts registers for the restart fanout.
    setDaemonDiedFanoutHandler((ptyIds) =>
      writeDaemonDiedAuditRows({ db, hostId: HOST_ID, ptyIds, paneKeyOf: getPaneKeyForPtyId })
    )
    return { runtime, db, provider }
  }

  function seedRegisteredChair(db: OrchestrationDb, paneKey: string): string {
    const result = db.upsertAgentByPaneSuffix({
      displayName: `agent-${paneKey}`,
      role: null,
      hostId: HOST_ID,
      paneKey,
      terminalHandle: 'term_dead_old',
      processIncarnation: 'pty-old:inc-old',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_dead_old',
      originHostId: HOST_ID
    })
    if (result.outcome !== 'created') {
      throw new Error(`seed: expected 'created', got ${result.outcome}`)
    }
    const seeded = db.recordLaunch({
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: SESSION_ID,
      launchGeneration: 'gen-crash-gate',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    if (!seeded.ok) {
      throw new Error('seed launch row failed')
    }
    return result.agent.id
  }

  const spawnArgs = (tabId: string, leafId: string) => ({
    cols: 80,
    rows: 24,
    cwd: '/tmp/crash-gate',
    command: `claude --resume ${SESSION_ID}`,
    launchAgent: 'claude',
    worktreeId: 'repo-1::/tmp/crash-gate',
    tabId,
    leafId,
    // Why: the renderer stamps the pane key into the spawn env; main maps ptyId -> paneKey from it.
    env: { ORCA_PANE_KEY: makePaneKey(tabId, leafId) }
  })

  // Why a poll: the handler reads the chairs manifest (real async file I/O) before it notifies.
  async function untilLossHandled(): Promise<void> {
    await vi.waitFor(() => {
      const channels = mainWindow.webContents.send.mock.calls.map((call) => call[0])
      expect(channels).toContain('pty:sessionsLostToDaemonDeath')
    })
  }

  it('after a crash the audit arms the gate: SELF_RESUME into the lost pane refreshes the registered row and writes rebind', async () => {
    const { runtime, db, provider } = setUp([
      { id: 'pty-before-crash', incarnationId: FIRST_INCARNATION },
      { id: 'pty-after-crash', incarnationId: SECOND_INCARNATION }
    ])
    const tabId = '99999999-9999-4999-8999-aaaaaaaa0a01'
    const leafId = '99999999-9999-4999-8999-aaaaaaaa0a02'
    const paneKey = makePaneKey(tabId, leafId)
    const agentId = seedRegisteredChair(db, paneKey)
    await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(tabId, leafId))
    // Nothing has died yet: the gate has nothing to act on and the row is untouched.
    expect(db.newestDaemonDeathOrRebindVerbForPane(paneKey, HOST_ID)).toBeNull()
    expect(db.getAgentByIdIncludingTombstoned(agentId)?.terminal_handle).toBe('term_dead_old')

    expect(getPaneKeyForPtyId('pty-before-crash')).toBe(paneKey)
    const clearsBefore = clearAgentHookPaneStateMock.mock.calls.length
    // The daemon crashes; the adapter announces the casualty after its authoritative inventory.
    provider.announceLost({
      epoch: 1,
      sessions: [{ id: 'pty-before-crash', incarnationId: FIRST_INCARNATION }]
    })
    await untilLossHandled()
    // F1: the renderer hears of the loss BEFORE main clears the pane's hook state (which would
    // otherwise drop the live status the capture annotates).
    const sendOrder = mainWindow.webContents.send.mock.calls.findIndex(
      ([channel]) => channel === 'pty:sessionsLostToDaemonDeath'
    )
    const clearIndex = clearAgentHookPaneStateMock.mock.calls.findIndex(
      ([key], index) => index >= clearsBefore && key === paneKey
    )
    expect(clearIndex).toBeGreaterThanOrEqual(0)
    expect(mainWindow.webContents.send.mock.invocationCallOrder[sendOrder]).toBeLessThan(
      clearAgentHookPaneStateMock.mock.invocationCallOrder[clearIndex]!
    )
    expect(db.newestDaemonDeathOrRebindVerbForPane(paneKey, HOST_ID)).toBe('daemon_died')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'pty:sessionsLostToDaemonDeath',
      expect.objectContaining({ epoch: 1 })
    )
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())

    // The pane's own cold restore relaunches `claude --resume <same id>` into the same pane.
    await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(tabId, leafId))

    const expectedHandle = runtime.resolveExistingTerminalHandleForPty('pty-after-crash')
    expect(expectedHandle).not.toBeNull()
    const row = db.getAgentByIdIncludingTombstoned(agentId)
    expect(row?.terminal_handle).toBe(expectedHandle)
    expect(row?.process_incarnation).toBe(`pty-after-crash:${SECOND_INCARNATION}`)
    expect(db.newestDaemonDeathOrRebindVerbForPane(paneKey, HOST_ID)).toBe('rebind')
    const rawDb = (db as unknown as { db: Database.Database }).db
    expect(
      rawDb
        .prepare(
          `SELECT * FROM agent_audit WHERE actor_pane_key = ? AND verb = 'rebind' AND outcome = 'reminted'`
        )
        .all(paneKey)
    ).toHaveLength(1)
  })

  it('without the crash audit (today) the same relaunch never refreshes the registered row', async () => {
    const { db, provider } = setUp([
      { id: 'pty-before-crash', incarnationId: FIRST_INCARNATION },
      { id: 'pty-after-crash', incarnationId: SECOND_INCARNATION }
    ])
    // Before R315 nothing wrote a `daemon_died` row on a crash; model that by removing the writer.
    setDaemonDiedFanoutHandler(null)
    const tabId = '99999999-9999-4999-8999-bbbbbbbb0b01'
    const leafId = '99999999-9999-4999-8999-bbbbbbbb0b02'
    const paneKey = makePaneKey(tabId, leafId)
    const agentId = seedRegisteredChair(db, paneKey)
    await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(tabId, leafId))
    provider.announceLost({
      epoch: 1,
      sessions: [{ id: 'pty-before-crash', incarnationId: FIRST_INCARNATION }]
    })
    await untilLossHandled()
    expect(db.newestDaemonDeathOrRebindVerbForPane(paneKey, HOST_ID)).toBeNull()

    await handlers.get('pty:spawn')!(mainWindowIpcEvent, spawnArgs(tabId, leafId))

    const row = db.getAgentByIdIncludingTombstoned(agentId)
    expect(row?.terminal_handle).toBe('term_dead_old')
    expect(row?.process_incarnation).toBe('pty-old:inc-old')
    expect(db.newestDaemonDeathOrRebindVerbForPane(paneKey, HOST_ID)).toBeNull()
  })
})
