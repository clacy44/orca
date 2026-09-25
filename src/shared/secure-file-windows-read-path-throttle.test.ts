// Item C (D-23-1 section (c)): the Windows async read path must not re-harden a file whose
// identity (dev/ino/birthtime) is unchanged more than once per SECURE_PATH_REHARDEN_FLOOR_MS,
// must coalesce concurrent hardenings for the same path into a single in-flight spawn, and must
// record the cached identity only once hardening FINISHES — not before it starts (recording
// before completion races the PowerShell ACL rewrite, which itself bumps ctime and previously
// defeated the cache on every subsequent read).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, existsSyncMock, statSyncMock, fileState } = vi.hoisted(
  () => ({
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    fileState: { ctimeMs: 0, dev: 1, ino: 42, birthtimeMs: 100 }
  })
)

vi.mock('fs', () => ({
  chmodSync: vi.fn(),
  existsSync: existsSyncMock,
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: statSyncMock,
  writeFileSync: vi.fn()
}))

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock
}))

import {
  __resetSecureFileHardenedPathsForTests,
  __resetSecureFileWindowsUserSidForTests,
  hardenExistingSecureFile
} from './secure-file'

const TARGET_PATH = 'C:\\Users\\me\\.orca\\secret.json'
const DIR_PATH = 'C:\\Users\\me\\.orca'

describe('secure-file Windows read-path re-harden throttle', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let pendingCallbacks: (() => void)[] = []

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.SystemRoot = 'C:\\Windows'
    fileState.ctimeMs = 0
    fileState.dev = 1
    fileState.ino = 42
    fileState.birthtimeMs = 100
    pendingCallbacks = []
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    execFileSyncMock.mockImplementation((file: string) => {
      if (String(file).endsWith('whoami.exe')) {
        return '"USER","S-1-5-21-1000"'
      }
      return ''
    })
    // Why: defer the callback instead of firing it synchronously — mirrors the real ~1-1.5s
    // PowerShell cold start, so a caller that snapshots identity right after the call (rather
    // than in the completion callback) captures stale state, exactly like the pre-fix bug.
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (...args: unknown[]) => void) => {
        pendingCallbacks.push(() => {
          fileState.ctimeMs += 1 // Set-Acl bumps ctime on every real hardening.
          callback(null, '', '')
        })
        return {}
      }
    )
    statSyncMock.mockImplementation((targetPath: unknown) => {
      const path = String(targetPath)
      if (path === DIR_PATH) {
        return {
          isDirectory: () => true,
          dev: 0,
          ino: 1,
          size: 0,
          mode: 0o700,
          ctimeMs: 0,
          mtimeMs: 0,
          birthtimeMs: 0
        }
      }
      if (path !== TARGET_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {
        isDirectory: () => false,
        dev: fileState.dev,
        ino: fileState.ino,
        size: 2,
        mode: 0o600,
        ctimeMs: fileState.ctimeMs,
        mtimeMs: 0,
        birthtimeMs: fileState.birthtimeMs
      }
    })
  })

  afterEach(() => {
    __resetSecureFileWindowsUserSidForTests()
    __resetSecureFileHardenedPathsForTests()
    delete process.env.SystemRoot
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  async function flushOnePendingHardening(): Promise<void> {
    const next = pendingCallbacks.shift()
    if (next) {
      next()
    }
    // Let the completion .finally() land before the next read.
    await Promise.resolve()
    await Promise.resolve()
  }

  // Why: only count spawns targeting TARGET_PATH — the parent directory is hardened once via
  // the separate (already-fixed, #4901) path-cached directory mechanism, out of item C's scope.
  function powerShellSpawnCount(): number {
    return execFileMock.mock.calls.filter((call: unknown[]) => {
      const [file, args] = call as [string, string[]]
      return String(file).endsWith('powershell.exe') && args[6] === TARGET_PATH
    }).length
  }

  it('spawns exactly one PowerShell hardening across 100 reads with a stable identity', async () => {
    for (let i = 0; i < 100; i++) {
      hardenExistingSecureFile(TARGET_PATH)
      await flushOnePendingHardening()
    }

    expect(powerShellSpawnCount()).toBe(1)
  })

  it('spawns again once dev/ino/birthtime identity actually changes', async () => {
    for (let i = 0; i < 10; i++) {
      hardenExistingSecureFile(TARGET_PATH)
      await flushOnePendingHardening()
    }
    expect(powerShellSpawnCount()).toBe(1)

    // Simulate a replaced file: new inode + birthtime.
    fileState.ino = 43
    fileState.birthtimeMs = 200

    hardenExistingSecureFile(TARGET_PATH)
    await flushOnePendingHardening()

    expect(powerShellSpawnCount()).toBe(2)
  })

  it('coalesces 10 reads that land while a hardening is still in flight into 1 spawn', async () => {
    for (let i = 0; i < 10; i++) {
      hardenExistingSecureFile(TARGET_PATH)
    }
    // No callback has been flushed yet — the hardening is still "in flight".
    expect(powerShellSpawnCount()).toBe(1)

    await flushOnePendingHardening()
    expect(powerShellSpawnCount()).toBe(1)
  })
})
