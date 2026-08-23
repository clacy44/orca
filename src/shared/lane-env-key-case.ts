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

/** Deletes every casing of each key from `env`, in place. */
export function deleteEnvKeyVariants(
  env: Record<string, string> | undefined,
  envKeys: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): void {
  if (!env || !envKeys) {
    return
  }
  for (const envKey of envKeys) {
    for (const key of findEnvKeyVariants(env, envKey, platform)) {
      delete env[key]
    }
  }
}

/** The value stored under any casing of `envKey`; the canonical casing wins a tie. */
export function readEnvKey(
  env: Record<string, string | undefined> | undefined,
  envKey: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (env?.[envKey] !== undefined) {
    return env[envKey]
  }
  const variant = findEnvKeyVariants(env as Record<string, string> | undefined, envKey, platform)[0]
  return variant === undefined ? undefined : env?.[variant]
}

/** In-place `withEnvKeyCollapsed`, for the patch appliers that mutate their base env. */
export function setEnvKeyCollapsed(
  env: Record<string, string>,
  envKey: string,
  value: string,
  platform: NodeJS.Platform = process.platform
): void {
  deleteEnvKeyVariants(env, [envKey], platform)
  env[envKey] = value
}

/**
 * `envKeys` widened with every other casing of them that any of `envs` actually carries.
 *
 * The deletion list is replayed by the pty provider and by the daemon with an exact-case
 * `delete finalEnv[key]` over an env this process never sees assembled — `{ ...process.env,
 * ...args.env }`. Folding case at the deletion site therefore cannot reach the twin; naming
 * it in the list can. A no-op off win32, where two casings really are two variables.
 */
export function expandEnvKeyDeletions(
  envKeys: readonly string[],
  envs: readonly (Record<string, string | undefined> | undefined)[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const deletions = [...envKeys]
  if (platform !== 'win32') {
    return deletions
  }
  for (const env of envs) {
    for (const key of Object.keys(env ?? {})) {
      const canonical = envKeys.find((envKey) => envKeysMatch(key, envKey, platform))
      if (canonical !== undefined && !deletions.includes(key)) {
        deletions.push(key)
      }
    }
  }
  return deletions
}

/** The lane keys the provider and the daemon collapse after their own env merge (§2m(5)). */
export const LANE_ENV_KEYS = ['CLAUDE_CONFIG_DIR'] as const

/**
 * Removes every other casing of a lane key that the env merge itself reinstated (§2m(5)).
 *
 * The provider rebuilds the env AFTER the anchor — `{ ...process.env, ...args.env }` — so a
 * differently-cased `Claude_Config_Dir` inherited by the Orca process lands beside the lane's
 * canonical key, and Win32 resolves the FIRST case-insensitive key in block order: the inherited
 * shared-lane path, not the lane's. The rule is the daemon's own PATH rule — a one-key requested
 * patch is authoritative, two or zero came from inherited state and are left to the guards.
 */
export function collapseLaneEnvKeys(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    return
  }
  for (const envKey of LANE_ENV_KEYS) {
    const present = findEnvKeyVariants(env, envKey, platform)
    const requested = findEnvKeyVariants(requestedEnv, envKey, platform)
    const surviving = requested.length === 1 ? requested[0] : undefined
    if (present.length < 2 || surviving === undefined || env[surviving] === undefined) {
      continue
    }
    for (const key of present) {
      if (key !== surviving) {
        delete env[key]
      }
    }
  }
}
