import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { LaneStatusStream } from './lane-status-stream'
import {
  LaneWireAuthority,
  type LaneChangeCause,
  type LaneSwitchGate,
  type LaneWirePrincipals
} from './lane-wire-authority'

/**
 * The one host-side composition of the lane wire, and the seam the RPC layer reads it through.
 *
 * Attached exactly like the consent surface (`principal-lane-consent-service.ts`): with nothing
 * attached, every lane method refuses by name rather than half-working, which is what a host that
 * has no principal registry wired must do.
 *
 * Rev 32 deletes the delegation directory and the delegated-switch service with the push model
 * (§10(g)): a switch is now `accounts.lane.selectAccount`, synchronous over the lane's own store,
 * with no pending state and nothing here to settle or fail it. The managed-account residency guard
 * is deleted too — with L1 gone, no account can be resident in a lane at all.
 */

export type LaneWireServiceOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  switchGate?: LaneSwitchGate
  platform?: NodeJS.Platform
}

export class LaneWireService {
  readonly stream: LaneStatusStream
  readonly authority: LaneWireAuthority
  readonly coordinator: LaneCredentialCoordinator
  private readonly principals: LaneWirePrincipals

  constructor(options: LaneWireServiceOptions) {
    this.coordinator = options.coordinator
    this.principals = options.principals
    this.stream = new LaneStatusStream(options.principals)
    this.authority = new LaneWireAuthority({
      principals: options.principals,
      coordinator: options.coordinator,
      switchGate: options.switchGate,
      platform: options.platform,
      onLaneChanged: (laneId, cause) => this.onLaneChanged(laneId, cause)
    })
    // §2f's lifecycle wipes run below the wire; the lane's own grants still have to learn that
    // their credential stopped being resident.
    options.coordinator.setLaneWipedListener((laneId) => this.onLaneChanged(laneId, 'wipe'))
  }

  labelOf(principalId: string): string | null {
    const named = this.principals.labelOf?.(principalId)
    if (named) {
      return named
    }
    return (
      this.principals.listPrincipals?.().find((row) => row.principalId === principalId)?.label ??
      null
    )
  }

  /** The principals a projection may enumerate; with no lookup it shows the caller's lane only. */
  listLanes(): readonly { principalId: string; label: string | null }[] {
    return this.principals.listPrincipals?.() ?? []
  }

  private onLaneChanged(laneId: string, _cause: LaneChangeCause): void {
    this.emitStatusToLane(laneId)
  }

  /**
   * Additive (release-audit follow-up): a registry write outside the wire — bind, unbind,
   * rebind, designate, provision, deprovision — changes what `statusOf` answers for this
   * principal's grants without going through `onLaneChanged`. A connected desktop otherwise never
   * learns `callerIsDelegatedGrant` flipped until its next unrelated status probe.
   */
  notifyPrincipalChanged(principalId: string): void {
    this.emitStatusToLane(principalId)
  }

  private emitStatusToLane(laneId: string): void {
    for (const subscriber of this.stream.subscribersOf(laneId)) {
      const caller = this.stream.callerOf(subscriber)
      if (caller) {
        subscriber.emit({ type: 'status', status: this.authority.statusOf(caller) })
      }
    }
  }

  dispose(): void {
    // The wipe listener is deliberately NOT cleared here: `attachLaneWireService` disposes the
    // outgoing service AFTER the incoming one's constructor has already registered its own, so
    // clearing would unregister the live listener. The constructor is the single writer, and a
    // detach with no incoming service calls `detachLaneWipedListener` instead.
  }

  /** Detach only: with nothing incoming, the coordinator would keep calling a disposed service. */
  detachLaneWipedListener(): void {
    this.coordinator.setLaneWipedListener(null)
  }
}

let attachedLaneWire: LaneWireService | null = null

export function attachLaneWireService(service: LaneWireService | null): void {
  if (!service) {
    attachedLaneWire?.detachLaneWipedListener()
  }
  attachedLaneWire?.dispose()
  attachedLaneWire = service
}

export function getLaneWireService(): LaneWireService | null {
  return attachedLaneWire
}

export function requireLaneWireService(): LaneWireService {
  if (!attachedLaneWire) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.not_enabled',
      'Per-person Claude credential lanes are not enabled on this host, so this account was not loaded anywhere. Update Orca on the host machine, or use the account picker on the host itself.'
    )
  }
  return attachedLaneWire
}
