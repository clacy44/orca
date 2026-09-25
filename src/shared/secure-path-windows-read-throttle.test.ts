// B2(b)/(c) + F6/F7: fake-timer coverage for the Windows read-path re-harden floor, ino-only
// replacement detection, the short retry floor on a failed/timed-out hardening, and seeding the
// cache from a synchronous write-path hardening.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statSyncMock, bestEffortRestrictWindowsPathMock, fileState } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
  bestEffortRestrictWindowsPathMock: vi.fn(),
  fileState: { dev: 1, ino: 42, birthtimeMs: 100 }
}))

vi.mock('node:fs', () => ({ statSync: statSyncMock }))
vi.mock('./secure-path-windows-acl', () => ({
  bestEffortRestrictWindowsPath: bestEffortRestrictWindowsPathMock
}))

import {
  SECURE_PATH_REHARDEN_FLOOR_MS,
  SECURE_PATH_REHARDEN_RETRY_FLOOR_MS,
  getWindowsFileHardeningStateForTests,
  hardenWindowsFileOnce,
  markWindowsFileHardened,
  resetWindowsFileHardeningForTests
} from './secure-path-windows-read-throttle'

const TARGET_PATH = 'C:\\Users\\me\\.orca\\secret.json'
const BOUNDS = { maxEntries: 1024, maxKeyBytes: 64 * 1024, maxTotalKeyBytes: 512 * 1024 }

describe('secure-path-windows-read-throttle (B2b/c, F6, F7 REPAIR)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fileState.dev = 1
    fileState.ino = 42
    fileState.birthtimeMs = 100
    statSyncMock.mockReset()
    statSyncMock.mockImplementation((targetPath: unknown) => {
      if (String(targetPath) !== TARGET_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {
        isDirectory: () => false,
        dev: fileState.dev,
        ino: fileState.ino,
        birthtimeMs: fileState.birthtimeMs
      }
    })
    bestEffortRestrictWindowsPathMock.mockReset()
    bestEffortRestrictWindowsPathMock.mockResolvedValue(true)
    resetWindowsFileHardeningForTests(BOUNDS)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('B2(b): re-hardens an unchanged identity after the 600s floor elapses', async () => {
    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SECURE_PATH_REHARDEN_FLOOR_MS - 1)
    hardenWindowsFileOnce(TARGET_PATH)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1) // still under the floor

    await vi.advanceTimersByTimeAsync(2)
    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(2) // floor elapsed
  })

  it('B2(c): an ino-only change (same dev, same birthtime) re-hardens', async () => {
    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1)

    // Only the inode changes — dev and birthtime (NTFS tunneling keeps CreationTime on a
    // rename-over) stay identical, unlike a full replacement.
    fileState.ino = 4321

    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(2)
  })

  it('F6: a failed/timed-out hardening is cached under a short retry floor, not the 10-minute floor', async () => {
    bestEffortRestrictWindowsPathMock.mockResolvedValueOnce(false)
    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1)

    // Short past the retry floor but nowhere near the 10-minute success floor: must retry.
    await vi.advanceTimersByTimeAsync(SECURE_PATH_REHARDEN_RETRY_FLOOR_MS + 1)
    bestEffortRestrictWindowsPathMock.mockResolvedValueOnce(true)
    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(2)
  })

  it('F6: a successful hardening keeps the full 10-minute floor', async () => {
    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SECURE_PATH_REHARDEN_RETRY_FLOOR_MS + 1)
    hardenWindowsFileOnce(TARGET_PATH)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1) // success floor still holds
  })

  it('B1 REPAIR: a file replaced (new ino) during an in-flight hardening gets hardened by its next read (2 spawns)', async () => {
    let resolveFirstHardening: ((succeeded: boolean) => void) | undefined
    bestEffortRestrictWindowsPathMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFirstHardening = resolve
        })
    )

    hardenWindowsFileOnce(TARGET_PATH)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(1)

    // The path is replaced (new inode) while the first hardening is still in flight — the
    // script actually ran against the OLD file, so the identity present at completion must
    // not be cached as hardened.
    fileState.ino = 43
    fileState.birthtimeMs = 200
    resolveFirstHardening!(true)
    await vi.advanceTimersByTimeAsync(0)

    // The replacement's own next read must trigger its own hardening (cache was dropped).
    bestEffortRestrictWindowsPathMock.mockResolvedValueOnce(true)
    hardenWindowsFileOnce(TARGET_PATH)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)

    // The replacement is now cached hardened — a further read spawns nothing.
    hardenWindowsFileOnce(TARGET_PATH)
    expect(bestEffortRestrictWindowsPathMock).toHaveBeenCalledTimes(2)
  })

  it('F7: seeding from the write path spawns nothing on the next read', async () => {
    markWindowsFileHardened(TARGET_PATH)
    expect(getWindowsFileHardeningStateForTests().entries).toBe(1)

    hardenWindowsFileOnce(TARGET_PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(bestEffortRestrictWindowsPathMock).not.toHaveBeenCalled()
  })
})
