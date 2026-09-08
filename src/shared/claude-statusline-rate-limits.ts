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
  /** [S10-21d R118, design (b)] Present only when the payload's `model` object carries a
   * non-empty `id`. `displayName` falls back to `id` when `display_name` is absent, so a caller
   * never has to null-check a second field just to log/show something. */
  model?: { id: string; displayName: string }
  /** [S10-21d R118, design (b)] Present only when the payload's `effort` object carries a
   * non-empty `level`. The value is passed through UNVALIDATED — 'ultracode' renders as 'xhigh'
   * here (CANNOT distinguish, per design), and any other unexpected string is possible too; the
   * low|medium|high|xhigh|max allow-list check is the CALLER's job (server.ts's
   * onClaudeSessionPrefs sink), not this parse. */
  effort?: { level: string }
}

/** Bounds an untrusted loopback field before it is parsed; a real paneKey is far shorter. */
const PANE_KEY_MAX_LENGTH = 256

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseModel(value: unknown): { id: string; displayName: string } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const raw = value as { id?: unknown; display_name?: unknown }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) {
    return undefined
  }
  const displayName = typeof raw.display_name === 'string' ? raw.display_name.trim() : ''
  return { id, displayName: displayName || id }
}

function parseEffort(value: unknown): { level: string } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const raw = value as { level?: unknown }
  const level = typeof raw.level === 'string' ? raw.level.trim() : ''
  if (!level) {
    return undefined
  }
  return { level }
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
 * Returns null when the payload carries no usable rate-limit windows AND no model/effort
 * (S10-21d R118) — any one of the four being present is enough to return a result.
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
  // [S10-21d R118] `rate_limits` is no longer a hard gate: a payload that carries model/effort
  // but no rate_limits object (e.g. a non-subscriber session) must still surface those two
  // fields, not return null before ever looking at them.
  const rateLimits = (payload as { rate_limits?: unknown }).rate_limits
  const fiveHour =
    typeof rateLimits === 'object' && rateLimits !== null
      ? parseWindow((rateLimits as { five_hour?: unknown }).five_hour)
      : null
  const sevenDay =
    typeof rateLimits === 'object' && rateLimits !== null
      ? parseWindow((rateLimits as { seven_day?: unknown }).seven_day)
      : null
  const model = parseModel((payload as { model?: unknown }).model)
  const effort = parseEffort((payload as { effort?: unknown }).effort)
  if (!fiveHour && !sevenDay && !model && !effort) {
    return null
  }
  const configDir = typeof fields.configDir === 'string' ? fields.configDir.trim() : ''
  return {
    configDir: configDir || null,
    paneKey: parsePostedPaneKey(fields.paneKey),
    fiveHour,
    sevenDay,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
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
