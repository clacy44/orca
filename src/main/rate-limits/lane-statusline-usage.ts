import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import type { RuntimeTerminalLaneUsage } from '../../shared/runtime-types'

/**
 * The per-lane sink for statusline-derived usage (S9 §2d/§2k).
 *
 * `state.claude` is ONE host-wide bar and it is peer-visible: `getAccountsSnapshot()` carries it
 * verbatim through the accounts projection to every paired client. So a lane terminal's post must
 * never land there — attributing it and then writing it to the shared object publishes one
 * developer's usage on the other's bar, which is the inversion of what §2d promises a peer ("the
 * caller's own lane row"; another principal's usage omitted, never zeroed).
 *
 * It is also the only feed a lane row has where the pull cannot run: on `win32` the probe is off
 * (§2k Fact 2), so without this map the "statusline-derived usage only" degradation delivers no
 * lane usage at all.
 */

export type LaneStatuslineUsageInput = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  /** Already passed through `publishedAuthProvenance`; never a raw lane path or principal id. */
  authProvenance: string
}

export class LaneStatuslineUsageStore {
  private readonly byLane = new Map<string, ProviderRateLimits>()

  /**
   * A statusline payload can carry a single window; an absent one means "no update", not
   * "cleared" — the same rule the shared bar applies, kept per lane.
   */
  ingest(laneId: string, input: LaneStatuslineUsageInput): ProviderRateLimits {
    const previous = this.byLane.get(laneId) ?? null
    const row: ProviderRateLimits = {
      provider: 'claude',
      session: input.session ?? previous?.session ?? null,
      weekly: input.weekly ?? previous?.weekly ?? null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: {
        source: 'live-session',
        lastSuccessfulSource: 'live-session',
        authProvenance: input.authProvenance
      }
    }
    this.byLane.set(laneId, row)
    return row
  }

  get(laneId: string): ProviderRateLimits | null {
    return this.byLane.get(laneId) ?? null
  }

  /** A wiped or reauth-held lane stops attracting posts; its row goes with it (§2d). */
  forget(laneId: string): void {
    this.byLane.delete(laneId)
  }

  retainLanes(laneIds: Iterable<string>): void {
    const kept = new Set(laneIds)
    // Deleting the current key mid-iteration is defined for a Map; no copy needed.
    for (const laneId of this.byLane.keys()) {
      if (!kept.has(laneId)) {
        this.byLane.delete(laneId)
      }
    }
  }
}

/**
 * The lane row's two feeds, joined: the probe's pull and the live statusline post (§2k).
 *
 * Fresher wins rather than one source outranking the other — the probe is a tick sample and the
 * post is a live session, and on `win32` the probe never runs at all, so a fixed precedence would
 * either freeze the bar behind a stale tick or discard the only feed that host has.
 */
/**
 * The whole of one terminal row's `laneUsage` field (§2k).
 *
 * Where no feed answered AND no probe can run, the row states the CONDITION rather than rendering
 * a bar-less label: `unavailableReason` is a code, because the host does not know the viewer's
 * locale and the sentence belongs to the client.
 */
export function resolveLaneUsageRow(input: {
  pulled: ProviderRateLimits | null
  posted: ProviderRateLimits | null
  pullDisabled: boolean
}): RuntimeTerminalLaneUsage | null {
  const usage = pickFresherLaneUsage(input.pulled, input.posted)
  if (usage) {
    return { session: usage.session, weekly: usage.weekly }
  }
  return input.pullDisabled
    ? { session: null, weekly: null, unavailableReason: 'pull-unsupported-on-host' }
    : null
}

export function pickFresherLaneUsage(
  pulled: ProviderRateLimits | null,
  posted: ProviderRateLimits | null
): ProviderRateLimits | null {
  if (!pulled) {
    return posted
  }
  if (!posted) {
    return pulled
  }
  return posted.updatedAt >= pulled.updatedAt ? posted : pulled
}
