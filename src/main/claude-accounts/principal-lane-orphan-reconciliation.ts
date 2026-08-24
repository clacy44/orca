import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getClaudeLanesRoot } from './claude-lanes-root'
import { isLaneMarkerValid, isPrincipalId } from './principal-credential-lane'

export type OrphanLaneReconciliationInput = {
  /** Principals that still hold at least one surviving bound grant. */
  boundPrincipalIds: readonly string[]
  /** `DeviceRegistry.loadSucceeded` — a caught load throw yields zero devices, not zero grants. */
  registryLoadSucceeded: boolean
  lanesRoot?: string
}

export type OrphanLaneReconciliationResult = {
  deletedPrincipalIds: string[]
  skipped: 'registry-load-failed' | 'registry-empty' | null
}

/**
 * Deletes lane directories no surviving bound grant claims — revoke-time wiping does not cover a
 * registry rebuild or a restore-from-backup (S9 §2a).
 *
 * Gated on BOTH a successful registry load and a non-empty result. `DeviceRegistry.load` wraps its
 * whole read/normalize in a bare catch that yields zero devices, and a missing file reports a
 * successful load of nothing — either read unconditionally would delete EVERY lane on the host,
 * including the transcripts the wipe deliberately preserves.
 */
export function reconcileOrphanPrincipalLanes(
  input: OrphanLaneReconciliationInput
): OrphanLaneReconciliationResult {
  if (!input.registryLoadSucceeded) {
    return { deletedPrincipalIds: [], skipped: 'registry-load-failed' }
  }
  if (input.boundPrincipalIds.length === 0) {
    return { deletedPrincipalIds: [], skipped: 'registry-empty' }
  }
  const lanesRoot = input.lanesRoot ?? getClaudeLanesRoot()
  if (!existsSync(lanesRoot)) {
    return { deletedPrincipalIds: [], skipped: null }
  }
  const bound = new Set(input.boundPrincipalIds)
  const deletedPrincipalIds: string[] = []
  for (const entry of readdirSync(lanesRoot, { withFileTypes: true })) {
    // Why: only ever delete a directory whose name is a validated principal id — a stray file or a
    // foreign directory under this root is not a lane and is not this sweep's business.
    if (!entry.isDirectory() || !isPrincipalId(entry.name) || bound.has(entry.name)) {
      continue
    }
    const laneDir = join(lanesRoot, entry.name)
    // Why the marker too: a foreign directory NAMED as a v4 UUID passes the check above, and every
    // other lane operation proves ownership before acting. Cost, stated: a lane whose marker a
    // failed DACL verification dropped is left in place for a re-provision to recover.
    if (!isLaneMarkerValid(laneDir, entry.name)) {
      continue
    }
    rmSync(laneDir, { recursive: true, force: true })
    deletedPrincipalIds.push(entry.name)
  }
  return { deletedPrincipalIds, skipped: null }
}
