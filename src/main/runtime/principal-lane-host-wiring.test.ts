/**
 * S9 §2a/§6 — attaching the principal registry to the host is what ARMS the lane authority. Until
 * it runs, every grant is lane-less and, worse, a federated create falls through to the shared
 * lane instead of being refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { authorizeHostConsent } from './principal-consent-authority'
import { getPrincipalLaneConsentService } from './principal-lane-consent-service'
import {
  attachPrincipalLaneHost,
  detachPrincipalLaneHost,
  type PrincipalLaneHostRuntime
} from './principal-lane-host-wiring'
import { PaneLaneAuthority } from './pane-lane-authority'
import type { PrincipalGrantRow, PrincipalGrantSource } from './principal-registry'
import type { PrincipalLookup } from './terminal-credential-lane-resolution'

const RUNTIME_AUTH_TOKEN = 'a'.repeat(48)
const PEER_TOKEN = 'peer-token'
const fingerprintOf = (value: string): string => createHash('sha256').update(value).digest('hex')

class FakeGrants implements PrincipalGrantSource {
  loadSucceeded = true
  private rows: PrincipalGrantRow[] = [
    {
      deviceId: 'home-peer',
      name: 'Ana laptop',
      token: PEER_TOKEN,
      pairedAt: 1_000,
      // Redeemed (M1) — this fixture stands for an already-paired device.
      lastSeenAt: 1_000,
      pendingExpiresAt: Date.now() + 60_000
    }
  ]

  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }

  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

function laneAuthority(
  lookup: PrincipalLookup | null,
  persistedLanes: Record<string, { worktreeId: string; principalId?: string }> | null = null
): PaneLaneAuthority {
  const authority = new PaneLaneAuthority({
    rendererLeafExists: () => false,
    livePtyPaneKeys: () => [],
    workspaceSessionOf: () => null,
    mobileSessionTabsOf: () => null,
    paneOfPty: () => null,
    readPersistedLanes: () => persistedLanes,
    persistLane: () => undefined,
    forgetPersistedLane: () => undefined,
    killPty: () => undefined
  })
  authority.setPrincipalLookup(lookup)
  return authority
}

function refusalCodeOf(run: () => unknown): string {
  try {
    run()
    return 'no-refusal'
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : 'other-error'
  }
}

describe('attachPrincipalLaneHost', () => {
  let userDataPath = ''
  let lookups: (PrincipalLookup | null)[] = []
  let runtime: PrincipalLaneHostRuntime

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wiring-'))
    lookups = []
    runtime = { setPrincipalLaneLookup: (lookup) => lookups.push(lookup) }
  })

  afterEach(() => {
    detachPrincipalLaneHost({ setPrincipalLaneLookup: () => undefined })
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('installs a lookup, the host consent surface and the row label resolver', () => {
    const labelResolvers: {
      laneAccountLabelOf?: ((principalId: string) => { owner: string } | null) | null
    }[] = []
    const { registry, lookup } = attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime: {
        setPrincipalLaneLookup: (next) => lookups.push(next),
        setLaneAccountRowResolvers: (resolvers) => labelResolvers.push(resolvers)
      }
    })
    const person = registry.createPrincipal(authorizeHostConsent({}), 'Ana')

    expect(lookups).toEqual([lookup])
    expect(getPrincipalLaneConsentService()).not.toBeNull()
    // The owner half is a host-side join and is available as soon as the registry is;
    // the account name stays absent until a push names one.
    expect(labelResolvers.at(-1)?.laneAccountLabelOf?.(person.principalId)).toEqual({
      owner: 'Ana'
    })
    expect(labelResolvers.at(-1)?.laneAccountLabelOf?.('not-a-principal')).toBeNull()
  })

  it('arms the federated refusal: an unticked link fails closed for every caller', () => {
    const { lookup } = attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime
    })

    expect(
      refusalCodeOf(() => laneAuthority(lookup).federatedLinkLane(fingerprintOf(PEER_TOKEN)))
    ).toBe('terminal.lane_link_unbound')
    expect(refusalCodeOf(() => laneAuthority(lookup).federatedLinkLane(undefined))).toBe(
      'terminal.lane_link_unbound'
    )
    // The runtime's shared local-socket identity is not a link and is refused the same way.
    expect(
      refusalCodeOf(() =>
        laneAuthority(lookup).federatedLinkLane(fingerprintOf(RUNTIME_AUTH_TOKEN))
      )
    ).toBe('terminal.lane_link_unbound')
  })

  it("binds a ticked link to its grant's principal", () => {
    const { registry, lookup } = attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime
    })
    const consent = authorizeHostConsent({})
    const person = registry.createPrincipal(consent, 'Ana')
    registry.bindGrant(consent, 'home-peer', person.principalId)
    registry.bindFederatedLink(consent, fingerprintOf(PEER_TOKEN))

    expect(laneAuthority(lookup).federatedLinkLane(fingerprintOf(PEER_TOKEN))).toEqual({
      kind: 'principal',
      principalId: person.principalId
    })
  })

  // §2a: the link tick is its OWN authority. A bound grant is not a bound link.
  it('still refuses an unticked link whose grant IS bound to a principal', () => {
    const { registry, lookup } = attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime
    })
    const consent = authorizeHostConsent({})
    const person = registry.createPrincipal(consent, 'Ana')
    registry.bindGrant(consent, 'home-peer', person.principalId)

    expect(
      refusalCodeOf(() => laneAuthority(lookup).federatedLinkLane(fingerprintOf(PEER_TOKEN)))
    ).toBe('terminal.lane_link_unbound')
    expect(
      refusalCodeOf(() => laneAuthority(lookup).federatedLinkLane(fingerprintOf('some-other')))
    ).toBe('terminal.lane_link_unbound')
  })

  // Negative control AND the mutation-proof anchor: with no lookup the same call answers `shared`
  // — the pre-S9 host — which is precisely why attaching is not optional.
  it('answers shared while nothing is attached, and again after a detach', () => {
    expect(laneAuthority(null).federatedLinkLane(fingerprintOf(PEER_TOKEN))).toEqual({
      kind: 'shared'
    })

    attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime
    })
    detachPrincipalLaneHost(runtime)

    expect(lookups.at(-1)).toBeNull()
    expect(getPrincipalLaneConsentService()).toBeNull()
  })

  // The label is PEER-VISIBLE, so a resolver closed over a registry whose grant source is gone
  // must stop answering rather than keep minting owner names nothing can revoke (§2h).
  it('unsets the row label resolver on detach', () => {
    const labelResolvers: {
      laneAccountLabelOf?: ((principalId: string) => { owner: string } | null) | null
    }[] = []
    const hostRuntime = {
      setPrincipalLaneLookup: (next: PrincipalLookup | null) => lookups.push(next),
      setLaneAccountRowResolvers: (resolvers: {
        laneAccountLabelOf?: ((principalId: string) => { owner: string } | null) | null
      }) => labelResolvers.push(resolvers)
    }
    attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime: hostRuntime
    })
    expect(labelResolvers.at(-1)?.laneAccountLabelOf).toBeTypeOf('function')

    detachPrincipalLaneHost(hostRuntime)

    expect(labelResolvers.at(-1)?.laneAccountLabelOf).toBeNull()
  })

  /**
   * The pre-S9 fallback is conditioned on the host having no lanes, and the persisted binding rows
   * outlive the registry: a start that never attaches one (WebSocket transport disabled, or a
   * pairing-init failure) still rehydrates `{kind:'principal'}` rows, and on THAT host `shared` is
   * the §2a downgrade rather than the only lane.
   */
  it('refuses a federated link on a host that has lane-bound panes but no registry', () => {
    const authority = laneAuthority(null, {
      'tab-a:44444444-4444-4444-8444-444444444444': {
        worktreeId: 'repo-1::/dev/wt',
        principalId: '55555555-5555-4555-8555-555555555555'
      }
    })

    expect(refusalCodeOf(() => authority.federatedLinkLane(fingerprintOf(PEER_TOKEN)))).toBe(
      'terminal.lane_link_unbound'
    )
  })

  // Negative control: a host whose persisted panes are all shared keeps the pre-S9 fallback.
  it('still answers shared when no persisted pane is lane-bound', () => {
    const authority = laneAuthority(null, {
      'tab-a:44444444-4444-4444-8444-444444444444': { worktreeId: 'repo-1::/dev/wt' }
    })

    expect(authority.federatedLinkLane(fingerprintOf(PEER_TOKEN))).toEqual({ kind: 'shared' })
  })
})
