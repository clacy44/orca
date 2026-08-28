/**
 * Version gate for lane logins (S9 design rev 39, §4 "Version pin" and §6 hard
 * gate (vi)). The login parser (lane-login-url-parser.ts) and the OAuth constants
 * (oauth-refresh.ts) are a scraped contract last VERIFIED against one observed
 * `claude` build. Rev 39 narrows the pin to a FLOOR: a CLI at or above
 * MIN_TESTED_CLI_VERSION, on the SAME major version, proceeds — logging one
 * advisory line when it is newer than LAST_VERIFIED_CLI_VERSION, since the parser
 * constants may need re-verification — because the constants the gate protects
 * are enforced by the parser itself (the shared allow-list refuses any URL shape
 * it does not recognise, and a changed paste prompt ends in
 * `login_session_expired`, never a silent hazard), whereas the hard ceiling revs
 * 32–38 carried turned every routine CLI update into a login outage (observed
 * 2026-08-28: the installed 2.1.250 exceeded the 2.1.248 ceiling and every lane
 * login on the box was refused). Fails CLOSED only on what actually indicates an
 * unrecognized CLI: below the floor, a different major version, or unparsable
 * `--version` output (including a spawn error) — never "assume supported" for
 * those.
 */
import { execFileSync } from 'node:child_process'
import { resolveClaudeCommand } from '../codex-cli/command'
import {
  ClaudeLaneRefusal,
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES
} from '../../shared/claude-lane-refusals'

const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000

/** Floor of the tested range (rev 39 §4: the oldest build the OAuth constants and
 * login parser are known to fit; `oauth-refresh.ts` was first verified against it). */
export const MIN_TESTED_CLI_VERSION = '2.1.177'

/**
 * The build the OAuth constants and login parser were LAST re-verified against —
 * not a ceiling. Re-verify after a CLI bump: re-check oauth-refresh.ts's
 * OAUTH_TOKEN_URL/OAUTH_CLIENT_ID and the allow-list in
 * `../../shared/claude-authorize-url-policy.ts` (the login parser's
 * PASTE_CODE_PROMPT too) against a fresh capture — then update this constant AND
 * the matching "verified against" comments in those files together; they must
 * never name different builds. A version above this constant is NOT refused
 * (see `isClaudeCliVersionSupported`) — it logs one advisory line instead.
 * Last verified: `claude --version` => 2.1.250, 2026-08-28, two ways: (1) a live,
 * throwaway `claude auth login --claudeai` run (killed before completion, never
 * submitted) — printed URL and paste prompt matched; (2) `strings` over the
 * installed binary at `/home/ubuntu/.local/share/claude/versions/2.1.250` —
 * confirmed `/oauth/authorize`, `/cai/oauth/authorize`, and `oauth/code/callback`
 * are the only authorize/redirect pathnames present.
 */
export const LAST_VERIFIED_CLI_VERSION = '2.1.250'

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
 * True when `rawVersionOutput` parses to a version at or above
 * MIN_TESTED_CLI_VERSION, on the SAME major version as it — there is no ceiling,
 * so a minor/patch bump past LAST_VERIFIED_CLI_VERSION is still supported (see
 * `assertClaudeCliVersionSupported`'s advisory log). A different major is refused
 * outright rather than version-number-compared against the floor: a major bump
 * may change output shapes this gate has no evidence about at all. Unparsable
 * output is unsupported, not "assume the newest is fine" (fail closed).
 */
export function isClaudeCliVersionSupported(rawVersionOutput: string): boolean {
  const parsed = parseClaudeCliVersion(rawVersionOutput)
  if (!parsed) {
    return false
  }
  // Guards a future typo in the constant above, not runtime input.
  const min = parseClaudeCliVersion(MIN_TESTED_CLI_VERSION)
  if (!min) {
    return false
  }
  return parsed.major === min.major && compareCliVersions(parsed, min) >= 0
}

let newerCliAdvisoryLogged = false

/** Logs ONE `console.info` line per process the first time a supported CLI turns out to be newer
 * than `LAST_VERIFIED_CLI_VERSION` — an FYI that the login parser constants may need
 * re-verification, never a refusal. */
function maybeLogNewerCliAdvisory(parsed: ParsedCliVersion): void {
  if (newerCliAdvisoryLogged) {
    return
  }
  const lastVerified = parseClaudeCliVersion(LAST_VERIFIED_CLI_VERSION)
  if (!lastVerified || compareCliVersions(parsed, lastVerified) <= 0) {
    return
  }
  newerCliAdvisoryLogged = true
  console.info(
    `claude CLI ${parsed.major}.${parsed.minor}.${parsed.patch} is newer than the last verified ` +
      `${LAST_VERIFIED_CLI_VERSION}; login parser constants may need re-verification`
  )
}

/** Throws `accounts.lane.login_cli_unsupported` unless `rawVersionOutput` is
 * supported (see `isClaudeCliVersionSupported`); otherwise may log the newer-CLI advisory. */
export function assertClaudeCliVersionSupported(rawVersionOutput: string): void {
  const parsed = parseClaudeCliVersion(rawVersionOutput)
  if (!parsed || !isClaudeCliVersionSupported(rawVersionOutput)) {
    throw loginCliUnsupportedRefusal()
  }
  maybeLogNewerCliAdvisory(parsed)
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
