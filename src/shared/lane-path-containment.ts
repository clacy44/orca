import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPathInsideOrEqual } from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

/** The one directory every per-principal lane lives under: `<userData>/claude-lanes/<id>`. */
export const CLAUDE_LANES_DIRNAME = 'claude-lanes'

/**
 * Whether a value names a path inside the lanes tree, by SEGMENT rather than by root.
 *
 * The lane root needs `userData`, which the forked daemon subprocess has no handle to — and the
 * one rule that must hold in both processes is the WSLENV invariant, where a path shaped like a
 * lane is exactly what must not cross into a distro. Segment matching is the fail-closed reading:
 * a non-lane path that happens to carry the segment is refused, a lane path never slips through.
 */
export function hasClaudeLaneSegment(candidatePath: string | undefined): boolean {
  return (
    candidatePath !== undefined &&
    candidatePath.split(/[\\/]+/).some((segment) => segment.toLowerCase() === CLAUDE_LANES_DIRNAME)
  )
}

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

/**
 * Whether a canonical path IS `rootPath` or sits under it.
 *
 * `isPathInsideOrEqual` folds case by path SYNTAX, which keeps macOS case-sensitive on
 * purpose — right for an ALLOW check, where a case mismatch fails closed, and wrong here,
 * where it would fail OPEN on a case-insensitive APFS volume whose `realpath(3)` preserved
 * the caller's casing. So a deny check folds on darwin too.
 */
export function isCanonicalPathWithinRoot(
  rootPath: string,
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const root = canonicalizeRoot(rootPath)
  if (isPathInsideOrEqual(root, canonicalPath)) {
    return true
  }
  return (
    platform === 'darwin' && isPathInsideOrEqual(root.toLowerCase(), canonicalPath.toLowerCase())
  )
}

/**
 * Deny-direction containment for a path that need not exist and may be a symlink.
 *
 * Unlike the capture-source assertion, which refuses a symlink outright because
 * its owner can re-point it between the check and the read, this one has no read to protect:
 * it decides whether a launch value addresses the lane root at all. So it denies on EITHER
 * the plainly resolved path (the lane may not be provisioned yet, so realpath would fail) or
 * the fully canonical one (a symlink into a lane must not launder its way past).
 */
export function isPathWithinRootForDenial(
  rootPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!candidatePath) {
    return false
  }
  if (isCanonicalPathWithinRoot(rootPath, resolve(candidatePath), platform)) {
    return true
  }
  try {
    return isCanonicalPathWithinRoot(
      rootPath,
      realpathSync.native(resolve(candidatePath)),
      platform
    )
  } catch {
    return false
  }
}

export function isCanonicalPathWithinAnyRoot(
  rootPaths: readonly string[],
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return rootPaths.some((rootPath) => isCanonicalPathWithinRoot(rootPath, canonicalPath, platform))
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

/**
 * Whether a lane path sits on a REMOTE UNC share (§2m(4)).
 *
 * Such a root's ACLs are set by a machine this design has said nothing about, so a native lane is
 * required to be a local drive path and this is refused at provisioning. The carve-out is the WSL
 * redirector forms and nothing else: `\\wsl.localhost\<distro>\…` is served for this Windows user
 * on this machine, and its far side carries Linux modes whose control is §2n(i)'s in-distro
 * `chmod` read-back rather than a DACL.
 */
export function isRemoteUncLanePath(
  candidatePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') {
    return false
  }
  const normalized = normalizeWindowsUncForm(candidatePath)
  return normalized.startsWith('//') && !parseWslUncPath(normalized)
}

/** `\\?\UNC\server\share` and `\\server\share` are one path; so are `\\?\C:\x` and `C:\x`. */
function normalizeWindowsUncForm(candidatePath: string): string {
  const slashed = candidatePath.replace(/\\/g, '/')
  if (!slashed.startsWith('//?/')) {
    return slashed
  }
  const stripped = slashed.slice(4)
  return /^UNC\//i.test(stripped) ? `//${stripped.slice(4)}` : stripped
}
