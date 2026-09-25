// Item A step 1 (D-23-1): once a Windows pane has a cached agent and is past its
// startup bootstrap window, the background refresh must relax to 30s while idle
// (no output for 10s) and 5s while output flows, instead of refreshing every 1s.
// confirmForegroundProcess must still force exactly one fresh scan per call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawnMock, isPwshAvailableMock, resolveAgentForegroundProcessMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn()
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

async function flushAsyncTicks(count = 6): Promise<void> {
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

describe('daemon pty cached-agent refresh cadence (Windows)', () => {
  let platform: PropertyDescriptor | undefined
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    isPwshAvailableMock.mockReset()
    isPwshAvailableMock.mockReturnValue(false)
    resolveAgentForegroundProcessMock.mockReset()
    resolveAgentForegroundProcessMock.mockResolvedValue('claude')
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-cached-agent-cadence-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
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

  function spawnWindowsShellWithCachedAgent() {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const proc = mockPtyProcess('powershell.exe')
    spawnMock.mockReturnValue(proc)
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    return { proc, handle }
  }

  it('bounds an idle cached-agent pane read 200 times in 60s to <=2 scans', async () => {
    const { handle } = spawnWindowsShellWithCachedAgent()

    // Prime the cache: the very first read precedes async enrichment (matches the
    // existing scan-cadence tests' pattern) and is not itself the "cached" read.
    await readForegroundAt(handle, 0)

    for (let i = 0, atMs = 300; i < 199; i++, atMs += 300) {
      expect(await readForegroundAt(handle, atMs)).toBe('claude')
    }

    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('bounds a cached-agent pane with output every 500ms for 60s to <=13 scans, name stays claude', async () => {
    const { proc, handle } = spawnWindowsShellWithCachedAgent()

    await readForegroundAt(handle, 0)

    for (let atMs = 500; atMs <= 60_000; atMs += 500) {
      vi.setSystemTime(BASE_TIME_MS + atMs)
      proc._simulateData('claude output\r\n')
      expect(await readForegroundAt(handle, atMs)).toBe('claude')
    }

    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBeLessThanOrEqual(13)
  })

  it('forces exactly one fresh scan per confirmForegroundProcess call regardless of cadence', async () => {
    const { handle } = spawnWindowsShellWithCachedAgent()
    await readForegroundAt(handle, 0)
    const callsBefore = resolveAgentForegroundProcessMock.mock.calls.length

    await expect(handle.confirmForegroundProcess!()).resolves.toBe('claude')
    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBe(callsBefore + 1)
    expect(resolveAgentForegroundProcessMock).toHaveBeenLastCalledWith(
      12345,
      'powershell.exe',
      expect.objectContaining({ fresh: true })
    )

    await expect(handle.confirmForegroundProcess!()).resolves.toBe('claude')
    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBe(callsBefore + 2)
  })
})
