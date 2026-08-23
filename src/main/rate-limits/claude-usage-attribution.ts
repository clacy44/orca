import { LANE_PROVENANCE_PREFIX } from '../claude-accounts/principal-lane-provenance'

/**
 * `normalizedConfigDir → { provenance, laneId }` (S9 §2k).
 *
 * The host-wide single snapshot dropped every lane terminal's statusline post, because it held
 * ONE config dir and compared the posted one against it. A map fixes attribution; the pane→lane
 * join below is what fixes the ROW, and it wins over the config dir for the two reasons §2k
 * states — `normalizeClaudeConfigDir` deliberately does not fold case, and the config dir is the
 * identifier §2a spent a decision making opaque before it reaches a peer-readable row.
 */
export type ClaudeUsageAttribution = {
  /** Published as `usageMetadata.authProvenance`, so it is opaque by construction for a lane. */
  provenance: string
  /** The principal lane this row belongs to; `null` is the shared lane. */
  laneId: string | null
}

export type ClaudeLaneUsageAttribution = ClaudeUsageAttribution & {
  laneId: string
  configDir: string
}

/** What a posted paneKey resolves to. `null` = the host knows no pane under that key. */
export type ClaudeUsagePaneLane = { laneId: string | null }

export type ClaudeStatusLinePost = { configDir: string | null; paneKey?: string | null }

export function normalizeClaudeConfigDir(dir: string | null | undefined): string | null {
  // Why: normalize mixed Windows separators for path attribution; preserve Linux case sensitivity.
  const trimmed = dir?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed || null
}

/** A lane provenance is `lane:` + the 32-hex opaque label minted with the lane. Nothing else. */
const OPAQUE_LANE_PROVENANCE_RE = new RegExp(`^${LANE_PROVENANCE_PREFIX}[0-9a-f]{32}$`)

/** Published when a lane's provenance is not the opaque label — never the unvetted string. */
export const REDACTED_LANE_PROVENANCE = `${LANE_PROVENANCE_PREFIX}redacted`

/**
 * The provenance a peer-readable usage row may carry (S9 §2a/§2k).
 *
 * A lane's provenance is published, so it must not become a second carrier of the principalId or
 * of the lane path. It is checked here rather than trusted from wherever the row was built,
 * because the map is populated from two sources and only one of them is `prepareLaneLaunch`.
 */
export function publishedAuthProvenance(attribution: ClaudeUsageAttribution): string {
  if (attribution.laneId === null) {
    return attribution.provenance
  }
  return OPAQUE_LANE_PROVENANCE_RE.test(attribution.provenance)
    ? attribution.provenance
    : REDACTED_LANE_PROVENANCE
}

export class ClaudeUsageAttributionMap {
  private shared: ClaudeUsageAttribution | null = null
  private sharedConfigDir: string | null = null
  private readonly laneRows = new Map<string, ClaudeLaneUsageAttribution>()
  private paneLaneLookup: ((paneKey: string) => ClaudeUsagePaneLane | null) | null = null

  setPaneLaneLookup(lookup: ((paneKey: string) => ClaudeUsagePaneLane | null) | null): void {
    this.paneLaneLookup = lookup
  }

  /** The shared-lane fetch's own entry — cleared on an account switch, as it always was. */
  rememberSharedLane(configDir: string | null, provenance: string): void {
    this.sharedConfigDir = normalizeClaudeConfigDir(configDir)
    this.shared = { provenance, laneId: null }
  }

  clearSharedLane(): void {
    this.shared = null
    this.sharedConfigDir = null
  }

  /** One entry per LOADED lane, republished whole so a wiped lane's row disappears with it. */
  rememberLanes(rows: readonly ClaudeLaneUsageAttribution[]): void {
    this.laneRows.clear()
    for (const row of rows) {
      const configDir = normalizeClaudeConfigDir(row.configDir)
      if (configDir) {
        this.laneRows.set(configDir, { ...row, configDir })
      }
    }
  }

  laneAttribution(laneId: string): ClaudeLaneUsageAttribution | null {
    for (const row of this.laneRows.values()) {
      if (row.laneId === laneId) {
        return row
      }
    }
    return null
  }

  /**
   * paneKey → lane first, config dir second, drop third (S9 §2k).
   *
   * A pane the host knows resolves to a lane whose row must exist: a post naming a lane with no
   * loaded credential is dropped rather than falling back to the config dir, because that
   * fallback is what would land a lane's usage on the shared bar.
   */
  attribute(post: ClaudeStatusLinePost): ClaudeUsageAttribution | null {
    const pane = post.paneKey ? this.paneLaneLookup?.(post.paneKey) : null
    if (pane) {
      return pane.laneId === null ? this.shared : (this.laneAttribution(pane.laneId) ?? null)
    }
    const configDir = normalizeClaudeConfigDir(post.configDir)
    // Why `null === null` counts: a system-default session posts no config dir at all, and that
    // is exactly the shared lane's own key — the compare this map replaces matched it that way.
    if (this.shared && this.sharedConfigDir === configDir) {
      return this.shared
    }
    return configDir ? (this.laneRows.get(configDir) ?? null) : null
  }
}
