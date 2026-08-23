import { parsePaneKey } from './stable-pane-id'

// Why: Claude Code (>=2.1.80) pipes `rate_limits` to the statusLine command on every
// turn — piggybacked on Messages API responses, so reading it costs no usage-endpoint
// budget (the endpoint 429s under Orca's polling; see rate-limits/service.ts).

export const CLAUDE_STATUSLINE_PATHNAME = '/statusline/claude'

// Why: the statusline ticks ~3x/sec while streaming and the service drops same-value posts
// inside LIVE_CLAUDE_INGEST_DEDUPE_MS (30s) anyway; a per-pane client floor below that bound
// keeps the usage bar live while capping curl spawns at one per pane per interval.
export const CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS = 15

export type ClaudeStatusLineWindow = {
  used_percentage?: number
  /** OAuth-usage-shaped sibling field (0-100); accepted so a CLI schema drift degrades instead of going dark. */
  utilization?: number
  /** Unix epoch seconds when the window resets, if known; tolerates an ISO/date string if the schema drifts. */
  resets_at?: number | string
}

export type ClaudeStatusLineRateLimits = {
  /** CLAUDE_CONFIG_DIR of the reporting session; null for system-default sessions. */
  configDir: string | null
  /**
   * The pane the reporting session runs in — posted by the managed statusline since it shipped
   * and parsed away until S9b. It is the attribution key a lane needs: exact, case-free, and the
   * same identifier the pane's lane is bound to, where `configDir` is a path this design spent a
   * decision making opaque and which Windows can spell two ways (S9 §2k).
   */
  paneKey?: string | null
  fiveHour: ClaudeStatusLineWindow | null
  sevenDay: ClaudeStatusLineWindow | null
}

/** Bounds an untrusted loopback field before it is parsed; a real paneKey is far shorter. */
const PANE_KEY_MAX_LENGTH = 256

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseWindow(value: unknown): ClaudeStatusLineWindow | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as { used_percentage?: unknown; utilization?: unknown; resets_at?: unknown }
  const usedPercentage = finiteNumber(raw.used_percentage)
  // Why: mirror mapClaudeUsageWindow's OAuth-shape tolerance (utilization, 0-100) so a statusline field rename degrades instead of silently darkening the feed.
  const utilization = usedPercentage === undefined ? finiteNumber(raw.utilization) : undefined
  if (usedPercentage === undefined && utilization === undefined) {
    return null
  }
  // Why: resets_at is epoch seconds today, but pass a string/ISO value through so schema drift degrades to a parseable timestamp (see parseClaudeUsageResetTimestamp) instead of silently dropping it.
  const resetsAt =
    typeof raw.resets_at === 'number' && Number.isFinite(raw.resets_at)
      ? raw.resets_at
      : typeof raw.resets_at === 'string' && raw.resets_at.trim()
        ? raw.resets_at
        : undefined
  return {
    ...(usedPercentage !== undefined ? { used_percentage: usedPercentage } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    resets_at: resetsAt
  }
}

/**
 * Parses the form-encoded body posted by the managed Claude statusline script.
 * Returns null when the payload carries no usable rate-limit windows.
 */
export function parseClaudeStatusLineBody(body: unknown): ClaudeStatusLineRateLimits | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const fields = body as { payload?: unknown; configDir?: unknown; paneKey?: unknown }
  if (typeof fields.payload !== 'string' || !fields.payload) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(fields.payload)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const rateLimits = (payload as { rate_limits?: unknown }).rate_limits
  if (typeof rateLimits !== 'object' || rateLimits === null) {
    return null
  }
  const fiveHour = parseWindow((rateLimits as { five_hour?: unknown }).five_hour)
  const sevenDay = parseWindow((rateLimits as { seven_day?: unknown }).seven_day)
  if (!fiveHour && !sevenDay) {
    return null
  }
  const configDir = typeof fields.configDir === 'string' ? fields.configDir.trim() : ''
  return {
    configDir: configDir || null,
    paneKey: parsePostedPaneKey(fields.paneKey),
    fiveHour,
    sevenDay
  }
}

/**
 * A posted paneKey is kept only when it parses as one; anything else is dropped to `null` so the
 * ingest falls back to the config-dir map rather than joining on a string it cannot address.
 */
function parsePostedPaneKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > PANE_KEY_MAX_LENGTH || !parsePaneKey(trimmed)) {
    return null
  }
  return trimmed
}
