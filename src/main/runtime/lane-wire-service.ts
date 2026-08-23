import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import {
  ManagedAccountResidencyGuard,
  attachManagedAccountResidencyGuard,
  type ManagedAccountLookup
} from '../claude-accounts/managed-account-lane-residency'
import {
  LaneDelegationDirectory,
  type LaneDelegationPersistence
} from './lane-delegation-directory'
import { LaneDelegatedSwitchService } from './lane-delegated-switch'
import { LaneStatusStream } from './lane-status-stream'
import {
  LaneWireAuthority,
  type LaneSwitchGate,
  type LaneWirePrincipals
} from './lane-wire-authority'

/**
 * The one host-side composition of the lane wire, and the seam the RPC layer reads it through.
 *
 * Attached exactly like the consent surface (`principal-lane-consent-service.ts`): with nothing
 * attached, every lane method refuses by name rather than half-working, which is what a host that
 * has no principal registry wired must do.
 */

export type LaneWireServiceOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  persistence: LaneDelegationPersistence
  /** The managed store L1's second edge resolves an account id through (§2d). */
  accounts?: ManagedAccountLookup
  switchGate?: LaneSwitchGate
  platform?: NodeJS.Platform
}

export class LaneWireService {
  readonly stream = new LaneStatusStream()
  readonly delegation: LaneDelegationDirectory
  readonly authority: LaneWireAuthority
  readonly switches: LaneDelegatedSwitchService
  readonly coordinator: LaneCredentialCoordinator
  readonly residencyGuard: ManagedAccountResidencyGuard | null
  private readonly principals: LaneWirePrincipals
  private disposeReceipts: (() => void) | null = null

  constructor(options: LaneWireServiceOptions) {
    this.coordinator = options.coordinator
    this.principals = options.principals
    this.delegation = new LaneDelegationDirectory(options.persistence)
    this.authority = new LaneWireAuthority({
      principals: options.principals,
      coordinator: options.coordinator,
      delegation: this.delegation,
      switchGate: options.switchGate,
      platform: options.platform,
      onLaneChanged: (laneId) => this.onLaneChanged(laneId)
    })
    this.switches = new LaneDelegatedSwitchService({
      authority: this.authority,
      principals: options.principals,
      delegation: this.delegation,
      stream: this.stream
    })
    // Both L1 edges arm together: `selectClaude` and `removeClaude` share one predicate, and a
    // build that armed only one would re-create the double residency L1 exists to prevent.
    this.residencyGuard = options.accounts
      ? new ManagedAccountResidencyGuard({
          residency: options.coordinator.residency,
          accounts: options.accounts
        })
      : null
    // Every rotation the host observes is published to that lane's own grants — and only those.
    this.disposeReceipts = options.coordinator.store.onRotationReceipt((receipt) => {
      this.stream.publishReceipt(receipt)
    })
  }

  /** The principals a projection may enumerate; with no lookup it shows the caller's lane only. */
  listLanes(): readonly { principalId: string; label: string | null }[] {
    return this.principals.listPrincipals?.() ?? []
  }

  /** A push answers the pending switch requests on its lane, then republishes lane status. */
  private onLaneChanged(laneId: string): void {
    this.switches.settleForLane(laneId)
    for (const subscriber of this.stream.subscribersOf(laneId)) {
      subscriber.emit({ type: 'status', status: this.authority.statusOf(subscriber.caller) })
    }
  }

  dispose(): void {
    this.disposeReceipts?.()
    this.disposeReceipts = null
  }
}

let attachedLaneWire: LaneWireService | null = null

export function attachLaneWireService(service: LaneWireService | null): void {
  attachedLaneWire?.dispose()
  attachedLaneWire = service
  attachManagedAccountResidencyGuard(service?.residencyGuard ?? null)
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
