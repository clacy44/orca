import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { deleteActiveClaudeKeychainCredentialsStrict } from './keychain'
import { purgeLaneAccountStore } from './principal-lane-account-store'
import { LANE_CONFIG_FILENAME, LANE_CREDENTIALS_FILENAME } from './lane-credential-filenames'

export { LANE_CONFIG_FILENAME, LANE_CREDENTIALS_FILENAME }

/**
 * A credential blob can sit at rest under a name no filename-scoped wipe touches: both atomic
 * writers stage under `${target}.<pid>.<...>.tmp` and unlink only on a thrown error
 * (`codex-accounts/fs-utils.ts:12`/`:17`, `shared/secure-file.ts:111`), so a crash mid-write
 * leaves a full `0600` copy behind. The sweep therefore matches the PATTERN, not either literal.
 */
export function sweepLaneCredentialTempArtifacts(laneDir: string): string[] {
  if (!existsSync(laneDir)) {
    return []
  }
  const removed: string[] = []
  for (const entry of readdirSync(laneDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) {
      continue
    }
    rmSync(join(laneDir, entry.name), { force: true })
    removed.push(entry.name)
  }
  return removed
}

/** What the darwin arm removed, named for the caller's log rather than for the Keychain. */
export const LANE_KEYCHAIN_ITEM = 'keychain#lane-scoped'

export type LaneCredentialWipeOptions = {
  platform?: NodeJS.Platform
  /** Injected so the darwin arm is observable on every platform, and faked in tests. */
  deleteKeychainItem?: (configDir: string) => Promise<void>
  /**
   * Injected so the re-read is observable: only a process OUTSIDE this call — the mid-rotation
   * `claude` §2f names — can put a credential back between two synchronous passes.
   */
  onSweptPass?: (pass: number) => void
}

/** How many times a lane that keeps re-growing a credential is swept before the wipe refuses. */
const LANE_SWEEP_PASSES = 3

/** Every credential artifact still at rest in the lane: the file, plus any staged `.tmp` copy. */
export function listLaneCredentialArtifacts(laneDir: string): string[] {
  if (!existsSync(laneDir)) {
    return []
  }
  return readdirSync(laneDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && (entry.name === LANE_CREDENTIALS_FILENAME || entry.name.endsWith('.tmp'))
    )
    .map((entry) => entry.name)
}

/**
 * The §2f wipe: the lane's scoped Keychain item, every credential artifact, then its identity.
 *
 * The Keychain goes FIRST because on darwin it is what a Claude Code 2.1+ launched with this
 * lane's `CLAUDE_CONFIG_DIR` actually resolves — a file-only wipe leaves the credential at rest
 * and makes §2a's "a lane launch fails closed when the lane is unloaded" false. Strictly SCOPED,
 * never the unsuffixed service: that one is host-wide, and a lane that deleted it would sign every
 * other lane's older CLI out. A refusal it cannot ignore throws rather than reporting a wipe that
 * did not happen.
 *
 * `settings.json`, the mirrored user content and the lane's transcripts survive — they are not
 * secrets, and destroying transcripts on dropped Wi-Fi would be hostile.
 */
export async function wipeLaneCredentials(
  laneDir: string,
  options: LaneCredentialWipeOptions = {}
): Promise<string[]> {
  const removed: string[] = []
  if ((options.platform ?? process.platform) === 'darwin') {
    const deleteKeychainItem =
      options.deleteKeychainItem ?? deleteActiveClaudeKeychainCredentialsStrict
    await deleteKeychainItem(laneDir)
    removed.push(LANE_KEYCHAIN_ITEM)
  }
  // §2f: the sweep RE-READS before it reports. A precondition is a check, not a proof — a probe
  // that slipped the start-side fence can write `.credentials.json` back after the pass that
  // removed it, and "a wipe reported over an unread directory is the same failure as one that
  // never ran". Reported only after a clean read-back; refused, never reported done, otherwise.
  for (let pass = 1; pass <= LANE_SWEEP_PASSES; pass += 1) {
    for (const name of sweepOneLanePass(laneDir)) {
      if (!removed.includes(name)) {
        removed.push(name)
      }
    }
    options.onSweptPass?.(pass)
    if (listLaneCredentialArtifacts(laneDir).length === 0) {
      if (dropLaneOauthAccount(laneDir)) {
        removed.push(`${LANE_CONFIG_FILENAME}#oauthAccount`)
      }
      // S9-L1 B2/§storeLayout "PURGE": every OTHER login this lane ever captured lives under
      // `claude-accounts/`, which this sweep's own artifact match (`.credentials.json` plus
      // `*.tmp` at the lane's top level) never reached. Only once the active credential is
      // confirmed gone — never on the throw path below, which reports nothing done.
      removed.push(...purgeLaneAccountStore(laneDir))
      return removed
    }
  }
  throw new ClaudeLaneRefusal(
    'accounts.lane.logout_incomplete',
    'Orca swept this Claude credential lane but a credential file kept reappearing in it, so the lane is not confirmed empty and the logout was not completed. Stop any Claude session still running in that lane on the host machine, then log out again.'
  )
}

/** One pass: every staged `.tmp` sibling, then the credential file itself. */
function sweepOneLanePass(laneDir: string): string[] {
  const removed = sweepLaneCredentialTempArtifacts(laneDir)
  const credentialsPath = join(laneDir, LANE_CREDENTIALS_FILENAME)
  if (existsSync(credentialsPath)) {
    rmSync(credentialsPath, { force: true })
    removed.push(LANE_CREDENTIALS_FILENAME)
  }
  return removed
}

/** Whether the lane holds a credential a launch could run on. */
export function isLaneLoaded(laneDir: string): boolean {
  return existsSync(join(laneDir, LANE_CREDENTIALS_FILENAME))
}

/** Deletes the key rather than nulling it, matching how the runtime's own writer clears it. */
function dropLaneOauthAccount(laneDir: string): boolean {
  const configPath = join(laneDir, LANE_CONFIG_FILENAME)
  if (!existsSync(configPath)) {
    return false
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const record = parsed as Record<string, unknown>
    if (!('oauthAccount' in record)) {
      return false
    }
    delete record.oauthAccount
    writeFileSync(configPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    return true
  } catch {
    // Why: an unparseable lane config holds no identity we can strip; the credential sweep above
    // is what the wipe promise rests on.
    return false
  }
}
