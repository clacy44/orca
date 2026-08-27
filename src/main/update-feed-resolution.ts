import { app } from 'electron'

// Why: a fork build shares upstream's updater code, so without this gate it would
// offer to install upstream's next release over itself.
export type UpdateFeedMode = 'upstream' | 'fork' | 'off'

export type UpdateFeedResolution =
  | { mode: 'upstream'; owner: string; repo: string; reason: string }
  | { mode: 'fork'; owner: string; repo: string; reason: string }
  | { mode: 'off'; message: string; reason: string }

export const UPSTREAM_OWNER = 'stablyai'
export const UPSTREAM_REPO = 'orca'
const DEFAULT_FORK_OWNER = 'clacy44'
const DEFAULT_FORK_REPO = 'orca'

export const UPDATE_UNMANAGED_MESSAGE = 'Updates are managed manually for this build.'

// ORCA_UPDATE_FEED override: "upstream" forces stablyai/orca; "fork" forces the
// fork's own repo (from package.json `repository`, else clacy44/orca); "off"
// disables checks. Unset: inferred from package.json `repository`.
const VALID_OVERRIDES = new Set(['upstream', 'fork', 'off'])

/** Parses "owner/repo" out of a package.json `repository` (string, "github:" shorthand, git URL, or {url}). */
export function parseOwnerRepo(repository: unknown): { owner: string; repo: string } | null {
  const raw =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository === 'object' && 'url' in repository
        ? String((repository as { url?: unknown }).url ?? '')
        : null
  if (!raw) {
    return null
  }
  const match = raw.match(
    /(?:github:|github\.com[/:])([^/\s]+)\/([^/\s.#]+?)(?:\.git)?(?:[/#].*)?$/i
  )
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2] }
}

/** Pure resolution — no I/O — so it is exhaustively unit-testable. */
export function resolveUpdateFeed(input: {
  packageRepository: unknown
  env: Record<string, string | undefined>
}): UpdateFeedResolution {
  const rawOverride = input.env.ORCA_UPDATE_FEED?.trim().toLowerCase()
  const override = rawOverride && VALID_OVERRIDES.has(rawOverride) ? rawOverride : undefined

  if (override === 'off') {
    return { mode: 'off', message: UPDATE_UNMANAGED_MESSAGE, reason: 'env-override-off' }
  }
  if (override === 'upstream') {
    return {
      mode: 'upstream',
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      reason: 'env-override-upstream'
    }
  }
  const parsed = parseOwnerRepo(input.packageRepository)
  if (override === 'fork') {
    return {
      mode: 'fork',
      owner: parsed?.owner ?? DEFAULT_FORK_OWNER,
      repo: parsed?.repo ?? DEFAULT_FORK_REPO,
      reason: 'env-override-fork'
    }
  }

  if (
    parsed &&
    parsed.owner.toLowerCase() === UPSTREAM_OWNER &&
    parsed.repo.toLowerCase() === UPSTREAM_REPO
  ) {
    return {
      mode: 'upstream',
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      reason: 'package-repository-upstream'
    }
  }

  // Why: default to "off" rather than guess a fork releases repo exists with matching assets.
  return {
    mode: 'off',
    message: UPDATE_UNMANAGED_MESSAGE,
    reason: parsed ? 'package-repository-fork' : 'package-repository-unset'
  }
}

function readPackageRepository(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- reading the packaged app's own manifest, not a module import
    const pkg = require(require('node:path').join(app.getAppPath(), 'package.json')) as {
      repository?: unknown
    }
    return pkg?.repository
  } catch {
    return undefined
  }
}

/** Live wrapper: reads the packaged app's own package.json + real env. */
export function resolveActiveUpdateFeed(): UpdateFeedResolution {
  return resolveUpdateFeed({ packageRepository: readPackageRepository(), env: process.env })
}
