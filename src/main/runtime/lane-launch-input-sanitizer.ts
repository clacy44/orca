import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import {
  canonicalizePathForContainment,
  isCanonicalPathWithinAnyRoot
} from '../../shared/lane-path-containment'
import { envKeysMatch, withoutEnvKey, withoutEnvKeyDeletion } from '../../shared/lane-env-key-case'

// NOT WIRED: no spawn calls this yet — lanes do not exist; this is the allowlist/scrub half
// of S9's computeLaneLaunch, landed early so the later slices have one tested place to call.

export const CLAUDE_CONFIG_DIR_ENV_KEY = 'CLAUDE_CONFIG_DIR'

export type LaneLaunchRefusalCode =
  | 'terminal.agent_env_refused'
  | 'terminal.agent_args_refused'
  | 'terminal.resume_path_refused'

export type LaneLaunchRefusal = { code: LaneLaunchRefusalCode; message: string }

export type LaneLaunchEnvInput = {
  env?: Record<string, string> | null
  envToDelete?: string[] | null
  agentEnv?: Record<string, string> | null
  platform?: NodeJS.Platform
}

export type LaneLaunchEnvResult =
  | {
      ok: true
      env?: Record<string, string>
      envToDelete?: string[]
      agentEnv?: Record<string, string>
    }
  | { ok: false; refusal: LaneLaunchRefusal }

/**
 * Strips `CLAUDE_CONFIG_DIR` silently from all three env surfaces — including the deletion
 * list, since a deletion drops the lane back onto the shared `~/.claude` just as effectively
 * as an override — and refuses any `CLAUDE_AUTH_ENV_VARS` key loudly, because those outrank
 * a stored login and would repoint the launch at an attacker's API key.
 *
 * The refusal covers `env` and `agentEnv` only. *Defining* an auth var is the attack;
 * *deleting* one is the safe direction and is what pty.ts already asks for on every lane pane
 * (`authEnvToDelete` under `stripAuthEnv`), so refusing it would refuse every lane launch.
 *
 * Key comparison folds case on win32, where `anthropic_api_key` and `ANTHROPIC_API_KEY` are
 * one variable to the child process and two keys to this record (S9 §2m(5)).
 */
export function sanitizeLaneLaunchEnv(input: LaneLaunchEnvInput): LaneLaunchEnvResult {
  const platform = input.platform ?? process.platform
  const refusedIn = (surface: string, keys: readonly string[]): LaneLaunchRefusal | null => {
    const offender = keys.find((key) =>
      CLAUDE_AUTH_ENV_VARS.some((authKey) => envKeysMatch(key, authKey, platform))
    )
    return offender
      ? {
          code: 'terminal.agent_env_refused',
          message: `This launch defines ${offender} in ${surface}. Remove it before launching in a credential lane.`
        }
      : null
  }
  const refusal =
    refusedIn('env', Object.keys(input.env ?? {})) ??
    refusedIn('launchConfig.agentEnv', Object.keys(input.agentEnv ?? {}))
  if (refusal) {
    return { ok: false, refusal }
  }
  return {
    ok: true,
    ...(input.env ? { env: withoutEnvKey(input.env, CLAUDE_CONFIG_DIR_ENV_KEY, platform) } : {}),
    ...(input.agentEnv
      ? { agentEnv: withoutEnvKey(input.agentEnv, CLAUDE_CONFIG_DIR_ENV_KEY, platform) }
      : {}),
    ...(input.envToDelete
      ? {
          envToDelete:
            withoutEnvKeyDeletion(input.envToDelete, CLAUDE_CONFIG_DIR_ENV_KEY, platform) ?? []
        }
      : {})
  }
}

/**
 * Flags of `claude` 2.1.240 (`claude --help`) that re-point settings resolution or auth.
 * `--settings` and `--setting-sources` choose which settings files are read, and a settings
 * file may define `apiKeyHelper` or `env`, both of which outrank a stored login. `--bare`
 * says so itself: "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
 * --settings (OAuth and keychain are never read)". That release has no config-dir flag at
 * all — `CLAUDE_CONFIG_DIR` is env-only — so the env scrub above is the config-dir half.
 */
export const REFUSED_LANE_LAUNCH_FLAGS = ['--settings', '--setting-sources', '--bare'] as const

export type LaneLaunchCommandInput = {
  agentCommand?: string | null
  agentArgs?: string | null
}

export type LaneLaunchCommandResult = { ok: true } | { ok: false; refusal: LaneLaunchRefusal }

export function sanitizeLaneLaunchCommand(input: LaneLaunchCommandInput): LaneLaunchCommandResult {
  const tokens = [
    ...tokenizeLaunchString(input.agentCommand),
    ...tokenizeLaunchString(input.agentArgs)
  ]
  for (const token of tokens) {
    const flag = token.split('=', 1)[0]
    if ((REFUSED_LANE_LAUNCH_FLAGS as readonly string[]).includes(flag)) {
      return {
        ok: false,
        refusal: {
          code: 'terminal.agent_args_refused',
          message: `${flag} re-points Claude's settings or auth resolution and is not allowed in a credential lane.`
        }
      }
    }
    const assignedKey = parseEnvAssignment(token)
    if (
      assignedKey === CLAUDE_CONFIG_DIR_ENV_KEY ||
      (assignedKey !== null && (CLAUDE_AUTH_ENV_VARS as readonly string[]).includes(assignedKey))
    ) {
      return {
        ok: false,
        refusal: {
          code: 'terminal.agent_args_refused',
          message: `${assignedKey} may not be assigned in a lane launch command.`
        }
      }
    }
  }
  return { ok: true }
}

export type LaneResumePathInput = {
  ompResumeFilePath?: string | null
  transcriptPath?: string | null
}

export type LaneResumePathResult = { ok: true } | { ok: false; refusal: LaneLaunchRefusal }

/** Both resume paths must canonically sit inside a root the lane owns. Fails closed. */
export function assertLaneResumePathsContained(
  input: LaneResumePathInput,
  allowedRoots: readonly string[]
): LaneResumePathResult {
  for (const [field, value] of [
    ['ompResumeFilePath', input.ompResumeFilePath],
    ['resumeProviderSession.transcriptPath', input.transcriptPath]
  ] as const) {
    if (!value) {
      continue
    }
    const canonical = canonicalizePathForContainment(value)
    if (
      canonical.kind !== 'canonical' ||
      !isCanonicalPathWithinAnyRoot(allowedRoots, canonical.path)
    ) {
      return {
        ok: false,
        refusal: {
          code: 'terminal.resume_path_refused',
          message: `${field} points outside this lane's own files.`
        }
      }
    }
  }
  return { ok: true }
}

/**
 * Splits a launch string the way a POSIX shell would for the purpose of *finding flags*:
 * quotes group, backslash escapes the next character. It is deliberately not a shell —
 * it only has to see every token a flag could hide in.
 */
function tokenizeLaunchString(value: string | null | undefined): string[] {
  if (!value) {
    return []
  }
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\\' && quote !== "'" && index + 1 < value.length) {
      current += value[index + 1]
      started = true
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
      }
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

function parseEnvAssignment(token: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)
  return match ? match[1] : null
}
