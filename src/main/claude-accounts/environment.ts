import {
  deleteEnvKeyVariants,
  expandEnvKeyDeletions,
  findEnvKeyVariants,
  readEnvKey,
  setEnvKeyCollapsed
} from '../../shared/lane-env-key-case'

export const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

export const ANTHROPIC_CUSTOM_HEADERS_ENV_KEY = 'ANTHROPIC_CUSTOM_HEADERS'

export type ClaudeEnvPatch = {
  CLAUDE_CONFIG_DIR?: string
  ANTHROPIC_CUSTOM_HEADERS?: string
}

/**
 * Every key comparison here folds case on win32 (S9 §2m(5)): Windows resolves environment
 * names case-insensitively while this record does not, so an exact-case strip leaves a
 * planted or inherited `anthropic_api_key` in place — and it reaches the child as
 * `ANTHROPIC_API_KEY`, which outranks the stored login the strip exists to protect.
 */
export function applyClaudeEnvPatch(
  baseEnv: Record<string, string>,
  patch: ClaudeEnvPatch,
  options?: { stripAuthEnv?: boolean; platform?: NodeJS.Platform }
): Record<string, string> {
  const platform = options?.platform ?? process.platform
  if (options?.stripAuthEnv) {
    deleteEnvKeyVariants(baseEnv, CLAUDE_AUTH_ENV_VARS, platform)
    if (isAuthLikeCustomHeaders(readEnvKey(baseEnv, ANTHROPIC_CUSTOM_HEADERS_ENV_KEY, platform))) {
      deleteEnvKeyVariants(baseEnv, [ANTHROPIC_CUSTOM_HEADERS_ENV_KEY], platform)
    }
  }

  // Why collapse rather than assign: a record carrying two casings of one Windows variable
  // has undefined precedence, so the patch's own key must be the only one left standing.
  if (patch.CLAUDE_CONFIG_DIR) {
    setEnvKeyCollapsed(baseEnv, 'CLAUDE_CONFIG_DIR', patch.CLAUDE_CONFIG_DIR, platform)
  }
  if (patch.ANTHROPIC_CUSTOM_HEADERS !== undefined) {
    setEnvKeyCollapsed(
      baseEnv,
      ANTHROPIC_CUSTOM_HEADERS_ENV_KEY,
      patch.ANTHROPIC_CUSTOM_HEADERS,
      platform
    )
  }

  return baseEnv
}

export function hasClaudeAuthEnvConflict(
  env: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!env) {
    return false
  }
  return (
    CLAUDE_AUTH_ENV_VARS.some((key) =>
      findEnvKeyVariants(env, key, platform).some((variant) => Boolean(env[variant]))
    ) || isAuthLikeCustomHeaders(readEnvKey(env, ANTHROPIC_CUSTOM_HEADERS_ENV_KEY, platform))
  )
}

/**
 * The launch scrub's deletion list, widened on win32 with the casings `envs` actually carry
 * so the provider's and daemon's exact-case replay of the list removes the twin too.
 */
export function resolveClaudeAuthEnvDeletions(
  envs: readonly (Record<string, string | undefined> | undefined)[],
  platform: NodeJS.Platform = process.platform
): string[] {
  return expandEnvKeyDeletions(
    [...CLAUDE_AUTH_ENV_VARS, ANTHROPIC_CUSTOM_HEADERS_ENV_KEY],
    envs,
    platform
  )
}

export function isAuthLikeCustomHeaders(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  return /authorization|x-api-key|api-key|bearer/i.test(value)
}
