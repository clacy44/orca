import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import {
  canonicalizePathForContainment,
  isCanonicalPathWithinRoot
} from '../../shared/lane-path-containment'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

export const MANAGED_AUTH_MARKER = '.orca-managed-claude-auth'

export function getClaudeManagedAccountsRoot(): string {
  return join(app.getPath('userData'), 'claude-accounts')
}

export function resolveOwnedClaudeManagedAuthPath(
  accountId: string,
  candidatePath: string,
  options: { adoptLegacyMarker?: boolean; root?: string } = {}
): string | null {
  // Why an injectable root rather than a second copy of this function: S9-L1's per-lane store
  // (`<lane>/claude-accounts`) needs the SAME symlink refusal, containment, two-segment match,
  // marker-equals-id rule and 0600 atomic I/O as the desktop's managed-account store. Two copies
  // drift and only one gets the next fix (S9-L1 §storeLayout).
  const rootPath = options.root ?? getClaudeManagedAccountsRoot()
  const resolvedCandidate = resolve(candidatePath)
  if (!existsSync(resolvedCandidate) || !existsSync(rootPath)) {
    return null
  }
  try {
    // Why the shared check: this store is §2a's live pre-lane injection target, and a plain
    // `realpathSync` + case-sensitive `startsWith` is defeated on win32 by an 8.3 short name or a
    // drive-letter case flip (§2m(4)). The symlink refusal is inside it, still ordered first.
    const candidate = canonicalizePathForContainment(resolvedCandidate)
    const root = canonicalizePathForContainment(rootPath)
    if (candidate.kind !== 'canonical' || root.kind !== 'canonical') {
      return null
    }
    const canonicalCandidate = candidate.path
    const canonicalRoot = root.path
    if (
      canonicalCandidate === canonicalRoot ||
      !isCanonicalPathWithinRoot(canonicalRoot, canonicalCandidate)
    ) {
      return null
    }
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const relativeParts = relativePath.split(sep)
    const escaped = relativePath.startsWith('..') || relativePath.includes(`..${sep}`)
    if (
      escaped ||
      relativeParts.length !== 2 ||
      relativeParts[0] !== accountId ||
      relativeParts[1] !== 'auth'
    ) {
      return null
    }
    const markerPath = join(canonicalCandidate, MANAGED_AUTH_MARKER)
    const markerValid = isManagedAuthMarkerValid(markerPath, accountId)
    if (!markerValid && options.adoptLegacyMarker) {
      writeFileSync(markerPath, `${accountId}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    }
    if (!markerValid && !isManagedAuthMarkerValid(markerPath, accountId)) {
      return null
    }
    return canonicalCandidate
  } catch {
    return null
  }
}

export function readClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json' | '.claude.json' | '.config.json'
): string | null {
  const filePath = resolve(managedAuthPath, filename)
  try {
    if (!isOwnedChildFile(managedAuthPath, filePath)) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function writeClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json',
  contents: string
): void {
  const filePath = resolve(managedAuthPath, filename)
  if (existsSync(filePath) && !isOwnedChildFile(managedAuthPath, filePath)) {
    throw new Error('Managed Claude auth child file is not owned by Orca.')
  }
  writeFileAtomically(filePath, contents, { mode: 0o600 })
}

function isManagedAuthMarkerValid(markerPath: string, accountId: string): boolean {
  try {
    if (
      !existsSync(markerPath) ||
      lstatSync(markerPath).isSymbolicLink() ||
      !lstatSync(markerPath).isFile()
    ) {
      return false
    }
    return readFileSync(markerPath, 'utf-8').trim() === accountId
  } catch {
    return false
  }
}

function isOwnedChildFile(managedAuthPath: string, filePath: string): boolean {
  if (
    !existsSync(filePath) ||
    lstatSync(filePath).isSymbolicLink() ||
    !lstatSync(filePath).isFile()
  ) {
    return false
  }
  // Same containment rule as the store's own check above, for the same win32 reason.
  const canonicalAuthPath = canonicalizePathForContainment(managedAuthPath)
  const canonicalFilePath = canonicalizePathForContainment(filePath)
  if (canonicalAuthPath.kind !== 'canonical' || canonicalFilePath.kind !== 'canonical') {
    return false
  }
  return (
    canonicalFilePath.path !== canonicalAuthPath.path &&
    isCanonicalPathWithinRoot(canonicalAuthPath.path, canonicalFilePath.path)
  )
}
