// R1 (D-26b): the SSH-relay twin of the foreground walk must not loop on a cyclic ppid table.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMapGetTripwire, type MapGetTripwire } from '../shared/map-get-tripwire-for-tests'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({ execFile: execFileMock, execFileSync: execFileSyncMock }))

import { resetProcessTableSnapshotForTests } from '../shared/process-table-snapshot'
import { getForegroundProcessName } from './pty-shell-utils'

const CYCLIC_PS = [
  '7000 6996 S    /usr/bin/explorer',
  '400 7000 S    /usr/bin/electron',
  '500 400 S    /usr/bin/node daemon.js',
  '600 500 Ss+  bash -i',
  '700 600 S+   node /Users/dev/.nvm/versions/node/bin/codex',
  '6996 700 S+   sh -c hook'
].join('\n')

describe('relay foreground walk on a cyclic process table', () => {
  let platform: PropertyDescriptor | undefined
  let tripwire: MapGetTripwire | null = null

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
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

  it('stays bounded and still finds the agent under the shell', async () => {
    tripwire = installMapGetTripwire()
    const name = await getForegroundProcessName(600, 'bash')
    tripwire.restore()

    expect(tripwire.tripped).toBe(false)
    expect(name).toBe('codex')
  })
})
