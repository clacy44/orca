import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import type {
  ManagedAccountLookup,
  ResidencyUnverifiableReason
} from '../claude-accounts/managed-account-lane-residency'
import type { LaneDelegationPersistence } from './lane-delegation-directory'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'
import type { LaneWirePrincipals } from './lane-wire-authority'
import type { PrincipalRegistry } from './principal-registry'

/**
 * The one PRODUCTION composition of `LaneWireService` (S9 release-audit B1).
 *
 * `attachLaneWireService` has existed since S9c, but nothing in `src/main` ever called it: every
 * runtime start left it unattached, so every lane RPC refused `accounts.lane.not_enabled` and the
 * close/revoke wipe hooks in `principal-lane-connection-lifecycle.ts` read a null coordinator and
 * did nothing. This file is the missing wire, composed the same way the consent surface already
 * is (`principal-lane-consent-service.ts:161-171`) and the residency guard already is
 * (`managed-account-lane-residency.ts:87-93`): a module-singleton dependency provider set once,
 * early, by `index.ts`, and a per-registry composer called by `attachPrincipalLaneHost`.
 *
 * Two objects on purpose, not one extra parameter on `attachPrincipalLaneHost`: the coordinator,
 * store and managed-account lookup are owned far from that function's one caller
 * (`OrcaRuntimeRpcServer.start()`, which only holds `runtime`/`userDataPath`/`deviceRegistry`),
 * and `runtime-rpc.ts` is on the max-lines ratchet, so threading them through it is not available.
 */

export type LaneWireHostDependencies = {
  coordinator: LaneCredentialCoordinator
  persistence: LaneDelegationPersistence
  accounts: ManagedAccountLookup
  /** Test-only override of the fail-closed predicate below; production omits it. */
  onResidencyUnverifiable?: (accountId: string, reason: ResidencyUnverifiableReason) => void
}

let hostDependencies: LaneWireHostDependencies | null = null

export function setLaneWireHostDependencies(deps: LaneWireHostDependencies | null): void {
  hostDependencies = deps
}

const RESIDENCY_UNVERIFIABLE_MESSAGE =
  "Orca could not read this Claude account's own credential files, so it could not prove the " +
  'account is not loaded in someone’s credential lane on this host, and it changed nothing. ' +
  'Sign the account in again in Orca, or remove its lane holder first.'

/**
 * Returns null when no dependencies are registered — a runtime started before, or without, a
 * `ClaudeRuntimeAuthService` (a test harness, or a remote-host proxy) keeps today's
 * `accounts.lane.not_enabled` rather than half-arming a wire with no coordinator behind it.
 */
export function composeLaneWireForRegistry(registry: PrincipalRegistry): LaneWireService | null {
  const deps = hostDependencies
  if (!deps) {
    return null
  }
  const principals: LaneWirePrincipals = {
    principalOf: (deviceId) => registry.principalOf(deviceId),
    delegatedGrantIdOf: (principalId) => registry.delegatedGrantIdOf(principalId),
    labelOf: (principalId) =>
      registry.listPrincipals().find((row) => row.principalId === principalId)?.displayName ?? null,
    listPrincipals: () =>
      registry
        .listPrincipals()
        .map((row) => ({ principalId: row.principalId, label: row.displayName }))
  }
  return new LaneWireService({
    principals,
    coordinator: deps.coordinator,
    persistence: deps.persistence,
    accounts: deps.accounts,
    // switchGate and platform are deliberately omitted: undefined resolves to the production
    // switch gate (`LANE_SWITCH_GATE`, lane-wire-authority.ts) and to `process.platform` — the
    // same defaults the coordinator (runtime-auth-service.ts) and the consent service already
    // fall back to. Only tests inject either.
    onResidencyUnverifiable:
      deps.onResidencyUnverifiable ??
      ((accountId, reason) => {
        console.warn(
          `[claude-accounts] Could not check lane residency for managed account ${accountId} (${reason}).`
        )
        const anyLaneResident = registry
          .listPrincipals()
          .some((row) => deps.coordinator.residency.getLaneRowKeys(row.principalId) !== null)
        if (anyLaneResident) {
          throw new ClaudeLaneRefusal(
            'accounts.lane.residency_unverifiable',
            RESIDENCY_UNVERIFIABLE_MESSAGE
          )
        }
      })
  })
}

export function attachComposedLaneWire(registry: PrincipalRegistry): void {
  attachLaneWireService(composeLaneWireForRegistry(registry))
}

export function detachComposedLaneWire(): void {
  attachLaneWireService(null)
}
