import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deleteActiveClaudeKeychainCredentialsStrict } from './keychain'

export const LANE_CREDENTIALS_FILENAME = '.credentials.json'
export const LANE_CONFIG_FILENAME = '.claude.json'

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
  removed.push(...sweepLaneCredentialTempArtifacts(laneDir))
  const credentialsPath = join(laneDir, LANE_CREDENTIALS_FILENAME)
  if (existsSync(credentialsPath)) {
    rmSync(credentialsPath, { force: true })
    removed.push(LANE_CREDENTIALS_FILENAME)
  }
  if (dropLaneOauthAccount(laneDir)) {
    removed.push(`${LANE_CONFIG_FILENAME}#oauthAccount`)
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
