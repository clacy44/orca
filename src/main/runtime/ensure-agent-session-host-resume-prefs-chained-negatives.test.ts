/**
 * [F5] NEGATIVE chained proofs for the R142b SAME_GEN_PTY_ABSENCE arm, split out of
 * ensure-agent-session-host-resume-prefs-chained.test.ts to stay under the 800-line test budget
 * — same real-admission harness verbatim (see that file's header for REAL vs FAKED; unchanged).
 * Both tests prove the arm REFUSES, holder intact — unlike that file's own positive (ADOPTS)
 * test. `mintRestoreTicket` is spied only to inject state at the real boundary between
 * "evidence gathered" (must stay dead, or DEC-3 never reaches SAME_GEN_PTY_ABSENCE) and "ticket
 * minted, admission still to come" — never to fake the evidence itself.
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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { _resetRestoreSweepLockForTest } from './restore-sweep-lock'
import type { ControllerInventory } from './orchestration/agent-process-identity'

const HOST_ID = 'local'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('S10-21d C2/F5: ensureAgentSession(host-restore) real admission chain — R142b NEGATIVE cases', () => {
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

  // [F5] Sibling (positive) case lives in ensure-agent-session-host-resume-prefs-chained.test.ts.
  describe('F5/R142b chained NEGATIVE: requestChairRestore -> real admission -> SAME_GEN_PTY_ABSENCE refusals', () => {
    let r142bTempHome: string | undefined
    let r142bOriginalHome: string | undefined

    beforeEach(() => {
      r142bOriginalHome = process.env.HOME
    })

    afterEach(async () => {
      // `db` itself is closed by the outer describe's own afterEach above — this block only
      // tears down what THIS describe added (temp HOME, sweep lock, Date.now spy).
      _resetRestoreSweepLockForTest()
      vi.restoreAllMocks()
      if (r142bTempHome) {
        await rm(r142bTempHome, { recursive: true, force: true })
        r142bTempHome = undefined
      }
      if (r142bOriginalHome !== undefined) {
        process.env.HOME = r142bOriginalHome
      }
    })

    const HOLDER_SESSION_ID = 'sess-r142b-negative'

    // [F5] NEGATIVE: a live pty found for the holder at admission time (a reconnect between mint
    // and the pane-lock re-check) refuses — pre-existing `restore_holder_same_generation_live`
    // behaviour (R142b, already on this branch before F1), unaffected by F1's launchSeq check.
    it('a connected pty found for the HOLDER at admission time refuses restore_holder_same_generation_live, holder left intact — through the real admission chain (GREEN: pre-existing R142b behaviour, unaffected by F1)', async () => {
      db = new OrchestrationDb(':memory:')
      r142bTempHome = await mkdtemp(join(tmpdir(), 'orca-r142b-chained-'))
      process.env.HOME = r142bTempHome
      const projectDir = join(r142bTempHome, '.claude', 'projects', 'proj')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, `${HOLDER_SESSION_ID}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
      )

      installDaemonTestProvider({
        spawn: vi.fn(async () => ({ id: 'pty-r142b-new', incarnationId: 'inc-r142b-new' })),
        listProcesses: vi.fn(async () => [{ id: 'pty-r142b-new', incarnationId: 'inc-r142b-new' }])
      })
      const runtime = buildRealRuntimeWithRealController()
      runtime.setLiveReportPanesForSessionCheck(() => [])

      const currentGen = runtime.getLaunchGenerationId()
      const holderPaneKey = 'tab-r142b-live:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      const holderPtyId = 'pty-r142b-holder-live'
      const holderIncarnationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      const created = db.upsertAgentByPaneSuffix({
        displayName: 'chair-r142b-live',
        role: null,
        hostId: HOST_ID,
        paneKey: holderPaneKey,
        terminalHandle: null,
        processIncarnation: `${holderPtyId}:${holderIncarnationId}`,
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
      const launched = db.recordLaunch({
        hostId: HOST_ID,
        paneKey: holderPaneKey,
        agentType: 'claude',
        sessionId: HOLDER_SESSION_ID,
        launchGeneration: currentGen,
        executionHostId: HOST_ID,
        evidence: 'host_launch'
      })
      if (!launched.ok) {
        throw new Error('fixture launch row failed')
      }

      const deadInventory: ControllerInventory = {
        allLivePtyIds: new Set(),
        terminalIdentityByPtyId: new Map()
      }
      vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)
      let holderReconnectedAfterMint = false
      vi.spyOn(runtime, 'findConnectedPtyForPane').mockImplementation((paneKey: string) =>
        holderReconnectedAfterMint && paneKey === holderPaneKey
          ? { paneKey, ptyId: 'pty-r142b-reconnected' }
          : undefined
      )
      const originalMintRestoreTicket = runtime.mintRestoreTicket.bind(runtime)
      vi.spyOn(runtime, 'mintRestoreTicket').mockImplementation((payload) => {
        const ticket = originalMintRestoreTicket(payload)
        // The reconnect happens strictly AFTER the ticket is minted (evidence already fixed as
        // dead) and BEFORE the admission pane-lock re-check runs inside ensureAgentSession.
        holderReconnectedAfterMint = true
        return ticket
      })

      const t0 = 1_700_000_100_000
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
      const first = await runtime.requestChairRestore({
        worktreeSelector: 'id:wt-1',
        sessionId: HOLDER_SESSION_ID,
        displayName: 'chair-r142b-live'
      })
      expect(first.ok).toBe(false)
      if (first.ok) {
        throw new Error('unreachable')
      }
      expect(first.reason).toBe('same_generation_settling')

      const rawWrite = (
        db as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } } }
      ).db
      const rowsBefore = rawWrite
        .prepare('SELECT COUNT(*) as c FROM agent_launch_sessions WHERE host_id = ?')
        .get(HOST_ID) as { c: number }

      dateNowSpy.mockReturnValue(t0 + 10_000)
      const second = await runtime.requestChairRestore({
        worktreeSelector: 'id:wt-1',
        sessionId: HOLDER_SESSION_ID,
        displayName: 'chair-r142b-live'
      })
      expect(second.ok).toBe(false)
      if (second.ok) {
        throw new Error('unreachable')
      }
      expect(second.reason).toBe(
        'ensure_agent_session_failed: launch admission refused: restore_holder_same_generation_live'
      )

      // Holder left intact: current_sessions row still present, no new launch row anywhere.
      expect(
        rawWrite
          .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
          .get(HOST_ID, holderPaneKey)
      ).toBeDefined()
      const rowsAfter = rawWrite
        .prepare('SELECT COUNT(*) as c FROM agent_launch_sessions WHERE host_id = ?')
        .get(HOST_ID) as { c: number }
      expect(rowsAfter.c).toBe(rowsBefore.c)

      const auditRow = rawWrite
        .prepare(
          `SELECT verb, outcome, reason_code FROM agent_audit WHERE verb = 'session_adopted' ORDER BY seq DESC LIMIT 1`
        )
        .get() as { verb: string; outcome: string; reason_code: string }
      expect(auditRow.verb).toBe('session_adopted')
      expect(auditRow.outcome).toBe('adopted_ensure_failed')
      // Exact refusal pinned above via `second.reason` — reasonCode is capped at 200 chars
      // (chair-restore.ts) and this fixture's ids push it past the cap; only prefix checked.
      expect(auditRow.reason_code).toContain('signal=SAME_GEN_PTY_ABSENCE')
      const supersededRow = rawWrite
        .prepare(`SELECT 1 FROM agent_audit WHERE verb = 'superseded' ORDER BY seq DESC LIMIT 1`)
        .get()
      expect(supersededRow).toBeUndefined()
    })

    // [F5, F1] NEGATIVE: a fresh newer holder row (a relaunch under the SAME generation) inserted
    // between mint and admit refuses `restore_holder_relaunched` — the new code under test in
    // this hotfix. RED at base c727baa568 for this exact case: `admission.launchSeq` does not
    // exist on the mint call there at all (chair-restore.ts never sets it), so the relaunched row
    // is indistinguishable from the original at the admission layer and the SAME_GEN_PTY_ABSENCE
    // arm falls through to its (still absent) connected-pty check, which finds nothing and
    // PROCEEDS to adopt — see the base-run tail quoted in this brief's RETURN.
    it('a fresh newer holder row inserted between mint and admit refuses restore_holder_relaunched, holder left intact — through the real admission chain', async () => {
      db = new OrchestrationDb(':memory:')
      r142bTempHome = await mkdtemp(join(tmpdir(), 'orca-r142b-chained-'))
      process.env.HOME = r142bTempHome
      const projectDir = join(r142bTempHome, '.claude', 'projects', 'proj')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, `${HOLDER_SESSION_ID}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
      )

      installDaemonTestProvider({
        spawn: vi.fn(async () => ({ id: 'pty-r142b-new', incarnationId: 'inc-r142b-new' })),
        listProcesses: vi.fn(async () => [{ id: 'pty-r142b-new', incarnationId: 'inc-r142b-new' }])
      })
      const runtime = buildRealRuntimeWithRealController()
      runtime.setLiveReportPanesForSessionCheck(() => [])

      const currentGen = runtime.getLaunchGenerationId()
      const holderPaneKey = 'tab-r142b-relaunch:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      const holderPtyId = 'pty-r142b-holder-relaunch'
      const holderIncarnationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      const created = db.upsertAgentByPaneSuffix({
        displayName: 'chair-r142b-relaunch',
        role: null,
        hostId: HOST_ID,
        paneKey: holderPaneKey,
        terminalHandle: null,
        processIncarnation: `${holderPtyId}:${holderIncarnationId}`,
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
      const launched = db.recordLaunch({
        hostId: HOST_ID,
        paneKey: holderPaneKey,
        agentType: 'claude',
        sessionId: HOLDER_SESSION_ID,
        launchGeneration: currentGen,
        executionHostId: HOST_ID,
        evidence: 'host_launch'
      })
      if (!launched.ok) {
        throw new Error('fixture launch row failed')
      }

      const deadInventory: ControllerInventory = {
        allLivePtyIds: new Set(),
        terminalIdentityByPtyId: new Map()
      }
      vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)
      vi.spyOn(runtime, 'findConnectedPtyForPane').mockReturnValue(undefined)
      const originalMintRestoreTicket = runtime.mintRestoreTicket.bind(runtime)
      vi.spyOn(runtime, 'mintRestoreTicket').mockImplementation((payload) => {
        const ticket = originalMintRestoreTicket(payload)
        // Simulates the holder relaunching (a fresh row, SAME generation) strictly AFTER the
        // ticket named this pane's `launchSeq` as it stood at mint time, before the admission
        // pane-lock re-check runs inside ensureAgentSession.
        db!.recordLaunch({
          hostId: HOST_ID,
          paneKey: holderPaneKey,
          agentType: 'claude',
          sessionId: HOLDER_SESSION_ID,
          launchGeneration: currentGen,
          executionHostId: HOST_ID,
          evidence: 'host_launch'
        })
        return ticket
      })

      const t0 = 1_700_000_200_000
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
      const first = await runtime.requestChairRestore({
        worktreeSelector: 'id:wt-1',
        sessionId: HOLDER_SESSION_ID,
        displayName: 'chair-r142b-relaunch'
      })
      expect(first.ok).toBe(false)
      if (first.ok) {
        throw new Error('unreachable')
      }
      expect(first.reason).toBe('same_generation_settling')

      const rawWrite = (
        db as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } } }
      ).db
      const rowsBefore = rawWrite
        .prepare('SELECT COUNT(*) as c FROM agent_launch_sessions WHERE host_id = ?')
        .get(HOST_ID) as { c: number }

      dateNowSpy.mockReturnValue(t0 + 10_000)
      const second = await runtime.requestChairRestore({
        worktreeSelector: 'id:wt-1',
        sessionId: HOLDER_SESSION_ID,
        displayName: 'chair-r142b-relaunch'
      })
      expect(second.ok).toBe(false)
      if (second.ok) {
        throw new Error('unreachable')
      }
      expect(second.reason).toBe(
        'ensure_agent_session_failed: launch admission refused: restore_holder_relaunched'
      )

      // Holder left intact: current_sessions row still present, no launch row for a NEW pane
      // (the relaunch row inserted inside the mint hook above is the only new row).
      expect(
        rawWrite
          .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
          .get(HOST_ID, holderPaneKey)
      ).toBeDefined()
      const rowsAfter = rawWrite
        .prepare('SELECT COUNT(*) as c FROM agent_launch_sessions WHERE host_id = ?')
        .get(HOST_ID) as { c: number }
      expect(rowsAfter.c).toBe(rowsBefore.c + 1)

      const auditRow = rawWrite
        .prepare(
          `SELECT verb, outcome, reason_code FROM agent_audit WHERE verb = 'session_adopted' ORDER BY seq DESC LIMIT 1`
        )
        .get() as { verb: string; outcome: string; reason_code: string }
      expect(auditRow.verb).toBe('session_adopted')
      expect(auditRow.outcome).toBe('adopted_ensure_failed')
      // Exact refusal pinned above via `second.reason` — reasonCode is capped at 200 chars
      // (chair-restore.ts) and this fixture's ids push it past the cap; only prefix checked.
      expect(auditRow.reason_code).toContain('signal=SAME_GEN_PTY_ABSENCE')
      const supersededRow = rawWrite
        .prepare(`SELECT 1 FROM agent_audit WHERE verb = 'superseded' ORDER BY seq DESC LIMIT 1`)
        .get()
      expect(supersededRow).toBeUndefined()
    })
  })
})
