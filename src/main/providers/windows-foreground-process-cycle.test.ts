// R1 (D-26b): a stale Win32 ParentProcessId plus a recycled PID makes the process table cyclic.
// The foreground walk must stay bounded, return the true subtree and report the anomaly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMapGetTripwire, type MapGetTripwire } from '../../shared/map-get-tripwire-for-tests'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'
import { resolveWindowsAgentForegroundProcessWithAvailability } from './windows-agent-foreground-process'

type ExecFileCallback = (err: unknown, result: { stdout: string; stderr: string }) => void

function row(pid: number, ppid: number, name: string, commandLine = name) {
  return {
    ProcessId: pid,
    ParentProcessId: ppid,
    Name: name,
    CommandLine: commandLine,
    ExecutablePath: `C:/x/${name}`
  }
}

// explorer's parent 6996 is dead; the hook below was handed the recycled PID 6996.
const CYCLIC_TABLE = JSON.stringify([
  row(7000, 6996, 'explorer.exe'),
  row(400, 7000, 'electron.exe'),
  row(500, 400, 'node.exe'),
  row(600, 500, 'pwsh.exe'),
  row(700, 600, 'node.exe', 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'),
  row(6996, 700, 'sh.exe')
])

describe('windows foreground process walk on a cyclic process table', () => {
  let platform: PropertyDescriptor | undefined
  let tripwire: MapGetTripwire | null = null

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    execFileMock.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      ;(cb as ExecFileCallback)(null, { stdout: CYCLIC_TABLE, stderr: '' })
    })
  })

  afterEach(() => {
    tripwire?.restore()
    tripwire = null
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('returns exactly the true subtree, skips the stale edge once and reports it', async () => {
    const onTreeAnomaly = vi.fn()
    tripwire = installMapGetTripwire()
    const candidates = await queryWindowsProcessDescendants(600, { onTreeAnomaly })
    const calls = tripwire.calls
    tripwire.restore()

    expect(tripwire.tripped).toBe(false)
    expect(calls).toBeLessThan(1_000)
    expect(candidates?.map((c) => c.pid).sort((a, b) => a - b)).toEqual([700, 6996])
    expect(onTreeAnomaly).toHaveBeenCalledTimes(1)
    expect(onTreeAnomaly.mock.calls[0][0]).toMatchObject({
      staleEdgesSkipped: 1,
      fresh: false
    })
    expect(onTreeAnomaly.mock.calls[0][0].rows).toHaveLength(6)
    expect(onTreeAnomaly.mock.calls[0][0].descendants).toHaveLength(2)
  })

  it('does not report an anomaly for an acyclic table', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      ;(cb as ExecFileCallback)(null, {
        stdout: JSON.stringify([row(600, 500, 'pwsh.exe'), row(700, 600, 'node.exe')]),
        stderr: ''
      })
    })
    const onTreeAnomaly = vi.fn()
    const candidates = await queryWindowsProcessDescendants(600, { onTreeAnomaly })
    expect(candidates?.map((c) => c.pid)).toEqual([700])
    expect(onTreeAnomaly).not.toHaveBeenCalled()
  })

  it('threads onTreeAnomaly through the resolver and still resolves the agent', async () => {
    const onTreeAnomaly = vi.fn()
    tripwire = installMapGetTripwire()
    const resolution = await resolveWindowsAgentForegroundProcessWithAvailability(600, 'pwsh.exe', {
      onTreeAnomaly
    })
    tripwire.restore()
    expect(tripwire.tripped).toBe(false)
    expect(resolution).toEqual({ available: true, processName: 'codex' })
    expect(onTreeAnomaly).toHaveBeenCalledTimes(1)
  })
})
