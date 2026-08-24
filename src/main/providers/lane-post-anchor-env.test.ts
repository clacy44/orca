import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsConptyProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsConptyProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (...args: unknown[]) => readWindowsConptyProcessIdsMock(...args)
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { _resetLocalPtyProviderStateForTest, LocalPtyProvider } from './local-pty-provider'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

const LANE_DIR = '/tmp/orca-user-data/claude-lanes/11111111-2222-4333-8444-555555555555'
const WIN_LANE_DIR = 'C:\\Users\\dev\\AppData\\Roaming\\Orca\\claude-lanes\\lane-1'
const LANE = { principalId: '11111111-2222-4333-8444-555555555555' }

/** The object LocalPtyProvider actually hands the process. */
function spawnedEnv(): Record<string, string> {
  return spawnMock.mock.calls.at(-1)?.[2].env as Record<string, string>
}

function refusalCodeOf(error: unknown): string {
  return isClaudeLaneRefusal(error) ? error.code : `not-a-lane-refusal:${String(error)}`
}

describe('the env LocalPtyProvider hands the process, after the anchor', () => {
  let provider: LocalPtyProvider
  let origPlatform: PropertyDescriptor | undefined
  let ctxSeen: { credentialLane?: { principalId: string }; shellPath?: string } | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    process.env.SHELL = '/bin/zsh'
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    accessSyncMock.mockReturnValue(undefined)
    killWithDescendantSweepMock.mockImplementation(async (_rootPid: number, killRoot: () => void) =>
      killRoot()
    )
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    readWindowsConptyProcessIdsMock.mockResolvedValue(null)
    isWslAvailableAsyncMock.mockResolvedValue(true)
    wslUncDirectoryExistsMock.mockReturnValue(true)
    spawnMock.mockReturnValue({
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    })
    ctxSeen = undefined
    provider = new LocalPtyProvider()
    provider.configure({
      buildSpawnEnv: (_id, baseEnv, ctx) => {
        ctxSeen = ctx
        return { ...baseEnv }
      }
    })
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    vi.clearAllMocks()
  })

  it('carries exactly the lane config dir and none of the auth keys', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree',
      env: { CLAUDE_CONFIG_DIR: LANE_DIR },
      envToDelete: [...CLAUDE_AUTH_ENV_VARS],
      credentialLane: LANE
    })

    const env = spawnedEnv()
    expect(env.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
    for (const key of CLAUDE_AUTH_ENV_VARS) {
      expect(env[key]).toBeUndefined()
    }
  })

  // Negative control for guard 1: the replay after buildSpawnEnv is what would drop the lane, so
  // the deletion list must be sanitized at the anchor rather than only the env (§2 preamble (c)).
  it('deletes the lane key when the deletion list still names it', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: '/tmp/worktree',
      env: { CLAUDE_CONFIG_DIR: LANE_DIR },
      envToDelete: ['CLAUDE_CONFIG_DIR'],
      credentialLane: LANE
    })

    expect(spawnedEnv().CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('threads the pane lane into the buildSpawnEnv ctx', async () => {
    await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/worktree', credentialLane: LANE })

    expect(ctxSeen?.credentialLane).toEqual(LANE)
  })

  it('leaves the ctx lane-less for a shared-lane pane', async () => {
    await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/worktree' })

    expect(ctxSeen?.credentialLane).toBeUndefined()
  })
})

describe('a lane at the WSL boundary', () => {
  let provider: LocalPtyProvider
  let origPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    accessSyncMock.mockReturnValue(undefined)
    isWslAvailableAsyncMock.mockResolvedValue(true)
    wslUncDirectoryExistsMock.mockReturnValue(true)
    readWindowsConptyProcessIdsMock.mockResolvedValue(null)
    spawnMock.mockReturnValue({
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      process: 'wsl.exe',
      pid: 4321
    })
    provider = new LocalPtyProvider()
    provider.configure({ buildSpawnEnv: (_id, baseEnv) => ({ ...baseEnv }) })
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    vi.clearAllMocks()
  })

  it('refuses a lane pane whose per-tab shellOverride resolves to wsl.exe', async () => {
    const error = await provider
      .spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        shellOverride: 'wsl.exe',
        env: { CLAUDE_CONFIG_DIR: WIN_LANE_DIR },
        credentialLane: LANE
      })
      .catch((thrown: unknown) => thrown)

    expect(refusalCodeOf(error)).toBe('terminal.lane_wsl_shell_unsupported')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses a Windows lane path that would cross WSLENV even with no lane stamp', async () => {
    const error = await provider
      .spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        shellOverride: 'wsl.exe',
        env: { CLAUDE_CONFIG_DIR: WIN_LANE_DIR }
      })
      .catch((thrown: unknown) => thrown)

    expect(refusalCodeOf(error)).toBe('terminal.lane_wsl_shell_unsupported')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('still launches a lane-less managed-WSL account pane on its own Linux config dir', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      shellOverride: 'wsl.exe',
      env: { CLAUDE_CONFIG_DIR: '/home/dev/.orca/claude-accounts/acct-1' }
    })

    expect(spawnedEnv().CLAUDE_CONFIG_DIR).toBe('/home/dev/.orca/claude-accounts/acct-1')
  })
})

describe('the win32 lane-key collapse, sited after the provider merge', () => {
  let provider: LocalPtyProvider
  let origPlatform: PropertyDescriptor | undefined
  let origInherited: string | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    origInherited = process.env.Claude_Config_Dir
    // Why the host process env: row 19 supports Orca carrying its own CLAUDE_CONFIG_DIR, and the
    // provider's base merge spreads process.env verbatim — casing and all (§2m(5)).
    process.env.Claude_Config_Dir = 'C:\\Users\\other\\.claude'
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    accessSyncMock.mockReturnValue(undefined)
    readWindowsConptyProcessIdsMock.mockResolvedValue(null)
    spawnMock.mockReturnValue({
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      process: 'cmd.exe',
      pid: 999
    })
    provider = new LocalPtyProvider()
    provider.configure({ buildSpawnEnv: (_id, baseEnv) => ({ ...baseEnv }) })
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    if (origInherited === undefined) {
      delete process.env.Claude_Config_Dir
    } else {
      process.env.Claude_Config_Dir = origInherited
    }
    vi.clearAllMocks()
  })

  it('leaves exactly one casing, and its value is the lane', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      shellOverride: 'cmd.exe',
      env: { CLAUDE_CONFIG_DIR: WIN_LANE_DIR },
      credentialLane: LANE
    })

    const env = spawnedEnv()
    const variants = Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')
    expect(variants).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(env.CLAUDE_CONFIG_DIR).toBe(WIN_LANE_DIR)
  })
})
