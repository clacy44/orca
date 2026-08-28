/**
 * Version gate for lane logins (S9 §4 gate (vi), §risks "OAUTH-CONSTANT PIN
 * DRIFT"). The login parser (lane-login-url-parser.ts) and the OAuth constants
 * (oauth-refresh.ts) are a scraped contract pinned to one observed `claude`
 * build — a CLI outside the range those were verified against must refuse the
 * login rather than silently trust unobserved output shapes. Fails CLOSED: a
 * spawn error or unparsable `--version` output is refused exactly like an
 * out-of-range version, never treated as "assume supported".
 */
import { execFileSync } from 'node:child_process'
import { resolveClaudeCommand } from '../codex-cli/command'
import {
  ClaudeLaneRefusal,
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES
} from '../../shared/claude-lane-refusals'

const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000

/** Floor of the tested range (§risks: the OAuth constants and login parser were
 * last verified against the installed binary starting at this build). */
export const MIN_TESTED_CLI_VERSION = '2.1.177'

/**
 * Ceiling of the tested range. Bump this ONLY after re-running the §risks
 * Gate 0 procedure against the new build — re-verifying oauth-refresh.ts's
 * OAUTH_TOKEN_URL/OAUTH_CLIENT_ID and lane-login-url-parser.ts's
 * REQUIRED_AUTHORIZE_HOST/REQUIRED_AUTHORIZE_PATHNAME/PASTE_CODE_PROMPT
 * against a fresh capture — then update this constant AND the matching
 * "verified against" comments in both of those files together; the three
 * must never name different builds. Last verified: `claude --version` =>
 * 2.1.248, 2026-08-28.
 */
export const INSTALLED_CLI_VERSION = '2.1.248'

type ParsedCliVersion = { major: number; minor: number; patch: number }

/** Reads the leading `major.minor.patch` out of raw `--version` output (e.g.
 * "2.1.248 (Claude Code)"); null on anything that doesn't start with one. */
export function parseClaudeCliVersion(rawVersionOutput: string): ParsedCliVersion | null {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(rawVersionOutput)
  if (!match) {
    return null
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareCliVersions(a: ParsedCliVersion, b: ParsedCliVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function loginCliUnsupportedRefusal(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.login_cli_unsupported',
    CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.login_cli_unsupported']
  )
}

/**
 * True when `rawVersionOutput` parses to a version within
 * [MIN_TESTED_CLI_VERSION, INSTALLED_CLI_VERSION] inclusive. Unparsable output
 * is unsupported, not "assume the newest is fine" (fail closed).
 */
export function isClaudeCliVersionSupported(rawVersionOutput: string): boolean {
  const parsed = parseClaudeCliVersion(rawVersionOutput)
  if (!parsed) {
    return false
  }
  // Guards a future typo in the two constants above, not runtime input.
  const min = parseClaudeCliVersion(MIN_TESTED_CLI_VERSION)
  const max = parseClaudeCliVersion(INSTALLED_CLI_VERSION)
  if (!min || !max) {
    return false
  }
  return compareCliVersions(parsed, min) >= 0 && compareCliVersions(parsed, max) <= 0
}

/** Throws `accounts.lane.login_cli_unsupported` unless `rawVersionOutput` is
 * in the tested range. */
export function assertClaudeCliVersionSupported(rawVersionOutput: string): void {
  if (!isClaudeCliVersionSupported(rawVersionOutput)) {
    throw loginCliUnsupportedRefusal()
  }
}

/** Runs `claude --version` and throws `accounts.lane.login_cli_unsupported`
 * unless the installed CLI is within the tested range — call at `loginStart`
 * (§4) before spawning the login child. A failed probe (missing binary, PATH
 * issue, timeout) refuses the same as an out-of-range version: fail closed. */
export function assertLoginCliVersionSupported(): void {
  let rawVersionOutput: string
  try {
    rawVersionOutput = execFileSync(resolveClaudeCommand(), ['--version'], {
      encoding: 'utf-8',
      timeout: CLI_VERSION_PROBE_TIMEOUT_MS
    })
  } catch {
    throw loginCliUnsupportedRefusal()
  }
  assertClaudeCliVersionSupported(rawVersionOutput)
}
