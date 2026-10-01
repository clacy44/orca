// R1 (D-26b): the tree-anomaly callback reaches daemon.log only as counts — never rows, commands or paths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawnMock, resolveMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveMock: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) => resolveMock(...args)
}))

import { createPtySubprocess } from './pty-subprocess'

function mockPtyProcess(processName: string, pid = 12345) {
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: processName,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() }))
  }
}

async function flushAsyncTicks(count = 12): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

describe('daemon pty foreground scan anomaly wiring', () => {
  let platform: PropertyDescriptor | undefined
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    spawnMock.mockReset()
    resolveMock.mockReset()
    resolveMock.mockResolvedValue({ available: true, processName: null })
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-pty-scan-anomaly-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    spawnMock.mockReturnValue(mockPtyProcess('zsh'))
  })

  afterEach(() => {
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

  it('reports only counts from the background refresh and the fresh confirmation scan', async () => {
    const onForegroundScanAnomaly = vi.fn()
    const handle = createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      onForegroundScanAnomaly
    })

    handle.getForegroundProcess()
    await flushAsyncTicks()
    const refreshOptions = resolveMock.mock.calls[0][2] as {
      onTreeAnomaly?: (anomaly: unknown) => void
    }
    expect(typeof refreshOptions.onTreeAnomaly).toBe('function')
    refreshOptions.onTreeAnomaly?.({
      rows: [
        { pid: 1, ppid: 0, command: 'secret --token abc' },
        { pid: 2, ppid: 1 }
      ],
      descendants: [{ pid: 2, ppid: 1, command: 'secret --token abc' }],
      staleEdgesSkipped: 3,
      fresh: false
    })
    expect(onForegroundScanAnomaly).toHaveBeenCalledWith({
      staleEdgesSkipped: 3,
      rowCount: 2,
      descendantCount: 1,
      fresh: false
    })

    await handle.confirmForegroundProcess?.()
    const confirmOptions = resolveMock.mock.calls.at(-1)?.[2] as {
      fresh?: boolean
      onTreeAnomaly?: (anomaly: unknown) => void
    }
    expect(confirmOptions.fresh).toBe(true)
    expect(typeof confirmOptions.onTreeAnomaly).toBe('function')
  })

  it('passes no onTreeAnomaly when the daemon did not ask for anomaly reports', async () => {
    const handle = createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    handle.getForegroundProcess()
    await flushAsyncTicks()
    expect(resolveMock.mock.calls[0][2]).not.toHaveProperty('onTreeAnomaly')
  })
})
