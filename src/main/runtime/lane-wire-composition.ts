import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'
import type { LaneWirePrincipals } from './lane-wire-authority'
import type { PrincipalRegistry } from './principal-registry'

/**
 * The one PRODUCTION composition of `LaneWireService` (S9 release-audit B1, rev 32's re-basing).
 *
 * `attachLaneWireService` has existed since S9c, but nothing in `src/main` ever called it: every
 * runtime start left it unattached, so every lane RPC refused `accounts.lane.not_enabled` and the
 * close/revoke wipe hooks in `principal-lane-connection-lifecycle.ts` read a null coordinator and
 * did nothing. This file is the missing wire, composed the same way the consent surface already
 * is (`principal-lane-consent-service.ts:161-171`): a module-singleton dependency provider set
 * once, early, by `index.ts`, and a per-registry composer called by `attachPrincipalLaneHost`.
 *
 * Rev 32 deletes the managed-account residency guard and the delegation persistence with the push
 * model (§10(g)): the coordinator is the only dependency left, because no account can be resident
 * in a lane any more.
 */

export type LaneWireHostDependencies = {
  coordinator: LaneCredentialCoordinator
}

let hostDependencies: LaneWireHostDependencies | null = null

export function setLaneWireHostDependencies(deps: LaneWireHostDependencies | null): void {
  hostDependencies = deps
}

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
    coordinator: deps.coordinator
    // switchGate and platform are deliberately omitted: undefined resolves to the production
    // switch gate (`LANE_SWITCH_GATE`, lane-wire-authority.ts) and to `process.platform` — the
    // same defaults the coordinator (runtime-auth-service.ts) and the consent service already
    // fall back to. Only tests inject either.
  })
}

export function attachComposedLaneWire(registry: PrincipalRegistry): void {
  attachLaneWireService(composeLaneWireForRegistry(registry))
}

export function detachComposedLaneWire(): void {
  attachLaneWireService(null)
}
