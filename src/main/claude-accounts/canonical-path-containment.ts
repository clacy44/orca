import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'

export type CanonicalPathResult =
  | { kind: 'canonical'; path: string }
  | { kind: 'symlink' }
  | { kind: 'unresolvable' }

/**
 * Canonicalizes a path for a containment decision.
 *
 * `realpathSync.native` so Windows junctions and 8.3 short names collapse the way the
 * OS opens them. A symlink reports as its own kind rather than being followed: whoever
 * owns the link can re-decide the containment answer between the check and the read.
 */
export function canonicalizePathForContainment(candidatePath: string): CanonicalPathResult {
  const resolved = resolve(candidatePath)
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      return { kind: 'symlink' }
    }
    return { kind: 'canonical', path: realpathSync.native(resolved) }
  } catch {
    return { kind: 'unresolvable' }
  }
}

/** Whether a canonical path IS `rootPath` or sits under it. Case-folds Windows-shaped paths only. */
export function isCanonicalPathWithinRoot(rootPath: string, canonicalPath: string): boolean {
  return isPathInsideOrEqual(canonicalizeRoot(rootPath), canonicalPath)
}

export function isCanonicalPathWithinAnyRoot(
  rootPaths: readonly string[],
  canonicalPath: string
): boolean {
  return rootPaths.some((rootPath) => isCanonicalPathWithinRoot(rootPath, canonicalPath))
}

function canonicalizeRoot(rootPath: string): string {
  const resolved = resolve(rootPath)
  try {
    return realpathSync.native(resolved)
  } catch {
    // Why: the root may not exist yet (no lane provisioned); its resolved form still bounds it.
    return resolved
  }
}
