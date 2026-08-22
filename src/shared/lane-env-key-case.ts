/**
 * Windows resolves environment-variable names case-insensitively; POSIX does not.
 *
 * A spawn env is an ordinary `Record<string, string>` built by spreads, so `claude_config_dir`
 * and `CLAUDE_CONFIG_DIR` are two keys to Orca and one variable to Windows — and node-pty emits
 * every own key with no dedupe, so a lower-cased twin planted by a client wins over the host's
 * canonical key on `win32`. Every lane env guard compares through here (S9 §2m(5)). POSIX keeps
 * exact-case comparison, which is correct there: two casings really are two variables.
 */

export function envKeysMatch(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right
}

/** Every key in `env` that names `envKey` on this platform, canonical casing included. */
export function findEnvKeyVariants(
  env: Record<string, string> | undefined,
  envKey: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return Object.keys(env ?? {}).filter((key) => envKeysMatch(key, envKey, platform))
}

/** `env` without any casing of `envKey`; the same object back when there was nothing to remove. */
export function withoutEnvKey<T extends Record<string, string> | undefined>(
  env: T,
  envKey: string,
  platform: NodeJS.Platform = process.platform
): T {
  const variants = findEnvKeyVariants(env, envKey, platform)
  if (!env || variants.length === 0) {
    return env
  }
  const next = { ...env }
  for (const key of variants) {
    delete next[key]
  }
  return next as T
}

/**
 * `env` with `envKey` set to `value` and every other casing of it removed — a record carrying
 * two casings of one Windows variable has undefined precedence, so the lane keys collapse to
 * one canonical casing on the way out.
 */
export function withEnvKeyCollapsed(
  env: Record<string, string> | undefined,
  envKey: string,
  value: string,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return { ...withoutEnvKey(env, envKey, platform), [envKey]: value }
}

/** A deletion list without any casing of `envKey`; the same array back when nothing matched. */
export function withoutEnvKeyDeletion(
  envToDelete: string[] | undefined,
  envKey: string,
  platform: NodeJS.Platform = process.platform
): string[] | undefined {
  if (!envToDelete?.some((key) => envKeysMatch(key, envKey, platform))) {
    return envToDelete
  }
  return envToDelete.filter((key) => !envKeysMatch(key, envKey, platform))
}
