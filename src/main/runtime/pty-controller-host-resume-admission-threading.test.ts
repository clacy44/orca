/**
 * [S10-21a C14c, D-R130 F-1] Coverage fence, restored OUTSIDE `src/main/ipc` (the
 * `'host-resume'`-literal fence, `agent-launch-admission-host-resume-literal-fence.test.ts`,
 * allows that literal inside `src/main/ipc` only in `agent-launch-admission.ts`/its own two test
 * files — a new ipc-local test constructing the literal would need adding to that allowlist,
 * which is the frozen decision surface. This file lives beside
 * `orca-runtime-host-resume-descriptor-provenance.test.ts`, which already constructs
 * `restoreProvenance`/host-resume-shaped values from outside `ipc`, so the literal fence stays
 * tight.
 *
 * D-R130 F-1: the deleted C14 "Case D (T44 family)" pair (reverted with the controller-funnel
 * gate at 4cf4b7399a) was the only proof that the admission threading `pty.ts` KEPT —
 * `launchAdmissionBundle(runtime, args.connectionId, args.launchAdmission)` at `pty.ts:5226`
 * (the `agentSessionEnsure` branch) and `launchAdmission: args.launchAdmission` at `pty.ts:5296`
 * (the `spawnForStablePane` / else branch) — actually reaches `admitAgentLaunch` with the
 * caller's descriptor. `git grep host_resume -- '*.test.ts'` at 4cf4b7399a returns only
 * `daemon-respawn-gate-action.test.ts` (the pure decision function) — no test anywhere drove a
 * spawn funnel to a `host_resume` classification. This is a fence over KEPT behaviour, not a
 * regression test for new behaviour: FAILS AT BASE? NO — both branches already thread
 * `args.launchAdmission` at base (f818047b67); this only restores the missing proof.
 *
 * Harness: the same `registerPtyHandlers` + `makeRuntimeStubWithStore` + captured
 * `RuntimePtyController` pattern the original (pre-C14b-revert) Case D used — a stub runtime
 * (not a real `OrcaRuntimeService`), a stub local-provider double, and a real in-memory
 * `OrchestrationDb`. `admitAgentLaunch` itself is spied, never stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync as realMkdirSync } from 'node:fs'
import type * as Wsl from '../wsl'
import { makeRuntimeStubWithStore } from '../ipc/runtime-stub-with-store'
import { OrchestrationDb } from './orchestration/db'
import { AGENT_SESSION_CLAIM_DIGEST_VERSION } from '../../shared/agent-session-host-authority'
import { makePaneKey } from '../../shared/stable-pane-id'

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
import * as AgentLaunchAdmissionModule from '../ipc/agent-launch-admission'
import type { LaunchAdmission } from '../ipc/agent-launch-admission'

function makeDisposable() {
  return { dispose: vi.fn() }
}

describe('S10-21a C14c, D-R130 F-1: pty.ts:5226/:5296 thread args.launchAdmission into admitAgentLaunch', () => {
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
    _resetLocalPtyProviderStateForTest()
    _resetWslCachesForTests()
    vi.useRealTimers()
    for (const leakedConnectionId of ['c14c-fence-leak']) {
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

  // [S10-21a C14c] Mirrors pty.test.ts's own `installDaemonTestProvider`.
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

  function handCraftedHostResumeAdmission(payload: {
    predecessorPaneKey: string
    sessionId: string
    executionHostId: string
    launchGeneration: string
  }): LaunchAdmission {
    return {
      kind: 'host-resume',
      sessionId: payload.sessionId,
      predecessorPaneKey: payload.predecessorPaneKey,
      executionHostId: payload.executionHostId,
      launchGeneration: payload.launchGeneration
    }
  }

  // [S10-21a C14c] Mirrors pty.test.ts's own (reverted) `registerFunnelGateController` —
  // captures the `RuntimePtyController` `registerPtyHandlers` hands `runtime.setPtyController`,
  // via a stub runtime (never a real `OrcaRuntimeService`).
  function registerFunnelGateController(
    db: OrchestrationDb,
    runtimeOverrides: Record<string, unknown> = {}
  ): { spawn: (args: Record<string, unknown>) => Promise<unknown> } {
    let controller: { spawn: (args: Record<string, unknown>) => Promise<unknown> } | undefined
    const runtime = {
      ...makeRuntimeStubWithStore(),
      getOrchestrationDb: () => db,
      setPtyController: vi.fn((next: typeof controller) => {
        controller = next
      }),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getTerminalProcessIncarnation: vi.fn(() => null),
      ...runtimeOverrides
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    if (!controller) {
      throw new Error('registerFunnelGateController: controller was not captured')
    }
    return controller
  }

  let admitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    admitSpy = vi.spyOn(AgentLaunchAdmissionModule, 'admitAgentLaunch')
  })

  afterEach(() => {
    admitSpy.mockRestore()
  })

  it('the agentSessionEnsure branch threads args.launchAdmission end to end (pty.ts:5226) — {kind:"host-resume"} + matching sessionId classifies host_resume', async () => {
    installDaemonTestProvider({
      spawn: vi.fn(async () => ({ id: 'pty-c14c-d1', incarnationId: 'inc-provider-d1' })),
      listProcesses: vi.fn(async () => [{ id: 'pty-c14c-d1', incarnationId: 'inc-provider-d1' }])
    })
    const db = new OrchestrationDb(':memory:')
    const tabId = '99999999-9999-4999-8999-dddddddddd01'
    const leafId = '99999999-9999-4999-8999-dddddddddd02'
    const paneKey = makePaneKey(tabId, leafId)
    const controller = registerFunnelGateController(db)
    const launchAdmission = handCraftedHostResumeAdmission({
      predecessorPaneKey: paneKey,
      sessionId: 'sess-c14c-d1',
      executionHostId: 'local',
      launchGeneration: 'gen-c14c-d1'
    })

    await controller.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree-c14c-d1',
      command: 'claude --resume sess-c14c-d1',
      launchAgent: 'claude',
      worktreeId: 'worktree-c14c-d1',
      tabId,
      leafId,
      preAllocatedHandle: 'term_new_handle_c14c_d1',
      launchAdmission,
      agentSessionEnsure: {
        claim: {
          digestVersion: AGENT_SESSION_CLAIM_DIGEST_VERSION,
          keyId: 'claim-key-c14c-d1',
          identityDigest: 'c14c-case-d1-identity-digest-999999999999999',
          worktreeScopeDigest: 'c14c-case-d1-worktree-scope-9999999999999999',
          agent: 'claude' as const
        },
        surface: {
          worktreeId: 'worktree-c14c-d1',
          tabId,
          leafId,
          terminalHandle: 'term_new_handle_c14c_d1'
        }
      }
    })

    expect(admitSpy).toHaveBeenCalledOnce()
    expect(admitSpy.mock.calls[0]?.[2]).toEqual(launchAdmission)
    const admitted = await admitSpy.mock.results[0]!.value
    expect(admitted.classification).toBe('host_resume')
  })

  it('the spawnForStablePane (else) branch also threads args.launchAdmission end to end (pty.ts:5296)', async () => {
    installDaemonTestProvider({
      spawn: vi.fn(async () => ({ id: 'pty-c14c-d2', incarnationId: 'inc-provider-d2' }))
    })
    const db = new OrchestrationDb(':memory:')
    const tabId = '99999999-9999-4999-8999-dddddddddd11'
    const leafId = '99999999-9999-4999-8999-dddddddddd12'
    const paneKey = makePaneKey(tabId, leafId)
    const controller = registerFunnelGateController(db)
    const launchAdmission = handCraftedHostResumeAdmission({
      predecessorPaneKey: paneKey,
      sessionId: 'sess-c14c-d2',
      executionHostId: 'local',
      launchGeneration: 'gen-c14c-d2'
    })

    await controller.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree-c14c-d2',
      command: 'claude --resume sess-c14c-d2',
      launchAgent: 'claude',
      worktreeId: 'worktree-c14c-d2',
      tabId,
      leafId,
      preAllocatedHandle: 'term_new_handle_c14c_d2',
      launchAdmission
    })

    expect(admitSpy).toHaveBeenCalledOnce()
    expect(admitSpy.mock.calls[0]?.[2]).toEqual(launchAdmission)
    const admitted = await admitSpy.mock.results[0]!.value
    expect(admitted.classification).toBe('host_resume')
  })
})
