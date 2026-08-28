import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  canonicalizePathForContainment,
  isCanonicalPathWithinRoot
} from '../../shared/lane-path-containment'
import { LaneCredentialWriter } from './lane-credential-writer'
import {
  getLaneAccountsRoot,
  isLaneAccountId,
  LANE_ACCOUNT_INDEX_FILENAME,
  readLaneAccountIndex,
  writeLaneAccountIndex,
  type LaneAccountIndexRow
} from './lane-account-index'
import { readClaudeManagedAuthFile, resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from './live-pty-gate'

/**
 * The per-lane account store (S9-L1 B2/§storeLayout): every login a lane has ever captured, one
 * of which — at most — is the lane's ACTIVE credential (`<lane>/.credentials.json`).
 *
 * `listLaneAccounts` JOINS the index to the directories it names; it never walks. Every mutator
 * here proves containment itself rather than trusting a caller-supplied id's shape, because the
 * index is untrusted input the moment it is read off disk (S9-L1 §storeLayout "THE INDEX IS THE
 * AUTHORITY").
 */

/** Refused before any spawn — counted on index rows, per §storeLayout. */
export const MAX_LANE_LOGINS = 8

export type LaneAccount = LaneAccountIndexRow & {
  /** The resolved, ownership-proved `<lane>/claude-accounts/<id>/auth` directory. */
  authDir: string
}

/**
 * Index rows joined to their directories — NEVER a directory walk (§storeLayout).
 *
 * A directory with no row is an orphan by construction and is never offered, whatever it holds.
 * A row whose directory or credential is missing is dropped from what is RETURNED here; the
 * index file itself is left alone — reconciliation (B4) is what removes a dangling row on disk,
 * because a read must not have write side effects a concurrent reconciliation pass could race.
 *
 * An unreadable or unparseable index costs this lane its listing and nothing else: this returns
 * empty rather than falling back to a walk, which would offer a human a directory whose identity
 * the host cannot vouch for.
 */
export function listLaneAccounts(laneDir: string): LaneAccount[] {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  const rows = readLaneAccountIndex(laneAccountsRoot)
  const accounts: LaneAccount[] = []
  for (const row of rows) {
    const authDir = resolveLaneAccountAuthDir(laneAccountsRoot, row.laneAccountId)
    if (authDir && hasCompleteCredential(authDir)) {
      accounts.push({ ...row, authDir })
    }
  }
  return accounts
}

/** Refuses `login_store_full` before a login mints a new row — the login session slice's gate. */
export function assertLaneAccountStoreHasRoom(laneDir: string): void {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  if (readLaneAccountIndex(laneAccountsRoot).length >= MAX_LANE_LOGINS) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.login_store_full',
      'This lane already holds the maximum number of signed-in accounts, so Orca did not start a new login. Remove an account you no longer need, then try again.'
    )
  }
}

/**
 * Selection's WRITE step — S9-L1 B2: "expose the write step as a function the session slice will
 * call inside the [caller's] `serializeLaneWrite` turn; do not open a turn yourself." Whoever
 * calls this MUST already hold that lane's write queue turn, the same one the login capture and
 * the wipe use, so a select queued behind either is refused or applied in queue order rather than
 * racing them.
 *
 * Looked up on EVERY call rather than once at some earlier "prepare" step, so a select queued
 * behind a wipe sees the post-wipe index (empty) and refuses `account_unknown` ON ITS TURN — not
 * against a snapshot taken before the wipe ran.
 */
export async function selectLaneAccount(
  laneDir: string,
  laneId: string,
  laneAccountId: string,
  writer: Pick<
    LaneCredentialWriter,
    'writeCredentials' | 'writeOauthAccount'
  > = new LaneCredentialWriter()
): Promise<void> {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  const rows = readLaneAccountIndex(laneAccountsRoot)
  const row = rows.find((candidate) => candidate.laneAccountId === laneAccountId)
  const authDir = row ? resolveLaneAccountAuthDir(laneAccountsRoot, laneAccountId) : null
  const credentialsJson = authDir ? readClaudeManagedAuthFile(authDir, '.credentials.json') : null
  if (!row || !authDir || credentialsJson === null) {
    throw accountUnknownRefusal()
  }
  const oauthAccountText = readClaudeManagedAuthFile(authDir, 'oauth-account.json')
  const oauthAccount = parseOauthAccount(oauthAccountText)
  beginClaudeAuthSwitch(laneId)
  try {
    await writer.writeCredentials(laneDir, credentialsJson)
    if (oauthAccount !== null) {
      writer.writeOauthAccount(laneDir, oauthAccount)
    }
    writeLaneAccountIndex(
      laneAccountsRoot,
      rows.map((candidate) => ({
        ...candidate,
        active: candidate.laneAccountId === laneAccountId
      }))
    )
  } finally {
    endClaudeAuthSwitch(laneId)
  }
}

/**
 * Removes one captured login's directory and its index row. Refuses the lane's ACTIVE login
 * unless the lane is being logged out (`options.loggingOut`) — a bare removal would otherwise
 * leave `<lane>/.credentials.json` pointed at a grant this store no longer lists at all.
 */
export function removeLaneAccount(
  laneDir: string,
  laneAccountId: string,
  options: { loggingOut?: boolean } = {}
): void {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  const rows = readLaneAccountIndex(laneAccountsRoot)
  const row = rows.find((candidate) => candidate.laneAccountId === laneAccountId)
  if (!row) {
    throw accountUnknownRefusal()
  }
  if (row.active && !options.loggingOut) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.account_active',
      'That account is the one this lane is signed in as right now, so Orca did not remove it. Select a different account first, or log this lane out if you want to remove it too.'
    )
  }
  const contained = resolveContainedLaneAccountEntry(laneAccountsRoot, laneAccountId)
  if (contained) {
    rmSync(contained, { recursive: true, force: true })
  }
  writeLaneAccountIndex(
    laneAccountsRoot,
    rows.filter((candidate) => candidate.laneAccountId !== laneAccountId)
  )
}

/**
 * A directory walk under the lane's OWN `claude-accounts` root, with canonical containment and
 * symlink refusal ordered first (§storeLayout "PURGE"). Deliberately NOT a loop over
 * `listLaneAccounts` and NOT gated on `resolveOwnedClaudeManagedAuthPath` returning non-null: a
 * crashed login's directory is exactly the one whose index row was never written and whose
 * marker may be missing, and a marker-gated purge would certify a lane empty while that
 * directory still held a complete grant at rest.
 *
 * Removes every `<laneAccountId>` directory (marker or no marker), every
 * `<laneAccountId>.quarantined-<ts>` directory the reconciler (B4) left behind, and `index.json`
 * with its `.tmp` staging siblings. Leaves `settings.json`, mirrored user content and transcripts
 * alone — none of those live under `claude-accounts`, so a root-scoped walk cannot reach them.
 */
export function purgeLaneAccountStore(laneDir: string): string[] {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  if (!existsSync(laneAccountsRoot)) {
    return []
  }
  const removed: string[] = []
  for (const entry of readdirSync(laneAccountsRoot, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (entry.name === LANE_ACCOUNT_INDEX_FILENAME || isLaneAccountIndexTmpSibling(entry.name)) {
        rmSync(join(laneAccountsRoot, entry.name), { force: true })
        removed.push(entry.name)
      }
      continue
    }
    if (!entry.isDirectory()) {
      continue
    }
    const contained = resolveContainedLaneAccountEntry(laneAccountsRoot, entry.name)
    if (!contained) {
      // A symlink or an escape: not a directory this walk may act on. Left in place rather than
      // silently certified purged.
      continue
    }
    rmSync(contained, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

/**
 * A direct, non-symlink child of `laneAccountsRoot`, canonically contained within it. Shared by
 * `removeLaneAccount`, `purgeLaneAccountStore` and B4's reconciliation — none of the three may
 * trust an entry NAME's shape alone (a quarantined name is not a v4 UUID, and a crashed or
 * hostile write could plant a symlink under either shape).
 */
export function resolveContainedLaneAccountEntry(
  laneAccountsRoot: string,
  entryName: string
): string | null {
  const candidateResult = canonicalizePathForContainment(join(laneAccountsRoot, entryName))
  const rootResult = canonicalizePathForContainment(laneAccountsRoot)
  if (candidateResult.kind !== 'canonical' || rootResult.kind !== 'canonical') {
    return null
  }
  if (
    candidateResult.path === rootResult.path ||
    !isCanonicalPathWithinRoot(rootResult.path, candidateResult.path)
  ) {
    return null
  }
  const relativeParts = relative(rootResult.path, candidateResult.path).split(sep)
  return relativeParts.length === 1 ? candidateResult.path : null
}

function resolveLaneAccountAuthDir(laneAccountsRoot: string, laneAccountId: string): string | null {
  if (!isLaneAccountId(laneAccountId)) {
    return null
  }
  return resolveOwnedClaudeManagedAuthPath(
    laneAccountId,
    join(laneAccountsRoot, laneAccountId, 'auth'),
    { root: laneAccountsRoot }
  )
}

function hasCompleteCredential(authDir: string): boolean {
  return readClaudeManagedAuthFile(authDir, '.credentials.json') !== null
}

function parseOauthAccount(text: string | null): unknown {
  if (text === null) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isLaneAccountIndexTmpSibling(name: string): boolean {
  return name.startsWith(`${LANE_ACCOUNT_INDEX_FILENAME}.`) && name.endsWith('.tmp')
}

function accountUnknownRefusal(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.account_unknown',
    'Orca has no record of that account in this lane — it may already have been removed, or a logout may have cleared the lane — so nothing changed. Refresh the account list and try again.'
  )
}
