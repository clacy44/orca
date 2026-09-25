// B2(e) — replacement invariant for the SCENARIO CORRECTION declared in
// pty-subprocess-foreground-scan-cadence.test.ts: once a Windows pane relaxes a
// cached agent's refresh to the 5s active / 30s idle tiers (item A), an agent
// exit must still be detected within about 5s of its last output — the relaxed
// cadence must not let a stale "agent" identity linger indefinitely.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawnMock, isPwshAvailableMock, resolveAgentForegroundProcessMock, conptyMembershipMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
    isPwshAvailableMock: vi.fn(),
    resolveAgentForegroundProcessMock: vi.fn(),
    conptyMembershipMock: vi.fn()
  }))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../pwsh', () => ({ isPwshAvailable: isPwshAvailableMock }))

const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

// Why: retiring a shell-only-resolved cache goes through a ConPTY console-membership
// re-check on Windows; stub it as "root only" (shell-only, proves absence) so the exit
// path resolves without forking a real helper process.
vi.mock('../providers/windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (rootPid: number) => conptyMembershipMock(rootPid)
}))

import { createPtySubprocess } from './pty-subprocess'

const BASE_TIME_MS = 1_000_000

function mockPtyProcess(processName: string, pid = 12345) {
  const onDataListeners: ((data: string) => void)[] = []
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: processName,
    onData: vi.fn((cb: (data: string) => void) => {
      onDataListeners.push(cb)
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    _simulateData: (data: string) => onDataListeners.forEach((cb) => cb(data))
  }
}

async function flushAsyncTicks(count = 8): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function readForegroundAt(
  handle: { getForegroundProcess: () => string | null },
  atMs: number
): Promise<string | null> {
  vi.setSystemTime(BASE_TIME_MS + atMs)
  const foreground = handle.getForegroundProcess()
  await flushAsyncTicks()
  return foreground
}

describe('daemon pty cached-agent exit detection (Windows, B2e REPAIR)', () => {
  let platform: PropertyDescriptor | undefined
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    isPwshAvailableMock.mockReset()
    isPwshAvailableMock.mockReturnValue(false)
    resolveAgentForegroundProcessMock.mockReset()
    conptyMembershipMock.mockReset()
    conptyMembershipMock.mockResolvedValue(new Set([12345]))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-cached-agent-exit-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(BASE_TIME_MS)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('retires a cached agent within ~5s of its last output once the pane falls back to the bare shell', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue('claude')
    const proc = mockPtyProcess('powershell.exe')
    spawnMock.mockReturnValue(proc)
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })

    await readForegroundAt(handle, 0)
    expect(await readForegroundAt(handle, 500)).toBe('claude')

    // Output flows every 500ms up to t=5000ms, keeping the agent on the 5s active tier.
    for (let atMs = 1_000; atMs <= 5_000; atMs += 500) {
      vi.setSystemTime(BASE_TIME_MS + atMs)
      proc._simulateData('claude output\r\n')
      await readForegroundAt(handle, atMs)
    }
    expect(await readForegroundAt(handle, 5_000)).toBe('claude')

    // The agent exits at t=5000ms: no more output, and the next scan resolves no agent.
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: null })

    // First poll after the exit triggers the refresh (still serves the stale cache once).
    await readForegroundAt(handle, 10_400)
    // A subsequent read — still within ~5.5s of the last output at t=5000 plus scan settle —
    // must observe the retired cache, not the stale 'claude' identity.
    expect(await readForegroundAt(handle, 10_600)).not.toBe('claude')
  })
})
