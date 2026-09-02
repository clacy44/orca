import { describe, expect, it } from 'vitest'
import {
  classifyLinkRound,
  collapseCredentialIdenticalCandidates,
  deriveGrantClassAtBind,
  type LinkRoundWinner
} from './link-binding-classify'

function winner(overrides: Partial<LinkRoundWinner> = {}): LinkRoundWinner {
  return {
    environmentId: 'env_a',
    createdAt: 1000,
    boundEndpointId: 'ep_a',
    boundPairingRevision: 1,
    peerCredentialFp: 'cred_a',
    peerKeyFingerprint: 'key_a',
    ...overrides
  }
}

describe('classifyLinkRound (R11 three-way rule)', () => {
  it('no winners, no duplicates -> unpaired', () => {
    expect(classifyLinkRound([], 0)).toEqual({ outcome: 'unpaired' })
  })

  it('no winners, >=1 peer_duplicate -> peer_duplicate (R11.2)', () => {
    expect(classifyLinkRound([], 1)).toEqual({ outcome: 'peer_duplicate' })
    expect(classifyLinkRound([], 3)).toEqual({ outcome: 'peer_duplicate' })
  })

  it('exactly one winner -> bind', () => {
    const w = winner()
    const result = classifyLinkRound([w], 0)
    expect(result).toEqual({ outcome: 'bind', winner: w, detail: null })
  })

  it('two winners, same dstKeyFp, same credential -> duplicate_environment, auto-resolved to newest createdAt', () => {
    const older = winner({ environmentId: 'env_old', createdAt: 100 })
    const newer = winner({ environmentId: 'env_new', createdAt: 200 })
    const result = classifyLinkRound([older, newer], 0)
    expect(result.outcome).toBe('duplicate_environment')
    if (result.outcome === 'duplicate_environment') {
      expect(result.winner.environmentId).toBe('env_new')
    }
  })

  it('two winners, same dstKeyFp, DIFFERENT credential -> multi_grant, auto-resolved to newest', () => {
    const older = winner({ environmentId: 'env_old', createdAt: 100, peerCredentialFp: 'cred_1' })
    const newer = winner({ environmentId: 'env_new', createdAt: 200, peerCredentialFp: 'cred_2' })
    const result = classifyLinkRound([older, newer], 0)
    expect(result.outcome).toBe('multi_grant')
    if (result.outcome === 'multi_grant') {
      expect(result.winner.environmentId).toBe('env_new')
    }
  })

  it('two winners with DIFFERENT dstKeyFp -> contested, no winner named', () => {
    const a = winner({ environmentId: 'env_a', peerKeyFingerprint: 'key_a' })
    const b = winner({ environmentId: 'env_b', peerKeyFingerprint: 'key_b' })
    const result = classifyLinkRound([a, b], 0)
    expect(result.outcome).toBe('contested')
    expect('winner' in result).toBe(false)
  })

  it('R11.1: tie-break is createdAt DESCENDING, then environmentId ASCENDING (immutable keys only)', () => {
    const a = winner({ environmentId: 'env_zzz', createdAt: 500 })
    const b = winner({ environmentId: 'env_aaa', createdAt: 500 })
    const result = classifyLinkRound([a, b], 0)
    expect(result.outcome).toBe('duplicate_environment')
    if (result.outcome === 'duplicate_environment') {
      // same createdAt -> id ascending wins
      expect(result.winner.environmentId).toBe('env_aaa')
    }
  })
})

describe('collapseCredentialIdenticalCandidates (R10-B / v6 M2)', () => {
  it('a single candidate per credential is kept untouched', () => {
    const candidates = [
      { environmentId: 'env_1', createdAt: 10, peerCredentialFp: 'cred_1' },
      { environmentId: 'env_2', createdAt: 20, peerCredentialFp: 'cred_2' }
    ]
    const result = collapseCredentialIdenticalCandidates(candidates)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })

  it('credential-identical candidates collapse to the newest by createdAt; the rest are dropped, naming the survivor', () => {
    const candidates = [
      { environmentId: 'env_old', createdAt: 10, peerCredentialFp: 'cred_x' },
      { environmentId: 'env_new', createdAt: 30, peerCredentialFp: 'cred_x' },
      { environmentId: 'env_mid', createdAt: 20, peerCredentialFp: 'cred_x' }
    ]
    const result = collapseCredentialIdenticalCandidates(candidates)
    expect(result.kept.map((c) => c.environmentId)).toEqual(['env_new'])
    expect(result.dropped).toHaveLength(2)
    expect(result.dropped.every((d) => d.survivorEnvironmentId === 'env_new')).toBe(true)
    expect(result.dropped.map((d) => d.environmentId).sort()).toEqual(['env_mid', 'env_old'])
  })

  it('a different credential (a genuine second grant) is never collapsed — this is what multi_grant sees', () => {
    const candidates = [
      { environmentId: 'env_1', createdAt: 10, peerCredentialFp: 'cred_a' },
      { environmentId: 'env_2', createdAt: 10, peerCredentialFp: 'cred_b' }
    ]
    const result = collapseCredentialIdenticalCandidates(candidates)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })
})

describe('deriveGrantClassAtBind', () => {
  it('reads the mint-time grantClass fact when present', () => {
    expect(deriveGrantClassAtBind({ grantClass: 'minted' })).toBe('minted')
    expect(deriveGrantClassAtBind({ grantClass: 'legacy_coalesced' })).toBe('legacy_coalesced')
  })

  it('falls back to pendingExpiresAt presence only when grantClass is absent (a pre-existing row)', () => {
    expect(deriveGrantClassAtBind({ pendingExpiresAt: 123 })).toBe('minted')
    expect(deriveGrantClassAtBind({})).toBe('legacy_coalesced')
  })

  it('grantClass, when present, is never overridden by pendingExpiresAt (a swept row stays legacy_coalesced)', () => {
    expect(deriveGrantClassAtBind({ grantClass: 'legacy_coalesced', pendingExpiresAt: 123 })).toBe(
      'legacy_coalesced'
    )
  })
})
