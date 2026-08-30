// S10-2 GATE §, h3 (s10-2-spec.md:150). Newline-delimited literals file beside the orchestration
// DB, same store `hardenOrchestrationDatabaseFiles` hardens, mode 0600, read once per process
// and cached. Absent is normal, not an error — h3 stays inert until an operator opts in by
// creating the file. Never returned by any RPC and never echoed in a refusal (matchInfraLiterals
// in message-body-gate.ts returns only the rule id, never the matched literal).
import { chmodSync, existsSync, readFileSync } from 'node:fs'

const cache = new Map<string, readonly string[]>()

export function infraAllowlistPath(dbPath: string): string {
  return `${dbPath}.infra-allowlist`
}

/** Loads and caches the allowlist for `dbPath`. Never throws — any failure (missing file,
 * unreadable, empty) resolves to `[]`, which leaves h3 inert rather than blocking startup. */
export function loadInfraAllowlist(dbPath: (string & {}) | ':memory:'): readonly string[] {
  if (dbPath === ':memory:') {
    return []
  }
  const cached = cache.get(dbPath)
  if (cached) {
    return cached
  }
  const literals = readAllowlistFile(dbPath)
  cache.set(dbPath, literals)
  return literals
}

function readAllowlistFile(dbPath: string): readonly string[] {
  try {
    const path = infraAllowlistPath(dbPath)
    if (!existsSync(path)) {
      return []
    }
    if (process.platform !== 'win32') {
      chmodSync(path, 0o600)
    }
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/** Test-only: forces the next `loadInfraAllowlist(dbPath)` to re-read the file. */
export function resetInfraAllowlistCacheForTests(dbPath: string): void {
  cache.delete(dbPath)
}
