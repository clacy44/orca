import { describe, expect, it } from 'vitest'
import {
  isRoutableBindingRow,
  routingClassOf,
  type LinkBindingLivenessRow,
  type LinkBindingLivenessSources
} from './link-binding-liveness'

function row(overrides: Partial<LinkBindingLivenessRow> = {}): LinkBindingLivenessRow {
  return {
    linkDeviceId: 'link_1',
    environmentId: 'env_1',
    boundEndpointId: 'ep_1',
    boundPairingRevision: 1,
    linkCredentialFp: 'link_fp',
    peerCredentialFp: 'peer_fp',
    peerKeyFingerprint: 'peer_key_fp',
    grantClass: 'minted',
    state: 'confirmed',
    revokedAt: null,
    ...overrides
  }
}

function sources(overrides: Partial<LinkBindingLivenessSources> = {}): LinkBindingLivenessSources {
  return {
    isPeerLinkQuarantined: () => false,
    registryLinkCredentialFingerprint: () => 'link_fp',
    resolveEnvironmentEndpoint: () => ({
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      peerCredentialFp: 'peer_fp',
      peerKeyFingerprint: 'peer_key_fp'
    }),
    liveLegacyAttestation: () => false,
    ...overrides
  }
}

describe('isRoutableBindingRow (R15)', () => {
  const now = 1_000_000

  it('a fully matching minted row is routable', () => {
    expect(isRoutableBindingRow(row(), sources(), now)).toBe(true)
  })

  it('rotating the registry token (link_credential_fp mismatch) kills it', () => {
    const s = sources({ registryLinkCredentialFingerprint: () => 'different_fp' })
    expect(isRoutableBindingRow(row(), s, now)).toBe(false)
  })

  it('a null registry fingerprint (device gone / wrong scope) kills it, no throw', () => {
    const s = sources({ registryLinkCredentialFingerprint: () => null })
    expect(() => isRoutableBindingRow(row(), s, now)).not.toThrow()
    expect(isRoutableBindingRow(row(), s, now)).toBe(false)
  })

  it('replacing the environment endpoint credential kills it', () => {
    const s = sources({
      resolveEnvironmentEndpoint: () => ({
        boundEndpointId: 'ep_1',
        boundPairingRevision: 1,
        peerCredentialFp: 'ROTATED',
        peerKeyFingerprint: 'peer_key_fp'
      })
    })
    expect(isRoutableBindingRow(row(), s, now)).toBe(false)
  })

  it('bumping ONLY pairingRevision kills it', () => {
    const s = sources({
      resolveEnvironmentEndpoint: () => ({
        boundEndpointId: 'ep_1',
        boundPairingRevision: 2,
        peerCredentialFp: 'peer_fp',
        peerKeyFingerprint: 'peer_key_fp'
      })
    })
    expect(isRoutableBindingRow(row(), s, now)).toBe(false)
  })

  it('removing the environment kills it, with no throw', () => {
    const s = sources({ resolveEnvironmentEndpoint: () => null })
    expect(() => isRoutableBindingRow(row(), s, now)).not.toThrow()
    expect(isRoutableBindingRow(row(), s, now)).toBe(false)
  })

  it('revoked_at kills it', () => {
    expect(isRoutableBindingRow(row({ revokedAt: 500 }), sources(), now)).toBe(false)
  })

  it("state='contested' kills it", () => {
    expect(isRoutableBindingRow(row({ state: 'contested' }), sources(), now)).toBe(false)
  })

  it('a live quarantine row kills it', () => {
    const s = sources({ isPeerLinkQuarantined: () => true })
    expect(isRoutableBindingRow(row(), s, now)).toBe(false)
  })

  it('a legacy_coalesced row is NOT routable without an attestation', () => {
    const legacyRow = row({ grantClass: 'legacy_coalesced' })
    expect(isRoutableBindingRow(legacyRow, sources(), now)).toBe(false)
  })

  it('an accept_legacy attestation naming this environment+key makes it routable', () => {
    const legacyRow = row({ grantClass: 'legacy_coalesced' })
    const s = sources({ liveLegacyAttestation: () => true })
    expect(isRoutableBindingRow(legacyRow, s, now)).toBe(true)
  })

  it('re-binding to a different environment drops routability again (attestation names the OLD pair)', () => {
    const legacyRow = row({ grantClass: 'legacy_coalesced', environmentId: 'env_new' })
    const s = sources({
      liveLegacyAttestation: (_linkDeviceId, environmentId) => environmentId === 'env_old'
    })
    expect(isRoutableBindingRow(legacyRow, s, now)).toBe(false)
  })

  it('an expired attestation (the caller’s own filter) loses routability', () => {
    const legacyRow = row({ grantClass: 'legacy_coalesced' })
    // Caller (F13 residual) is responsible for the expiry filter — a sources fake that always
    // says "not live" simulates an attestation past its LINK_BINDING_LEGACY_ATTEST_TTL_MS.
    const s = sources({ liveLegacyAttestation: () => false })
    expect(isRoutableBindingRow(legacyRow, s, now)).toBe(false)
  })

  describe('sqliteOnly mode (drops only the two JSON-file-reading clauses)', () => {
    it('a minted row stays routable under sqliteOnly even if the JSON-backed sources would fail', () => {
      const s = sources({
        registryLinkCredentialFingerprint: () => null,
        resolveEnvironmentEndpoint: () => null
      })
      expect(isRoutableBindingRow(row(), s, now, { sqliteOnly: true })).toBe(true)
    })

    it('state/revoked/quarantine/routingClass still apply under sqliteOnly', () => {
      const s = sources({
        registryLinkCredentialFingerprint: () => null,
        resolveEnvironmentEndpoint: () => null
      })
      expect(isRoutableBindingRow(row({ state: 'contested' }), s, now, { sqliteOnly: true })).toBe(
        false
      )
      expect(isRoutableBindingRow(row({ revokedAt: 1 }), s, now, { sqliteOnly: true })).toBe(false)
      const quarantined = sources({
        isPeerLinkQuarantined: () => true,
        registryLinkCredentialFingerprint: () => null,
        resolveEnvironmentEndpoint: () => null
      })
      expect(isRoutableBindingRow(row(), quarantined, now, { sqliteOnly: true })).toBe(false)
      const legacyRow = row({ grantClass: 'legacy_coalesced' })
      expect(isRoutableBindingRow(legacyRow, s, now, { sqliteOnly: true })).toBe(false)
    })
  })
})

describe('routingClassOf (R15.1)', () => {
  it('minted grantClass always wins, without consulting the attestation source', () => {
    let called = false
    const s: Pick<LinkBindingLivenessSources, 'liveLegacyAttestation'> = {
      liveLegacyAttestation: () => {
        called = true
        return false
      }
    }
    expect(routingClassOf(row({ grantClass: 'minted' }), s, 0)).toBe('minted')
    expect(called).toBe(false)
  })

  it('legacy_coalesced resolves to legacy_attested or legacy_unattested from the attestation source', () => {
    const attested: Pick<LinkBindingLivenessSources, 'liveLegacyAttestation'> = {
      liveLegacyAttestation: () => true
    }
    const unattested: Pick<LinkBindingLivenessSources, 'liveLegacyAttestation'> = {
      liveLegacyAttestation: () => false
    }
    const legacyRow = row({ grantClass: 'legacy_coalesced' })
    expect(routingClassOf(legacyRow, attested, 0)).toBe('legacy_attested')
    expect(routingClassOf(legacyRow, unattested, 0)).toBe('legacy_unattested')
  })
})
