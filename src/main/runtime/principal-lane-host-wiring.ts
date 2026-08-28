import { join } from 'node:path'
import { PrincipalRegistry, type PrincipalGrantSource } from './principal-registry'
import {
  PrincipalLaneConsentService,
  attachPrincipalLaneConsentService,
  type PairingInviteSource
} from './principal-lane-consent-service'
import type { PrincipalLookup } from './terminal-credential-lane-resolution'
import type { RuntimeTerminalLaneAccountLabel } from '../../shared/runtime-types'
import { getLaneWireService } from './lane-wire-service'
import { attachComposedLaneWire, detachComposedLaneWire } from './lane-wire-composition'
import { CLAUDE_LANES_DIRNAME } from '../claude-accounts/claude-lanes-root'
import { resolveOwnedPrincipalLaneDir } from '../claude-accounts/principal-credential-lane'
import { reconcileLaneAccountStore } from '../claude-accounts/lane-account-store-reconciliation'

/**
 * Where the principal registry becomes the host's live authority (S9 §2a, §6).
 *
 * Until this runs, `PaneLaneAuthority` holds no lookup at all: no grant resolves to a lane and
 * every pane is `shared`. Attaching the registry is what ARMS `terminal.lane_link_unbound` for a
 * link whose fingerprint is unticked, so it fails closed rather than creating a worktree, a
 * startup terminal and a setup pane on whoever's credential the host holds. It is not the ONLY
 * thing that arms it: the persisted binding rows outlive the registry — a start that never
 * attaches one (WebSocket transport disabled, pairing init failed) still rehydrates
 * `{kind:'principal'}` rows — so `PaneLaneAuthority` refuses on those rows alone rather than
 * falling through to `shared`, which on such a host is the downgrade and not the only lane.
 *
 * It is bound to the pairing registry's lifetime: the grant rows are the registry's own input
 * (a revoked grant stops resolving immediately), and the runtime's shared `authToken` is the
 * value the federated-link binding refuses by name.
 */
export type PrincipalLaneHostAttachment = {
  registry: PrincipalRegistry
  lookup: PrincipalLookup
}

/**
 * Both members are optional because a REMOTE-host runtime proxy legitimately implements only the
 * RPC-forwarded methods: lanes are a local-host concern, so a proxy has none to arm and attaching
 * must not throw at it.
 */
export type PrincipalLaneHostRuntime = {
  setPrincipalLaneLookup?(lookup: PrincipalLookup | null): void
  setLaneAccountRowResolvers?(resolvers: {
    laneAccountLabelOf?: ((principalId: string) => RuntimeTerminalLaneAccountLabel | null) | null
  }): void
}

export function attachPrincipalLaneHost(input: {
  userDataPath: string
  grants: PrincipalGrantSource
  runtimeAuthToken: string
  runtime: PrincipalLaneHostRuntime
  // Why optional: a REMOTE-host runtime proxy passes none, and `mintInvite` refuses
  // `accounts.lane.invite_unavailable` rather than throwing at attach time.
  pairing?: PairingInviteSource
}): PrincipalLaneHostAttachment {
  const registry = new PrincipalRegistry(input.userDataPath, input.grants, {
    runtimeAuthToken: input.runtimeAuthToken
  })
  const lookup: PrincipalLookup = {
    // Why a delegating object and not the registry itself: the funnel must see exactly these two
    // reads, so no future registry method can become an implicit lane authority.
    principalOf: (deviceId) => registry.principalOf(deviceId),
    linkPrincipalOf: (homePeerFingerprint) => registry.linkPrincipalOf(homePeerFingerprint)
  }
  const consentService = new PrincipalLaneConsentService(
    registry,
    undefined,
    undefined,
    input.pairing,
    // A connected desktop's lane-status subscription otherwise only re-learns
    // `callerIsDelegatedGrant` on its next unrelated push/clear (release-audit follow-up).
    (principalId) => getLaneWireService()?.notifyPrincipalChanged(principalId)
  )
  attachPrincipalLaneConsentService(consentService)
  // Startup sweep (release-audit follow-up): `reconcileOrphanLanes` had no production caller —
  // a lane directory for a principal the registry no longer binds any device to would sit on
  // disk forever. Runs once, right after the registry this host now trusts is attached.
  consentService.reconcileOrphanLanes()
  // S9-L1 B4/§storeLayout "STARTUP ORDER": each SURVIVING lane's own `claude-accounts` store,
  // right after the orphan pass above and before anything seeds live sessions from it. Not
  // gated on `registry.loadSucceeded` — arm B is this pass's own fail-safe, not a borrowed one.
  const lanesRoot = join(input.userDataPath, CLAUDE_LANES_DIRNAME)
  for (const principalId of registry.boundPrincipalIds()) {
    const laneDir = resolveOwnedPrincipalLaneDir(principalId, { lanesRoot })
    if (laneDir) {
      reconcileLaneAccountStore(laneDir)
    }
  }
  // Bound to the same registry, same lifetime, for the same reason as the consent surface above
  // (release-audit B1): the wire's lanes derive from this registry's grant rows.
  attachComposedLaneWire(registry)
  input.runtime.setLaneAccountRowResolvers?.({
    laneAccountLabelOf: (principalId) => laneAccountLabel(registry, principalId)
  })
  input.runtime.setPrincipalLaneLookup?.(lookup)
  return { registry, lookup }
}

/**
 * Q3's row label: the host-observed principal name.
 *
 * Rev 32 deletes the delegation directory (§10(g)), so there is no more owner-authored account
 * name a push carried alongside the credential — S9-L1's account index restores an owner-set label
 * under a different name once it lands.
 */
function laneAccountLabel(
  registry: PrincipalRegistry,
  principalId: string
): RuntimeTerminalLaneAccountLabel | null {
  const owner = registry
    .listPrincipals()
    .find((record) => record.principalId === principalId)?.displayName
  return owner ? { owner } : null
}

/**
 * Pairing became unavailable, so the grant rows behind every binding are gone.
 *
 * Detaching returns the host to its pre-S9 behaviour — every pane `shared` — rather than leaving
 * a lookup answering from a registry whose grant source it can no longer read.
 */
export function detachPrincipalLaneHost(runtime: PrincipalLaneHostRuntime): void {
  attachPrincipalLaneConsentService(null)
  detachComposedLaneWire()
  runtime.setPrincipalLaneLookup?.(null)
  // The label resolver closes over the registry whose grant source is gone: left attached, the
  // host keeps minting PEER-VISIBLE owner labels from rows nothing can revoke any more (§2h).
  runtime.setLaneAccountRowResolvers?.({ laneAccountLabelOf: null })
}
