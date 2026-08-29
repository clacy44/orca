import { chmodSync, existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  getLaneAccountsRoot,
  isLaneAccountId,
  readLaneAccountIndexRaw,
  writeLaneAccountIndex,
  type LaneAccountIndexRow
} from './lane-account-index'
import { resolveContainedLaneAccountEntry } from './principal-lane-account-store'
import { readClaudeManagedAuthFile, resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'

/**
 * Startup reconciliation for one lane's `claude-accounts` store (S9-L1 B4/§storeLayout).
 *
 * Directory ENTRIES only — `index.json` and its `.tmp` staging siblings are not accounts and are
 * never inspected here (removing them is `purgeLaneAccountStore`'s job, not this one's).
 *
 * Arm A (index parsed): DELETE every unindexed directory, DROP every row whose directory or
 * credential is missing, re-read under `LANE_SWEEP_PASSES` passes so a directory that keeps
 * reappearing — a login child from a previous process still writing — is caught rather than
 * silently reported clean.
 *
 * Arm B (index missing, unparseable, or parses empty over a store that is not): every unindexed
 * directory is QUARANTINED IN PLACE — renamed `<laneAccountId>.quarantined-<ts>` — and NOTHING is
 * deleted. A parse failure is evidence about the INDEX, not about the directories it fails to
 * vouch for; a quarantined name is not the v4-UUID shape a lane account id validates against, so
 * no later pass mistakes it for an account and `listLaneAccounts` never offers it. It IS in
 * `purgeLaneAccountStore`'s scope, so the lane's next logout/revoke/deprovision removes it.
 *
 * An absent index over an absent or empty root is NEITHER arm — the ordinary state of a lane that
 * never logged in, or was just logged out — and this does nothing.
 *
 * DEVIATION FROM THE TASK BRIEF'S PARAPHRASE, RECORDED: the dispatching brief described arm A as
 * quarantining unindexed dirs into a `.quarantine/<ts>-<id>` subdirectory and arm B as
 * quarantining everything the same way. Both `plan.md` §modules (B4) and §storeLayout — read in
 * full per the brief's own instruction, and consistent with each other — instead describe arm A
 * as DELETING unindexed dirs and arm B as an in-place `<id>.quarantined-<ts>` rename with nothing
 * deleted. Implemented per the plan; the brief's paraphrase not followed.
 *
 * WHAT THIS FUNCTION DOES NOT DO, named rather than silently short: it does not publish
 * `laneState`/`laneWipePending` on a surviving-child reappearance (that wiring is module C's
 * `lane-wipe-pending.ts`, out of this slice's scope) — it reports `reappeared: true` and logs, and
 * leaves the publish to whichever slice lands the wipe-fence wiring.
 */

export const LANE_SWEEP_PASSES = 3

export type LaneAccountReconciliationResult = {
  arm: 'a' | 'b' | 'none'
  deletedLaneAccountIds: string[]
  quarantinedLaneAccountIds: string[]
  droppedDanglingLaneAccountIds: string[]
  /** A directory survived (or reappeared after) a deletion pass — something is still writing it. */
  reappeared: boolean
}

export type LaneAccountReconciliationOptions = {
  /** Test-only seam mirroring `wipeLaneCredentials`'s `onSweptPass`: fires after each arm-A pass. */
  onSweptPass?: (pass: number) => void
  /** Test-only seam; defaults to `process.platform`. */
  platform?: NodeJS.Platform
}

export function reconcileLaneAccountStore(
  laneDir: string,
  options: LaneAccountReconciliationOptions = {}
): LaneAccountReconciliationResult {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  if (!existsSync(laneAccountsRoot)) {
    return noopResult()
  }
  // A store this old may predate the 0700 `mkdirSync` mode fix — reconciliation is startup-run,
  // so it is where a pre-existing root gets corrected regardless of which arm (or neither) runs
  // below. POSIX only: on win32 the ACL comes from the lane dir itself and is inherited, and
  // Node's `chmodSync` mode bits are meaningless there besides. `chmodSync` follows symlinks (it
  // is not `lchmodSync`), so the root is `lstatSync`-checked and the chmod refused when it is a
  // symlink — same containment discipline `prepareContainedLanesRoot` and
  // `resolveContainedLaneAccountEntry` already hold elsewhere in this store: a same-privilege
  // swap of `claude-accounts` for a symlink must never let this startup pass rewrite an
  // unrelated directory's permissions.
  if ((options.platform ?? process.platform) !== 'win32') {
    try {
      if (!lstatSync(laneAccountsRoot).isSymbolicLink()) {
        chmodSync(laneAccountsRoot, 0o700)
      }
    } catch {
      // Best effort: reconciliation's own passes matter more than this doubly-defensive chmod.
    }
  }
  const outcome = readLaneAccountIndexRaw(laneAccountsRoot)
  const entries = listLaneAccountEntries(laneAccountsRoot)

  if (outcome.kind === 'missing' && entries.length === 0) {
    return noopResult()
  }

  const isArmB =
    outcome.kind === 'invalid' ||
    outcome.kind === 'missing' ||
    (outcome.kind === 'rows' && outcome.rows.length === 0 && entries.length > 0)

  if (isArmB) {
    const quarantinedLaneAccountIds = quarantineAll(laneAccountsRoot, entries)
    writeLaneAccountIndex(laneAccountsRoot, [])
    logReconciliation(laneDir, 'b', quarantinedLaneAccountIds.length, outcome.kind)
    return {
      arm: 'b',
      deletedLaneAccountIds: [],
      quarantinedLaneAccountIds,
      droppedDanglingLaneAccountIds: [],
      reappeared: false
    }
  }

  const rows = outcome.kind === 'rows' ? outcome.rows : []
  const { deletedLaneAccountIds, reappeared } = deleteUnindexedWithReread(
    laneAccountsRoot,
    rows,
    options.onSweptPass
  )
  const droppedDanglingLaneAccountIds = dropDanglingRows(laneAccountsRoot, rows)
  logReconciliation(laneDir, 'a', deletedLaneAccountIds.length, outcome.kind)
  return {
    arm: 'a',
    deletedLaneAccountIds,
    quarantinedLaneAccountIds: [],
    droppedDanglingLaneAccountIds,
    reappeared
  }
}

/** Only directory entries shaped like a lane account id — a quarantined sibling never re-enters. */
function listLaneAccountEntries(laneAccountsRoot: string): string[] {
  return readdirSync(laneAccountsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isLaneAccountId(entry.name))
    .map((entry) => entry.name)
}

function deleteUnindexedWithReread(
  laneAccountsRoot: string,
  rows: readonly LaneAccountIndexRow[],
  onSweptPass?: (pass: number) => void
): { deletedLaneAccountIds: string[]; reappeared: boolean } {
  const rowIds = new Set(rows.map((row) => row.laneAccountId))
  const deletedLaneAccountIds: string[] = []
  let reappeared = false
  for (let pass = 1; pass <= LANE_SWEEP_PASSES; pass += 1) {
    const unindexed = listLaneAccountEntries(laneAccountsRoot).filter((name) => !rowIds.has(name))
    if (unindexed.length === 0) {
      break
    }
    if (pass > 1) {
      // Deleted in an earlier pass within this same call, and back by this re-read: a process
      // outside this one is still writing it.
      reappeared = true
    }
    for (const name of unindexed) {
      const contained = resolveContainedLaneAccountEntry(laneAccountsRoot, name)
      if (!contained) {
        continue
      }
      rmSync(contained, { recursive: true, force: true })
      if (!deletedLaneAccountIds.includes(name)) {
        deletedLaneAccountIds.push(name)
      }
    }
    onSweptPass?.(pass)
  }
  return { deletedLaneAccountIds, reappeared }
}

function dropDanglingRows(
  laneAccountsRoot: string,
  rows: readonly LaneAccountIndexRow[]
): string[] {
  const survivingEntries = new Set(listLaneAccountEntries(laneAccountsRoot))
  const keptRows: LaneAccountIndexRow[] = []
  const droppedLaneAccountIds: string[] = []
  for (const row of rows) {
    const authDir = survivingEntries.has(row.laneAccountId)
      ? resolveOwnedClaudeManagedAuthPath(
          row.laneAccountId,
          join(laneAccountsRoot, row.laneAccountId, 'auth'),
          { root: laneAccountsRoot }
        )
      : null
    const hasCredential =
      authDir !== null && readClaudeManagedAuthFile(authDir, '.credentials.json') !== null
    if (authDir && hasCredential) {
      keptRows.push(row)
    } else {
      droppedLaneAccountIds.push(row.laneAccountId)
    }
  }
  if (droppedLaneAccountIds.length > 0) {
    writeLaneAccountIndex(laneAccountsRoot, keptRows)
  }
  return droppedLaneAccountIds
}

function quarantineAll(laneAccountsRoot: string, entries: readonly string[]): string[] {
  const timestamp = Date.now()
  const quarantined: string[] = []
  for (const name of entries) {
    const contained = resolveContainedLaneAccountEntry(laneAccountsRoot, name)
    if (!contained) {
      continue
    }
    const target = join(laneAccountsRoot, `${name}.quarantined-${timestamp}`)
    try {
      renameSync(contained, target)
      quarantined.push(name)
    } catch {
      // Best effort: a failed rename leaves the directory in place for the next pass to retry —
      // never deleted, per this arm's own rule.
    }
  }
  return quarantined
}

function logReconciliation(
  laneDir: string,
  arm: 'a' | 'b',
  count: number,
  reason: 'missing' | 'invalid' | 'rows'
): void {
  if (arm === 'a' && count === 0) {
    return
  }
  console.warn(
    `[claude-lane-accounts] reconciliation arm ${arm} on ${laneDir}: ${count} ${
      arm === 'a' ? 'unindexed director(ies) deleted' : 'director(ies) quarantined'
    } (index ${reason}).`
  )
}

function noopResult(): LaneAccountReconciliationResult {
  return {
    arm: 'none',
    deletedLaneAccountIds: [],
    quarantinedLaneAccountIds: [],
    droppedDanglingLaneAccountIds: [],
    reappeared: false
  }
}
