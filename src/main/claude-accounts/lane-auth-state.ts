/**
 * `ClaudeRuntimeAuthService`'s per-lane write queue (S9 §2c, rev 32's credential-source re-basing).
 *
 * Rev 32 deletes Orca's managed refresh of a lane's chain — the lane's own CLI rotates its own
 * chain now (§2e) — so this class keeps only the per-lane write serialization S9-L1's write queue
 * (the in-lane switch, the login capture and the wipe) needs, and drops the account-keyed rotation
 * queue and the state fields that existed only to observe Orca's own rotation attempts.
 */

// Why visible, and why this: a lane id is a UUID, so `::` cannot occur on the left of the key and
// no accountUuid can forge a different lane's row by carrying one.
const LANE_ACCOUNT_KEY_SEPARATOR = '::'

export type LaneAccountAuthState = {
  lastSyncedAccountUuid: string | null
  lastWrittenCredentialsJson: string | null
}

export class LaneAuthState {
  private readonly statesByLaneAccount = new Map<string, LaneAccountAuthState>()
  private readonly writeQueueByLane = new Map<string, Promise<unknown>>()

  getState(laneId: string, accountUuid: string | null): LaneAccountAuthState {
    const key = laneAccountKey(laneId, accountUuid)
    const existing = this.statesByLaneAccount.get(key)
    if (existing) {
      return existing
    }
    const fresh: LaneAccountAuthState = {
      lastSyncedAccountUuid: null,
      lastWrittenCredentialsJson: null
    }
    this.statesByLaneAccount.set(key, fresh)
    return fresh
  }

  forgetLane(laneId: string): void {
    const prefix = `${laneId}${LANE_ACCOUNT_KEY_SEPARATOR}`
    for (const key of this.statesByLaneAccount.keys()) {
      if (key.startsWith(prefix)) {
        this.statesByLaneAccount.delete(key)
      }
    }
  }

  /**
   * One queue per lane: lane A's slow write does not delay lane B's.
   *
   * The lane's three writers — the in-lane switch, the login capture and the wipe — all enter
   * through here, with the wipe holding precedence (§6's S9-L1 obligation 4).
   */
  serializeLaneWrite<T>(laneId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.writeQueueByLane.get(laneId) ?? Promise.resolve()).then(fn, fn)
    this.writeQueueByLane.set(
      laneId,
      next.catch(() => {})
    )
    return next
  }
}

export function laneAccountKey(laneId: string, accountUuid: string | null): string {
  return `${laneId}${LANE_ACCOUNT_KEY_SEPARATOR}${accountUuid ?? ''}`
}
