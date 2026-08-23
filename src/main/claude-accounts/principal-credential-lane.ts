import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  canonicalizePathForContainment,
  isCanonicalPathWithinRoot,
  isRemoteUncLanePath
} from '../../shared/lane-path-containment'
import { restrictWindowsPathSync } from '../../shared/secure-path-windows-acl'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getClaudeLanesRoot } from './claude-lanes-root'
import { ensureLaneProvenanceLabel } from './principal-lane-provenance'
import { sweepLaneCredentialTempArtifacts } from './principal-lane-credential-sweep'

const LANE_MARKER_FILENAME = '.orca-principal-lane'

// The exact shape `randomUUID()` mints, which is what the device registry mints its ids in
// (`device-registry.ts:92`). Validated AT CREATION so no principal id ever reaches path.join
// unvalidated; containment below is defence-in-depth, not the primary check.
const PRINCIPAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type PrincipalLaneOptions = {
  lanesRoot?: string
  platform?: NodeJS.Platform
  /** Injectable so the fail-closed arm is observable off Windows; production passes the real ACL call. */
  restrictWindowsPath?: (targetPath: string, isDirectory: boolean) => boolean
}

export type ProvisionedPrincipalLane = {
  laneDir: string
  provenanceLabel: string
}

export function isPrincipalId(value: string): boolean {
  return PRINCIPAL_ID_PATTERN.test(value)
}

export function assertPrincipalId(value: string): void {
  if (!isPrincipalId(value)) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.principal_id_invalid',
      'That principal id is not in the host-minted UUID shape Orca requires for a credential lane. Mint the principal through the pairing consent surface instead of naming one by hand.'
    )
  }
}

/** `<userData>/claude-lanes/<principalId>/`, used verbatim as that principal's CLAUDE_CONFIG_DIR. */
export function getPrincipalLaneDir(
  principalId: string,
  options: PrincipalLaneOptions = {}
): string {
  assertPrincipalId(principalId)
  return join(options.lanesRoot ?? getClaudeLanesRoot(), principalId)
}

/**
 * Creates the lane and hardens it, failing closed rather than degrading (S9 §2a, §2m(1)).
 *
 * POSIX gets `0700` on the directory (files are written `0600` by their own writers). On win32
 * the mode bit is inert, so the lane takes the SYNCHRONOUS ACL arm and its boolean is CHECKED —
 * the ordinary directory-hardening path is async, best-effort and caches the path as hardened
 * whether or not the ACL landed (`secure-file.ts:59-73`), which is not good enough for the
 * directory a credential is about to land in. A lane whose DACL cannot be verified does not exist:
 * a re-provision that fails the read-back drops the ownership marker, so the launch path stops
 * resolving that lane until a provisioning verifies it again.
 *
 * A native lane root must be a LOCAL drive path: a remote UNC share's ACLs are set by a machine
 * this design has said nothing about, so it is refused here rather than hardened (§2m(4)).
 *
 * A `\\wsl.localhost\…` root skips the DACL step entirely rather than failing on it: that lane's
 * isolation control is S9e's in-distro `chmod 0700/0600` read-back, and `restrictWindowsPathSync`
 * returns FALSE (not a no-op) on a path it cannot set a DACL on.
 */
export function provisionPrincipalLane(
  principalId: string,
  options: PrincipalLaneOptions = {}
): ProvisionedPrincipalLane {
  const lanesRoot = options.lanesRoot ?? getClaudeLanesRoot()
  const laneDir = getPrincipalLaneDir(principalId, options)
  if (isRemoteUncLanePath(laneDir, options.platform ?? process.platform)) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.lane_root_not_local',
      "This person's credential lane would sit on a network share, whose permissions are set by a machine Orca cannot check, so Orca refused to create it. Point Orca's data folder at a local drive and provision the lane again."
    )
  }
  const existedBefore = assertLaneDirectoryWritable(lanesRoot, laneDir)
  mkdirSync(laneDir, { recursive: true, mode: 0o700 })
  try {
    hardenLaneDirectory(laneDir, options)
  } catch (error) {
    // Why the marker rather than the tree, for a lane that already existed: a lane whose DACL no
    // longer verifies must stop resolving — every reader proves ownership through the marker —
    // while its credential and settings survive a re-provision that does verify. A creation that
    // fails leaves nothing behind at all.
    if (existedBefore) {
      rmSync(join(laneDir, LANE_MARKER_FILENAME), { force: true })
    } else {
      rmSync(laneDir, { recursive: true, force: true })
    }
    throw error
  }
  try {
    writeLaneMarker(laneDir, principalId)
  } catch (error) {
    // Why: no lane may exist unverified; only remove what this call created.
    if (!existedBefore) {
      rmSync(laneDir, { recursive: true, force: true })
    }
    throw error
  }
  // Why: a re-provision must not inherit a staged credential blob from a crashed write. A loaded
  // lane's own `.credentials.json` is left alone — provisioning is idempotent, not a wipe.
  sweepLaneCredentialTempArtifacts(laneDir)
  return { laneDir, provenanceLabel: ensureLaneProvenanceLabel(laneDir) }
}

/**
 * Opens a provisioned lane for use: proves Orca owns it, then sweeps stray credential temps.
 *
 * Ownership is `managed-auth-path.ts:12-57`'s discipline re-parameterised for this key rather
 * than borrowed as-is — that check hardcodes a two-segment `<accountId>/auth` shape, and a lane
 * is one segment under the lanes root.
 */
export function openPrincipalLane(
  principalId: string,
  options: PrincipalLaneOptions = {}
): string | null {
  const laneDir = resolveOwnedPrincipalLaneDir(principalId, options)
  if (!laneDir) {
    return null
  }
  sweepLaneCredentialTempArtifacts(laneDir)
  return laneDir
}

/** The canonical lane directory, or null when anything about its ownership fails to prove out. */
export function resolveOwnedPrincipalLaneDir(
  principalId: string,
  options: PrincipalLaneOptions = {}
): string | null {
  assertPrincipalId(principalId)
  const lanesRoot = options.lanesRoot ?? getClaudeLanesRoot()
  const canonicalLane = resolveContainedLaneDir(lanesRoot, join(lanesRoot, principalId))
  if (!canonicalLane) {
    return null
  }
  return isLaneMarkerValid(canonicalLane, principalId) ? canonicalLane : null
}

/** The canonical lane path when it is a real, non-link, one-segment child of the lanes root. */
function resolveContainedLaneDir(lanesRoot: string, laneDir: string): string | null {
  if (!existsSync(laneDir) || !existsSync(lanesRoot)) {
    return null
  }
  const canonicalLane = canonicalizePathForContainment(laneDir)
  const canonicalRoot = canonicalizePathForContainment(lanesRoot)
  if (canonicalLane.kind !== 'canonical' || canonicalRoot.kind !== 'canonical') {
    return null
  }
  if (
    canonicalLane.path === canonicalRoot.path ||
    !isCanonicalPathWithinRoot(canonicalRoot.path, canonicalLane.path)
  ) {
    return null
  }
  const relativeParts = relative(canonicalRoot.path, canonicalLane.path).split(sep)
  if (relativeParts.length !== 1 || !isPrincipalId(relativeParts[0] ?? '')) {
    return null
  }
  return canonicalLane.path
}

/**
 * Proves a pre-existing lane path is Orca's own before provisioning writes through it, and
 * reports whether it existed (§2a, §2m(4)).
 *
 * The symlink/junction refusal is ordered FIRST because a Windows junction reports as both a
 * symlink and a directory, and it needs no privilege to plant — so it is the cheap escape a
 * `--config-dir` capture would use. `lstatSync` rather than `existsSync`: a DANGLING link is not
 * an absent path, and `mkdirSync` would follow it.
 */
function assertLaneDirectoryWritable(lanesRoot: string, laneDir: string): boolean {
  const planted = lstatOrNull(laneDir)
  if (!planted) {
    return false
  }
  if (
    planted.isSymbolicLink() ||
    !planted.isDirectory() ||
    !resolveContainedLaneDir(lanesRoot, laneDir)
  ) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.lane_path_not_contained',
      "Something other than this person's own credential lane already sits at that path — a link, a file, or a directory that resolves outside Orca's lanes folder — so Orca refused to write to it. Remove it by hand and provision the lane again."
    )
  }
  return true
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** Deprovisioning removes the lane whatever the grant count — the same consent UI as provisioning. */
export function deprovisionPrincipalLane(
  principalId: string,
  options: PrincipalLaneOptions = {}
): boolean {
  const laneDir = resolveOwnedPrincipalLaneDir(principalId, options)
  if (!laneDir) {
    return false
  }
  rmSync(laneDir, { recursive: true, force: true })
  return true
}

/**
 * Whether this lane's isolation rests on a verified Windows DACL.
 *
 * False for a `\\wsl.localhost\…` root: that lane is written through the WSL redirector, whose
 * far side carries Linux modes rather than a DACL, and `restrictWindowsPathSync` returns FALSE
 * there — so an unscoped rule would refuse every S9e lane instead of skipping the step (§2m(1)).
 */
export function requiresVerifiedWindowsDacl(
  laneDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && !parseWslUncPath(laneDir)
}

function hardenLaneDirectory(laneDir: string, options: PrincipalLaneOptions): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    chmodSync(laneDir, 0o700)
    return
  }
  if (!requiresVerifiedWindowsDacl(laneDir, platform)) {
    return
  }
  const restrictPath = options.restrictWindowsPath ?? restrictWindowsPathSync
  if (!restrictPath(laneDir, true)) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.provision_dacl_unverified',
      "Orca could not verify this credential lane's Windows permissions, so the lane was not created. Check that PowerShell is available to Orca and try again; a lane whose access list cannot be read back is never used."
    )
  }
}

function writeLaneMarker(laneDir: string, principalId: string): void {
  const markerPath = join(laneDir, LANE_MARKER_FILENAME)
  if (isLaneMarkerValid(laneDir, principalId)) {
    return
  }
  if (existsSync(markerPath)) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.lane_not_owned_by_orca',
      "That credential lane directory already exists and is not marked as this person's Orca lane. Remove it by hand and provision the lane again."
    )
  }
  writeFileSync(markerPath, `${principalId}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
}

function isLaneMarkerValid(laneDir: string, principalId: string): boolean {
  const markerPath = join(laneDir, LANE_MARKER_FILENAME)
  try {
    if (!existsSync(markerPath)) {
      return false
    }
    const stats = lstatSync(markerPath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return false
    }
    return readFileSync(markerPath, 'utf-8').trim() === principalId
  } catch {
    return false
  }
}
