import { randomUUID } from 'node:crypto'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { LaneDelegationDirectory } from './lane-delegation-directory'
import type { LaneStatusStream } from './lane-status-stream'
import type { LaneWireAuthority, LaneWireCaller, LaneWirePrincipals } from './lane-wire-authority'

/**
 * §2l's delegated selection: the phone chooses, the desktop pushes, the host arbitrates.
 *
 * The host NEVER switches. It resolves the principal from `ctx.pairedDeviceId`, validates the
 * opaque token against that principal's own delegable list, and forwards a `switch-requested`
 * frame on the lane status stream §2c already ships. It never falls back to `selectClaude`, never
 * falls back to the shared lane, and never reports success while the lane's credential stands.
 *
 * The two refusals partition cleanly and the partition is the point:
 *  - no lane-status subscription open for the DESIGNATED grant → `desktop_unavailable`, refused
 *    BEFORE any frame is emitted, so no request is ever left pending against nobody. A designated
 *    `orca` CLI grant and a retired desktop both land here — the CLI client has no subscribe entry
 *    point at all — and this is the branch rev 21 stops folding the phone into.
 *  - subscribed, no push inside the window → the frame IS emitted and the request expires
 *    `switch_timed_out`, with the lane byte-identical. A designated PHONE is exactly this case.
 */

export const LANE_SWITCH_REQUEST_TIMEOUT_MS = 30_000

export type LaneSwitchRequestResult = { status: 'pending'; requestId: string }

export type LaneDelegatedSwitchOptions = {
  authority: LaneWireAuthority
  principals: LaneWirePrincipals
  delegation: LaneDelegationDirectory
  stream: LaneStatusStream
  timeoutMs?: number
  scheduleTimeout?: (run: () => void, ms: number) => { cancel: () => void }
}

type PendingRequest = {
  requestId: string
  laneId: string
  cancel: () => void
}

export class LaneDelegatedSwitchService {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: LaneDelegatedSwitchOptions) {}

  requestSwitch(
    pairedDeviceId: string | null | undefined,
    delegatedAccountId: string
  ): LaneSwitchRequestResult {
    const caller = this.options.authority.requireCaller(pairedDeviceId)
    const account = this.options.delegation.resolveDelegatedAccount(
      caller.principalId,
      delegatedAccountId
    )
    this.assertDelegatedDesktopSubscribed(caller)
    const requestId = randomUUID()
    this.options.stream.publish(caller.principalId, {
      type: 'switch-requested',
      requestId,
      delegatedAccountId: account.delegatedAccountId,
      clientRef: account.clientRef
    })
    this.arm(requestId, caller.principalId)
    return { status: 'pending', requestId }
  }

  /** A push into the lane answers every request outstanding on it. */
  settleForLane(laneId: string): void {
    for (const request of this.pending.values()) {
      if (request.laneId === laneId) {
        request.cancel()
        this.pending.delete(request.requestId)
      }
    }
  }

  hasPendingFor(laneId: string): boolean {
    for (const request of this.pending.values()) {
      if (request.laneId === laneId) {
        return true
      }
    }
    return false
  }

  private assertDelegatedDesktopSubscribed(caller: LaneWireCaller): void {
    const delegatedGrantId = this.options.principals.delegatedGrantIdOf(caller.principalId)
    if (!delegatedGrantId) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.no_pusher_designated',
        'Nobody is designated to load Claude accounts into this lane on this host, so this account cannot be switched from here. Pick which device pushes accounts, in Orca on the host machine.'
      )
    }
    if (!this.options.stream.hasSubscriptionForGrant(caller.principalId, delegatedGrantId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.desktop_unavailable',
        'Your desktop is not connected, so this account cannot be switched from here. Open Orca on the desktop that holds your Claude accounts and try again.'
      )
    }
  }

  private arm(requestId: string, laneId: string): void {
    const timeoutMs = this.options.timeoutMs ?? LANE_SWITCH_REQUEST_TIMEOUT_MS
    const schedule = this.options.scheduleTimeout ?? defaultSchedule
    const handle = schedule(() => this.expire(requestId), timeoutMs)
    this.pending.set(requestId, { requestId, laneId, cancel: handle.cancel })
  }

  private expire(requestId: string): void {
    const request = this.pending.get(requestId)
    if (!request) {
      return
    }
    this.pending.delete(requestId)
    // The lane is untouched: this is a report, not a rollback — nothing was ever written.
    this.options.stream.publish(request.laneId, {
      type: 'switch-failed',
      requestId,
      code: 'accounts.lane.switch_timed_out',
      message:
        'Your desktop did not answer the request to switch this Claude account, so nothing was changed. Check that Orca is running on that desktop and try again.'
    })
  }
}

function defaultSchedule(run: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
