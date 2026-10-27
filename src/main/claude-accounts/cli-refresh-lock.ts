import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CREDENTIALS_FILENAME = '.credentials.json'
const REFRESH_LOCK_FILENAME = '.oauth_refresh.lock'

export type ClaudeCliRefreshLockWaitOptions = {
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
}

export type ClaudeCliRefreshLockWaitResult = 'clear' | 'timed-out'

function lockPathsFor(configDir: string): string[] {
  const paths = [join(configDir, REFRESH_LOCK_FILENAME)]
  const credentialsPath = join(configDir, CREDENTIALS_FILENAME)
  try {
    // Why: the CLI locks the REAL credentials file, so a symlinked file locks beside its target.
    paths.push(`${realpathSync(credentialsPath)}.lock`)
  } catch {
    paths.push(`${credentialsPath}.lock`)
  }
  return [...new Set(paths)]
}

function hasFreshLock(paths: readonly string[], staleMs: number): boolean {
  for (const lockPath of paths) {
    try {
      // A lock may be a file or a directory; either way an old mtime is a dead holder's leftover.
      if (Date.now() - statSync(lockPath).mtimeMs < staleMs) {
        return true
      }
    } catch {
      // Absent lock: nothing to wait for.
    }
  }
  return false
}

/**
 * Waits until no Claude CLI is mid-refresh in `configDir`.
 *
 * Before any refresh the CLI re-reads its stored credentials, takes
 * `<configDir>/.oauth_refresh.lock` (stale after 60 s) and saves with a compare-and-swap on the
 * refresh token. Reading the runtime credentials back while that lock is held can capture the
 * pre-rotation blob and then overwrite managed storage with a revoked token. A lock still fresh at
 * `timeoutMs` is reported, not waited on forever.
 */
export async function waitForClaudeCliRefreshLock(
  configDir: string,
  options: ClaudeCliRefreshLockWaitOptions = {}
): Promise<ClaudeCliRefreshLockWaitResult> {
  const timeoutMs = options.timeoutMs ?? 35_000
  const pollMs = options.pollMs ?? 250
  const staleMs = options.staleMs ?? 60_000
  const deadline = Date.now() + timeoutMs
  const paths = lockPathsFor(configDir)
  while (hasFreshLock(paths, staleMs)) {
    if (Date.now() >= deadline) {
      return 'timed-out'
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
  return 'clear'
}
