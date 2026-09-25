// Single-flight + short-lived result cache around a Windows process-resource scan (item D,
// D-23-1 section (d)): coalesces concurrent callers into one in-flight scan, and a cached
// result serves for WINDOWS_PROCESS_RESOURCE_CACHE_MS without triggering another spawn.
export const WINDOWS_PROCESS_RESOURCE_CACHE_MS = 5_000

export type WindowsProcessResourceScanRunner<T> = (() => Promise<T>) & {
  /** Test-only: drops the cache/in-flight state. */
  reset: () => void
}

export function createWindowsProcessResourceScanThrottle<T>(
  scan: () => Promise<T>
): WindowsProcessResourceScanRunner<T> {
  let cached: { rows: T; cachedAtMs: number } | null = null
  let inFlight: Promise<T> | null = null

  const run = (): Promise<T> => {
    const now = Date.now()
    if (cached && now - cached.cachedAtMs < WINDOWS_PROCESS_RESOURCE_CACHE_MS) {
      return Promise.resolve(cached.rows)
    }
    if (inFlight) {
      return inFlight
    }
    const scanPromise = scan()
      .then((rows) => {
        cached = { rows, cachedAtMs: Date.now() }
        return rows
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = scanPromise
    return scanPromise
  }
  run.reset = (): void => {
    cached = null
    inFlight = null
  }
  return run
}
