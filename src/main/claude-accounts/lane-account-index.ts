import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/**
 * `<lane>/claude-accounts/index.json` — the per-lane account store's AUTHORITY (S9-L1
 * §storeLayout).
 *
 * It is NOT held in `principal-lane-store.ts`/`persistence.ts`: `Persistence.load` falls back to
 * `getDefaultPersistedState` on a corrupt file, and an index kept there would mean "delete every
 * login in every lane on this host" the moment one collection reads empty. Kept in the lane
 * instead, a corrupt index costs that ONE lane its listing — never the credential it already
 * holds, and never any other lane.
 */

export const LANE_ACCOUNTS_DIRNAME = 'claude-accounts'
export const LANE_ACCOUNT_INDEX_FILENAME = 'index.json'

// The shape a lane-local account id is minted in (a v4 UUID, same family as `randomUUID()`
// mints elsewhere in this tree) — never the desktop's own managed account id, which the host
// does not have and must not be told (§storeLayout).
const LANE_ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isLaneAccountId(value: string): boolean {
  return LANE_ACCOUNT_ID_PATTERN.test(value)
}

export type LaneAccountIndexRow = {
  laneAccountId: string
  email: string
  label: string | null
  active: boolean
  capturedAt: string
}

export function getLaneAccountsRoot(laneDir: string): string {
  return join(laneDir, LANE_ACCOUNTS_DIRNAME)
}

export function getLaneAccountIndexPath(laneAccountsRoot: string): string {
  return join(laneAccountsRoot, LANE_ACCOUNT_INDEX_FILENAME)
}

export type LaneAccountIndexReadOutcome =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'rows'; rows: LaneAccountIndexRow[] }

/**
 * The raw read, distinguishing "no file" from "a file that will not parse" — B4's reconciliation
 * needs both to choose its arm; nothing else does.
 */
export function readLaneAccountIndexRaw(laneAccountsRoot: string): LaneAccountIndexReadOutcome {
  const indexPath = getLaneAccountIndexPath(laneAccountsRoot)
  if (!existsSync(indexPath)) {
    return { kind: 'missing' }
  }
  let text: string
  try {
    text = readFileSync(indexPath, 'utf-8')
  } catch {
    return { kind: 'invalid' }
  }
  const rows = parseLaneAccountIndexRows(text)
  return rows ? { kind: 'rows', rows } : { kind: 'invalid' }
}

/**
 * Tolerant read for every OTHER caller: a missing file and an unparseable one both read as no
 * accounts, and never fall back to a directory walk (B2 `listLaneAccounts`'s rule) — a walk would
 * offer a human a directory whose identity and label the host cannot vouch for.
 */
export function readLaneAccountIndex(laneAccountsRoot: string): LaneAccountIndexRow[] {
  const outcome = readLaneAccountIndexRaw(laneAccountsRoot)
  return outcome.kind === 'rows' ? outcome.rows : []
}

/** 0600, atomic — the same discipline every other credential-adjacent write in this tree uses. */
export function writeLaneAccountIndex(
  laneAccountsRoot: string,
  rows: readonly LaneAccountIndexRow[]
): void {
  // 0700 like the lane dir itself (`principal-credential-lane.ts`'s `mkdirSync(laneDir, ...,
  // { mode: 0o700 })`) — a bare `mkdirSync` here defaults to the process umask (0755 on a typical
  // host), leaving this store world-readable under a 0700 lane. `recursive: true` applies the mode
  // to every directory it creates, not just the leaf, so this is also correct the first time a
  // fresh lane's `claude-accounts` root is created via this path.
  mkdirSync(laneAccountsRoot, { recursive: true, mode: 0o700 })
  writeFileAtomically(
    getLaneAccountIndexPath(laneAccountsRoot),
    `${JSON.stringify(rows, null, 2)}\n`,
    {
      mode: 0o600
    }
  )
}

/**
 * One malformed row invalidates the whole file rather than being dropped alone: a row whose
 * shape is wrong is evidence the INDEX is corrupt, not evidence about that one login — the same
 * reasoning §storeLayout gives for treating a parse failure as arm B rather than a per-row fixup.
 */
function parseLaneAccountIndexRows(text: string): LaneAccountIndexRow[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) {
    return null
  }
  const rows: LaneAccountIndexRow[] = []
  for (const entry of parsed) {
    const row = asValidRow(entry)
    if (!row) {
      return null
    }
    rows.push(row)
  }
  return rows
}

function asValidRow(value: unknown): LaneAccountIndexRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const row = value as Record<string, unknown>
  if (typeof row.laneAccountId !== 'string' || !isLaneAccountId(row.laneAccountId)) {
    return null
  }
  if (typeof row.email !== 'string' || row.email.trim() === '') {
    return null
  }
  if (row.label !== null && typeof row.label !== 'string') {
    return null
  }
  if (typeof row.active !== 'boolean') {
    return null
  }
  if (typeof row.capturedAt !== 'string' || row.capturedAt.trim() === '') {
    return null
  }
  return {
    laneAccountId: row.laneAccountId,
    email: row.email,
    label: row.label as string | null,
    active: row.active,
    capturedAt: row.capturedAt
  }
}
