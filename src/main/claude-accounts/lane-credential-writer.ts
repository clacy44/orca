import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ClaudeLaneRefusal, isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { restrictWindowsPathSync } from '../../shared/secure-path-windows-acl'
import { renameFileWithWindowsRetry, writeFileAtomically } from '../codex-accounts/fs-utils'
import { writeActiveClaudeKeychainCredentials } from './keychain'
import { LANE_CONFIG_FILENAME, LANE_CREDENTIALS_FILENAME } from './lane-credential-filenames'

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
 * Skips unchanged rewrites to dodge Windows EPERM contention (#1507). The file itself is the only
 * comparand: an in-memory last-written value can only agree with it or be wrong about it, since
 * another Claude may have rewritten the file behind us.
 */
export function writeCredentialsFileAtomically(targetPath: string, contents: string): string {
  mkdirSync(dirname(targetPath), { recursive: true })
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

/** Injected so the darwin arm is observable on every platform, and faked in tests. */
export type LaneKeychainWriter = (contents: string, configDir: string) => Promise<void>

/** The two `win32` primitives §2m(2) combines; injected so the sequence is testable anywhere. */
export type WindowsLanePublishOps = {
  restrictPath: (targetPath: string, isDirectory: boolean) => boolean
  publish: (source: string, target: string) => void
}

export type LaneCredentialWriterOptions = {
  writeKeychain?: LaneKeychainWriter
  platform?: NodeJS.Platform
  windows?: WindowsLanePublishOps
}

/**
 * The lane-scoped writer: it takes the lane directory and remembers nothing.
 *
 * It carried a per-lane last-written cache until review round 1 proved the cache inert — the
 * on-disk comparison above subsumes it — so the §2f wipe has nothing here to invalidate. What a
 * lane last wrote lives in `LaneAuthState`, keyed by (lane, account), where the sync driver
 * reads it.
 */
export class LaneCredentialWriter {
  constructor(private readonly options: LaneCredentialWriterOptions = {}) {}

  /**
   * File plus, on darwin, the lane's CONFIG-DIR-SCOPED Keychain item — the pair every host
   * credential write in this tree already makes (`runtime-auth-service.ts` :450-454, :574-578).
   *
   * Deliberately not the runtime writer's `[scoped, legacy]` pair: the unsuffixed service is
   * host-wide, so writing it would publish one lane's credential to every other lane's older CLI.
   * A failed Keychain write throws rather than leaving the item on the revoked token (§2i).
   */
  async writeCredentials(laneDir: string, credentialsJson: string): Promise<void> {
    const platform = this.options.platform ?? process.platform
    const targetPath = join(laneDir, LANE_CREDENTIALS_FILENAME)
    if (platform === 'win32') {
      publishLaneCredentialsOnWindows(targetPath, credentialsJson, this.options.windows)
    } else {
      writeCredentialsFileAtomically(targetPath, credentialsJson)
    }
    if (platform === 'darwin') {
      const writeKeychain = this.options.writeKeychain ?? writeActiveClaudeKeychainCredentials
      await writeKeychain(credentialsJson, laneDir)
    }
  }

  writeOauthAccount(laneDir: string, oauthAccount: unknown): boolean {
    return writeOauthAccountIntoConfigFile(join(laneDir, LANE_CONFIG_FILENAME), oauthAccount)
  }
}

/**
 * The `win32` lane publish of §2m(2): neither existing primitive is sufficient alone.
 *
 * `writeFileAtomically` has the rename retry and no ACL work; `writeSecureFile` has the ACL work
 * and a bare `renameSync`. A lane needs both — a mode bit is inert on Windows, and a live `claude`
 * holding the target open makes a bare rename throw where the retry would have won.
 */
function publishLaneCredentialsOnWindows(
  targetPath: string,
  contents: string,
  ops: WindowsLanePublishOps = {
    restrictPath: restrictWindowsPathSync,
    publish: renameFileWithWindowsRetry
  }
): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  if (!fileContentsEqual(targetPath, contents)) {
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: 0o600 })
      // Before the rename: a credential must never be briefly published under inherited ACEs.
      assertLaneDaclVerified(ops.restrictPath(tmpPath, false))
      ops.publish(tmpPath, targetPath)
    } catch (error) {
      rmSync(tmpPath, { force: true })
      throw asLaneWriteRefusal(error)
    }
  }
  // Re-asserted and VERIFIED on the published path. A failed verification fails the push: the
  // bytes have landed, so the caller must treat the lane as unpublished and retry.
  assertLaneDaclVerified(ops.restrictPath(targetPath, false))
}

function assertLaneDaclVerified(verified: boolean): void {
  if (verified) {
    return
  }
  throw new ClaudeLaneRefusal(
    'accounts.lane.switch_write_failed',
    "Orca could not confirm that this lane's credential file is restricted to your Windows account, so it refused the write rather than leave a Claude credential readable by others on this machine. Check that the lane folder is on a local drive and try again."
  )
}

/** The exhausted retry rethrows a raw `EBUSY`, which no client has any string for (§3 Rule 3). */
function asLaneWriteRefusal(error: unknown): unknown {
  if (isClaudeLaneRefusal(error)) {
    return error
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
    return error
  }
  return new ClaudeLaneRefusal(
    'accounts.lane.switch_write_locked',
    "A Claude session on the host is holding this lane's credential file open, so Orca could not replace it. Nothing was changed — close that session or retry in a moment."
  )
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
