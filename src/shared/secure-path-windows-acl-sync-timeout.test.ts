// G1 round-3 non-blocking 5: the 20s directory timeout (added for the async launcher's
// recursive Set-Acl propagation) previously reached restrictWindowsPathSync too. Sync callers
// (lane/artifact directory provisioning) are small and must not block their caller past 5s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock
}))

import {
  bestEffortRestrictWindowsPath,
  restrictWindowsPathSync,
  resetSecureFileWindowsUserSidForTests
} from './secure-path-windows-acl'

const VALID_SID = 'S-1-5-21-1000'

describe('secure-path-windows-acl sync/async directory timeouts (G1 round-3 non-blocking 5)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.SystemRoot = 'C:\\Windows'
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    resetSecureFileWindowsUserSidForTests()
    execFileSyncMock.mockImplementation((file: string) => {
      if (String(file).endsWith('whoami.exe')) {
        return `"USER","${VALID_SID}"`
      }
      return ''
    })
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (...a: unknown[]) => void) => {
        callback(null, '', '')
        return {}
      }
    )
  })

  afterEach(() => {
    resetSecureFileWindowsUserSidForTests()
    delete process.env.SystemRoot
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('the async directory launcher gets the 20s timeout', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca', true)
    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const timeout = (call![2] as { timeout: number }).timeout
    expect(timeout).toBe(20_000)
  })

  it('the sync directory launcher keeps the 5s timeout, not the async 20s one', () => {
    restrictWindowsPathSync('C:\\Users\\me\\.orca', true)
    const call = execFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    expect(call).toBeDefined()
    const timeout = (call![2] as { timeout: number }).timeout
    expect(timeout).toBe(5_000)
  })

  it('the sync file launcher also keeps the 5s timeout', () => {
    restrictWindowsPathSync('C:\\Users\\me\\.orca\\secret.json', false)
    const call = execFileSyncMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const timeout = (call![2] as { timeout: number }).timeout
    expect(timeout).toBe(5_000)
  })
})
