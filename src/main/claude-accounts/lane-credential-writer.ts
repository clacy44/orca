import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { LANE_CONFIG_FILENAME, LANE_CREDENTIALS_FILENAME } from './principal-lane-credential-sweep'

/**
 * The path-taking credential/config writers (S9 §2c).
 *
 * `runtime-auth-service.ts`'s own writers open with `getRuntimePaths()` and mutate its shared
 * last-written field, so neither can be pointed at a lane. These take the path and carry the
 * last-written value in and out, which is what lets a lane keep its OWN cache below.
 *
 * Nothing here logs a credential: the contents are the secret this module exists to move.
 */

/** The `.credentials.json` shape a launch can actually run on: a `claudeAiOauth.accessToken`. */
export function hasClaudeOauthAccessToken(credentialsJson: string): boolean {
  try {
    const parsed = asRecord(JSON.parse(credentialsJson))
    const oauth = asRecord(parsed?.claudeAiOauth)
    const accessToken = oauth?.accessToken
    return typeof accessToken === 'string' && accessToken.trim() !== ''
  } catch {
    return false
  }
}

/**
 * Writes credentials at `0600`, returning the value the caller should remember as last-written.
 *
 * Skips unchanged rewrites to dodge Windows EPERM contention (#1507), re-verifying the file
 * because another Claude may have rewritten it behind us.
 */
export function writeCredentialsFileAtomically(
  targetPath: string,
  contents: string,
  lastWritten: string | null
): string {
  mkdirSync(dirname(targetPath), { recursive: true })
  if (lastWritten === contents && fileContentsEqual(targetPath, contents)) {
    ensureOwnerOnlyMode(targetPath)
    return contents
  }
  if (fileContentsEqual(targetPath, contents)) {
    ensureOwnerOnlyMode(targetPath)
    return contents
  }
  writeFileAtomically(targetPath, contents, { mode: 0o600 })
  return contents
}

export function writeJsonFileAtomically(targetPath: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  mkdirSync(dirname(targetPath), { recursive: true })
  // Why: same Windows contention reason as the credentials writer.
  if (fileContentsEqual(targetPath, serialized)) {
    return
  }
  writeFileAtomically(targetPath, serialized, { mode: 0o600 })
}

/** `{}` for an absent file, `null` for unparseable — a caller must not erase unknown state. */
export function readJsonObjectFile(targetPath: string): Record<string, unknown> | null {
  if (!existsSync(targetPath)) {
    return {}
  }
  try {
    return asRecord(JSON.parse(readFileSync(targetPath, 'utf-8')))
  } catch {
    return null
  }
}

/** Merges (or deletes) `oauthAccount` in a `.claude.json`; false when the file is unreadable. */
export function writeOauthAccountIntoConfigFile(
  configPath: string,
  oauthAccount: unknown
): boolean {
  const existing = readJsonObjectFile(configPath)
  if (existing === null) {
    return false
  }
  if (oauthAccount === null || oauthAccount === undefined) {
    delete existing.oauthAccount
  } else {
    existing.oauthAccount = oauthAccount
  }
  writeJsonFileAtomically(configPath, existing)
  return true
}

/**
 * The lane-scoped writer: one last-written cache PER LANE.
 *
 * A single shared cache would let lane A's blob suppress lane B's identical write — and worse,
 * report B as written when the bytes only ever reached A.
 */
export class LaneCredentialWriter {
  private readonly lastWrittenByLane = new Map<string, string>()

  writeCredentials(laneDir: string, credentialsJson: string): void {
    const written = writeCredentialsFileAtomically(
      join(laneDir, LANE_CREDENTIALS_FILENAME),
      credentialsJson,
      this.lastWrittenByLane.get(laneDir) ?? null
    )
    this.lastWrittenByLane.set(laneDir, written)
  }

  writeOauthAccount(laneDir: string, oauthAccount: unknown): boolean {
    return writeOauthAccountIntoConfigFile(join(laneDir, LANE_CONFIG_FILENAME), oauthAccount)
  }

  lastWrittenCredentials(laneDir: string): string | null {
    return this.lastWrittenByLane.get(laneDir) ?? null
  }

  /** Called by the §2f wipe: what is no longer on disk must not be remembered as written. */
  forget(laneDir: string): void {
    this.lastWrittenByLane.delete(laneDir)
  }
}

function fileContentsEqual(targetPath: string, contents: string): boolean {
  try {
    return existsSync(targetPath) && readFileSync(targetPath, 'utf-8') === contents
  } catch {
    return false
  }
}

function ensureOwnerOnlyMode(targetPath: string): void {
  if (process.platform === 'win32') {
    return
  }
  try {
    chmodSync(targetPath, 0o600)
  } catch {
    /* Best effort: the next atomic write will set the restrictive mode. */
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}
