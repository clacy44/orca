import { randomUUID } from 'node:crypto'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneRefusalCode } from '../../shared/claude-lane-refusals'
import type { LaneLoginIdentity } from '../../shared/claude-lane-login-rpc'
import { laneStatusEqual } from '../claude-accounts/lane-status-frame-equality'
import type { LaneWireCaller, LaneWirePrincipals } from './lane-wire-authority'

/**
 * The lane status stream (S9 §2c/§2l).
 *
 * Teardown has exactly ONE path: `registerSubscriptionCleanup(..., ctx.connectionId)` calls
 * `unsubscribe`, and `cleanupSubscriptionsForConnection` runs it on close — the same join
 * `accounts.subscribe` already makes. A second connection-keyed sweep here would be a divergent
 * teardown, so there is none. No way to address another principal's stream either: a subscriber
 * is filed under the principal its grant resolved to.
 *
 * Every frame here is secretless: `laneState` and the designation, never a credential.
 *
 * A subscriber is filed by its GRANT, and the principal is re-resolved on every delivery — the
 * same per-emit resolve `accounts.subscribe`'s projection makes. Snapshotting the caller at
 * subscribe time survived an unbind and a re-bind, neither of which touches the socket, so a grant
 * moved to another person kept receiving the first person's identity and sha.
 *
 * Rev 32 deletes `switch-requested`/`switch-failed` (the deleted `requestSwitch` flow) and
 * `receipt` (the deleted watermark's rotation receipts); S9-L1 adds the three login-session frames
 * below in their place (§3 row 2) — additive only, matching `shared/claude-lane-login-rpc.ts`'s
 * `LaneLoginStatusFrame` (L2's already-merged client contract) shape-for-shape.
 */

export type LaneStatusFrame =
  | { type: 'ready'; subscriptionId: string; status: ClaudeLaneStatus }
  | { type: 'status'; status: ClaudeLaneStatus }
  | { type: 'end' }
  // (ii): never carries the URL — that rides only the starting grant's `loginStart` reply.
  | { type: 'login-started'; loginSessionId: string; expiresAt: number }
  | { type: 'login-completed'; loginSessionId: string; identity: LaneLoginIdentity }
  | { type: 'login-failed'; loginSessionId: string; code: ClaudeLaneRefusalCode; message: string }

export type LaneStatusSubscriber = {
  subscriptionId: string
  /** The grant, never the principal: the binding it resolves through can move under the socket. */
  deviceId: string
  emit: (frame: LaneStatusFrame) => void
  /** The last `status` frame actually delivered to this subscriber — `publish`'s dedupe input.
   * Optional so a bare object literal (as tests construct for `callerOf`) still satisfies the
   * type; treated as "nothing delivered yet" when absent. */
  lastStatus?: ClaudeLaneStatus | null
}

export class LaneStatusStream {
  private readonly subscribers = new Map<string, LaneStatusSubscriber>()

  constructor(private readonly principals: Pick<LaneWirePrincipals, 'principalOf'>) {}

  subscribe(
    caller: LaneWireCaller,
    connectionId: string | null,
    emit: (frame: LaneStatusFrame) => void
  ): LaneStatusSubscriber {
    const subscriptionId = `lane-status-${connectionId ?? 'inproc'}-${randomUUID()}`
    const subscriber: LaneStatusSubscriber = {
      subscriptionId,
      deviceId: caller.deviceId,
      emit,
      lastStatus: null
    }
    this.subscribers.set(subscriptionId, subscriber)
    return subscriber
  }

  /** The caller a delivery is FOR, re-resolved now; null once the grant is unbound. */
  callerOf(subscriber: LaneStatusSubscriber): LaneWireCaller | null {
    const principalId = this.principals.principalOf(subscriber.deviceId)
    return principalId ? { deviceId: subscriber.deviceId, principalId } : null
  }

  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId)
  }

  subscribersOf(principalId: string): LaneStatusSubscriber[] {
    return [...this.subscribers.values()].filter(
      (subscriber) => this.callerOf(subscriber)?.principalId === principalId
    )
  }

  /** Every grant of the principal sees it — the desktop included; nobody else does.
   *
   * A `status` frame is deduped against the LAST one this particular subscriber actually
   * received (`laneStatusEqual`, which compares `accounts`/`heldIdentity` by value rather than by
   * the fresh-projection reference every status read hands back) — `emitStatusToLane` re-emits on
   * every lane change whether or not that change altered what a given grant's own view of the
   * lane shows, and a subscriber deserves a stable frame, not a `status` tick on every unrelated
   * change. Every other frame kind (`login-started`, …) always delivers — dedupe applies only to
   * the field-comparable `status` shape. */
  publish(principalId: string, frame: LaneStatusFrame): number {
    let delivered = 0
    for (const subscriber of this.subscribersOf(principalId)) {
      if (frame.type === 'status') {
        if (laneStatusEqual(subscriber.lastStatus ?? null, frame.status)) {
          continue
        }
        subscriber.lastStatus = frame.status
      }
      subscriber.emit(frame)
      delivered += 1
    }
    return delivered
  }
}
