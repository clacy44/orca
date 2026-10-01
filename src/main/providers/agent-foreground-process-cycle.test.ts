// R1 (D-26b): the POSIX foreground walk shares the cycle-safe walker; same fixture as the Windows case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMapGetTripwire, type MapGetTripwire } from '../../shared/map-get-tripwire-for-tests'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'

// explorer's parent 6996 is dead; the hook below was handed the recycled PID 6996.
const CYCLIC_PS = [
  '7000 6996 S    /usr/bin/explorer',
  '400 7000 S    /usr/bin/electron',
  '500 400 S    /usr/bin/node daemon.js',
  '600 500 Ss+  bash -i',
  '700 600 S+   node /Users/dev/.nvm/versions/node/bin/codex',
  '6996 700 S+   sh -c hook'
].join('\n')

describe('posix agent foreground walk on a cyclic process table', () => {
  let platform: PropertyDescriptor | undefined
  let tripwire: MapGetTripwire | null = null

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    execFileMock.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      ;(cb as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: CYCLIC_PS,
        stderr: ''
      })
    })
  })

  afterEach(() => {
    tripwire?.restore()
    tripwire = null
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('resolves the agent, stays bounded and reports the stale edge', async () => {
    const onTreeAnomaly = vi.fn()
    tripwire = installMapGetTripwire()
    const resolution = await resolveAgentForegroundProcessWithAvailability(600, 'bash', {
      onTreeAnomaly
    })
    tripwire.restore()

    expect(tripwire.tripped).toBe(false)
    expect(resolution).toEqual({ available: true, processName: 'codex' })
    expect(onTreeAnomaly).toHaveBeenCalledTimes(1)
    expect(onTreeAnomaly.mock.calls[0][0]).toMatchObject({ staleEdgesSkipped: 1, fresh: false })
  })
})
