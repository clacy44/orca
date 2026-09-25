import { statSync } from 'node:fs'
import {
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import { bestEffortRestrictWindowsPath } from './secure-path-windows-acl'

// Item C (D-23-1 section (c)): the Windows async read path caches file IDENTITY only
// (dev/ino/birthtime), never ctime — a Set-Acl rewrite bumps ctime even as a no-op, which
// previously defeated any ctime-based cache. Identity is captured BEFORE the spawn; the
// finally block stores it as hardened only if the identity at completion still matches —
// otherwise the path was replaced mid-flight, so the entry is dropped and the replacement
// gets hardened by its own next read. At most one hardening runs in flight per path.
export const SECURE_PATH_REHARDEN_FLOOR_MS = 600_000
// F6: a failed/timed-out hardening must not be cached as hardened for the full 10 min floor —
// retry it soon instead of leaving the path unrestricted for SECURE_PATH_REHARDEN_FLOOR_MS.
export const SECURE_PATH_REHARDEN_RETRY_FLOOR_MS = 30_000

const DEFAULT_BOUNDS: SecurePathHardeningCacheBounds = {
  maxEntries: 1024,
  maxKeyBytes: 64 * 1024,
  maxTotalKeyBytes: 512 * 1024
}

type WindowsFileIdentity = { dev: number; ino: number; birthtimeMs: number }
type WindowsHardenedFileEntry = WindowsFileIdentity & {
  hardenedAt: number
  succeeded: boolean
  // G1 repair (F6 backoff): consecutive failures/timeouts double the retry floor (30s, 60s,
  // 120s, ...) up to the 10-minute success floor, instead of hammering a path that can never
  // harden (Constrained Language Mode/WDAC, FAT/exFAT, some UNC paths) at a flat 30s.
  consecutiveFailures: number
}

function retryFloorForConsecutiveFailures(consecutiveFailures: number): number {
  const doubled = SECURE_PATH_REHARDEN_RETRY_FLOOR_MS * 2 ** Math.max(0, consecutiveFailures - 1)
  return Math.min(doubled, SECURE_PATH_REHARDEN_FLOOR_MS)
}

let hardenedWindowsFilesThisProcess = new SecurePathHardeningCache<WindowsHardenedFileEntry>(
  DEFAULT_BOUNDS
)
const pendingWindowsFileHardenings = new Set<string>()

function getWindowsFileIdentity(targetPath: string): WindowsFileIdentity | null {
  try {
    const stats = statSync(targetPath)
    if (stats.isDirectory()) {
      return null
    }
    return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs }
  } catch {
    return null
  }
}

function identityMatches(a: WindowsFileIdentity, b: WindowsFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}

/** Windows read-path file hardening: identity-cached, floor-throttled, single-flight per path. */
export function hardenWindowsFileOnce(targetPath: string): boolean {
  const currentIdentity = getWindowsFileIdentity(targetPath)
  if (!currentIdentity) {
    hardenedWindowsFilesThisProcess.delete(targetPath)
    return false
  }
  const cached = hardenedWindowsFilesThisProcess.get(targetPath)
  const identityUnchanged = cached !== undefined && identityMatches(currentIdentity, cached)
  if (identityUnchanged) {
    const floor = cached!.succeeded
      ? SECURE_PATH_REHARDEN_FLOOR_MS
      : retryFloorForConsecutiveFailures(cached!.consecutiveFailures)
    if (Date.now() - cached!.hardenedAt < floor) {
      return true
    }
  }
  if (pendingWindowsFileHardenings.has(targetPath)) {
    return true
  }
  pendingWindowsFileHardenings.add(targetPath)
  const startIdentity = currentIdentity
  const priorConsecutiveFailures = identityUnchanged ? cached!.consecutiveFailures : 0
  function onHardened(succeeded: boolean): void {
    pendingWindowsFileHardenings.delete(targetPath)
    // Why: only the identity present at spawn was actually hardened. If the path still
    // holds that identity at completion, cache it; otherwise the file was replaced
    // mid-flight, so drop the entry and let the replacement's next read re-harden.
    const finishedIdentity = getWindowsFileIdentity(targetPath)
    if (finishedIdentity && identityMatches(finishedIdentity, startIdentity)) {
      hardenedWindowsFilesThisProcess.set(targetPath, {
        ...finishedIdentity,
        hardenedAt: Date.now(),
        succeeded,
        consecutiveFailures: succeeded ? 0 : priorConsecutiveFailures + 1
      })
    } else {
      hardenedWindowsFilesThisProcess.delete(targetPath)
    }
  }
  // G1 repair: `.then(onOk, onErr)` — bestEffortRestrictWindowsPath never rejects today, but a
  // lone `.then(onOk)` would leave the path stuck in `pendingWindowsFileHardenings` forever
  // (never retried) if it ever did; a rejection must clear the in-flight marker too.
  void bestEffortRestrictWindowsPath(targetPath, false).then(onHardened, () => onHardened(false))
  return true
}

/** F7: seed the identity cache once a caller has already hardened the path synchronously
 *  (e.g. the write path), so the next read spawns nothing instead of hardening again. */
export function markWindowsFileHardened(targetPath: string): void {
  const identity = getWindowsFileIdentity(targetPath)
  if (!identity) {
    return
  }
  hardenedWindowsFilesThisProcess.set(targetPath, {
    ...identity,
    hardenedAt: Date.now(),
    succeeded: true,
    consecutiveFailures: 0
  })
}

export function resetWindowsFileHardeningForTests(bounds: SecurePathHardeningCacheBounds): void {
  hardenedWindowsFilesThisProcess = new SecurePathHardeningCache(bounds)
  pendingWindowsFileHardenings.clear()
}

export function getWindowsFileHardeningStateForTests(): ReturnType<
  SecurePathHardeningCache<WindowsHardenedFileEntry>['state']
> {
  return hardenedWindowsFilesThisProcess.state()
}
