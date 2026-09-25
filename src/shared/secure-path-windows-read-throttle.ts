import { statSync } from 'node:fs'
import {
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import { bestEffortRestrictWindowsPath } from './secure-path-windows-acl'

// Item C (D-23-1 section (c)): the Windows async read path caches file IDENTITY only
// (dev/ino/birthtime), never ctime — a Set-Acl rewrite bumps ctime even as a no-op, which
// previously defeated any ctime-based cache. Identity is recorded when hardening FINISHES
// (not before it starts), and at most one hardening runs in flight per path.
export const SECURE_PATH_REHARDEN_FLOOR_MS = 600_000

const DEFAULT_BOUNDS: SecurePathHardeningCacheBounds = {
  maxEntries: 1024,
  maxKeyBytes: 64 * 1024,
  maxTotalKeyBytes: 512 * 1024
}

type WindowsFileIdentity = { dev: number; ino: number; birthtimeMs: number }
type WindowsHardenedFileEntry = WindowsFileIdentity & { hardenedAt: number }

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
  if (identityUnchanged && Date.now() - cached!.hardenedAt < SECURE_PATH_REHARDEN_FLOOR_MS) {
    return true
  }
  if (pendingWindowsFileHardenings.has(targetPath)) {
    return true
  }
  pendingWindowsFileHardenings.add(targetPath)
  void bestEffortRestrictWindowsPath(targetPath, false).finally(() => {
    pendingWindowsFileHardenings.delete(targetPath)
    // Why: record identity when hardening FINISHES, not before it starts — recording
    // pre-completion races Set-Acl and re-arms a re-harden on every subsequent read.
    const finishedIdentity = getWindowsFileIdentity(targetPath)
    if (finishedIdentity) {
      hardenedWindowsFilesThisProcess.set(targetPath, {
        ...finishedIdentity,
        hardenedAt: Date.now()
      })
    } else {
      hardenedWindowsFilesThisProcess.delete(targetPath)
    }
  })
  return true
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
