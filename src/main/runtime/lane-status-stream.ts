import { randomUUID } from 'node:crypto'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { LaneRotationReceipt } from '../claude-accounts/principal-lane-store'
import type { LaneWireCaller } from './lane-wire-authority'

/**
 * The lane status stream (S9 §2c/§2l), and the liveness precondition that reads it.
 *
 * Teardown has exactly ONE path: `registerSubscriptionCleanup(..., ctx.connectionId)` calls
 * `unsubscribe`, and `cleanupSubscriptionsForConnection` runs it on close — the same join
 * `accounts.subscribe` already makes. A second connection-keyed sweep here would be a divergent
 * teardown, so there is none. No way to address another principal's stream either: a subscriber
 * is filed under the principal its grant resolved to.
 *
 * Every frame here is secretless: `laneState`, a rotation receipt carrying a sha256 and never a
 * token, the designation, and the delegable list's opaque tokens.
 */

export type LaneStatusFrame =
  | { type: 'ready'; subscriptionId: string; status: ClaudeLaneStatus }
  | { type: 'status'; status: ClaudeLaneStatus }
  | { type: 'receipt'; receipt: LaneRotationReceipt }
  | {
      type: 'switch-requested'
      requestId: string
      delegatedAccountId: string
      /** The desktop's own opaque handle for the account, so it can map the ask to its store. */
      clientRef: string
    }
  | { type: 'switch-failed'; requestId: string; code: string; message: string }
  | { type: 'end' }

export type LaneStatusSubscriber = {
  subscriptionId: string
  caller: LaneWireCaller
  emit: (frame: LaneStatusFrame) => void
}

export class LaneStatusStream {
  private readonly subscribers = new Map<string, LaneStatusSubscriber>()

  subscribe(
    caller: LaneWireCaller,
    connectionId: string | null,
    emit: (frame: LaneStatusFrame) => void
  ): LaneStatusSubscriber {
    const subscriptionId = `lane-status-${connectionId ?? 'inproc'}-${randomUUID()}`
    const subscriber: LaneStatusSubscriber = { subscriptionId, caller, emit }
    this.subscribers.set(subscriptionId, subscriber)
    return subscriber
  }

  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId)
  }

  /**
   * §2l's liveness precondition, second conjunct.
   *
   * "Connected" is not enough and `scope` is not the key: a one-shot request socket satisfies
   * neither, and an `orca` CLI grant can hold no subscription at all. What is asked is whether
   * THIS principal's designated grant is carrying a lane-status subscription right now.
   */
  hasSubscriptionForGrant(principalId: string, deviceId: string): boolean {
    for (const subscriber of this.subscribers.values()) {
      if (
        subscriber.caller.principalId === principalId &&
        subscriber.caller.deviceId === deviceId
      ) {
        return true
      }
    }
    return false
  }

  subscribersOf(principalId: string): LaneStatusSubscriber[] {
    return [...this.subscribers.values()].filter(
      (subscriber) => subscriber.caller.principalId === principalId
    )
  }

  /** Every grant of the principal sees it — the desktop included; nobody else does. */
  publish(principalId: string, frame: LaneStatusFrame): number {
    let delivered = 0
    for (const subscriber of this.subscribersOf(principalId)) {
      subscriber.emit(frame)
      delivered += 1
    }
    return delivered
  }

  /** A receipt is per LANE, so it publishes to that lane's principal and no other. */
  publishReceipt(receipt: LaneRotationReceipt): number {
    return this.publish(receipt.laneId, { type: 'receipt', receipt })
  }
}
