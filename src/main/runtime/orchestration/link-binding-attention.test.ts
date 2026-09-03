// S10-16 C6, R21.1/R21.6/R19.5 (Ruling 21 Protocol B2; Ruling 26 Addendum 2(z)/3(gg)), test 79's
// C6 slice: `describeLinkBindingHealth`/`describeLinkBindingAttention` against a real
// OrchestrationDb fixture. `runtime.linkBindingSelfView` is left null (its default), so
// `getRoutableLinkBinding` refuses `registryLinkCredentialFingerprint` before it ever touches a
// real registry/environment-store file — `routes` is deterministically false without any disk
// I/O or electron mock, which is exactly what distinguishes `stale` from `legacy_unattested`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { describeLinkBindingHealth, describeLinkBindingAttention } from './link-binding-attention'
import { LINK_BINDING_REVERIFY_MS, LINK_BINDING_ATTEST_WARN_MS } from './link-binding-constants'

describe('describeLinkBindingHealth / describeLinkBindingAttention', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(
      (selector: string) => ({ name: `env:${selector}`, id: selector }) as never
    )
  })

  afterEach(() => {
    db.close()
  })

  const boundRow = (linkDeviceId: string, environmentId: string) => ({
    linkDeviceId,
    environmentId,
    boundEndpointId: 'ep_1',
    boundPairingRevision: 1,
    linkCredentialFp: 'fp_link',
    peerCredentialFp: 'fp_peer',
    peerKeyFingerprint: 'fp_key',
    grantClass: 'minted' as const,
    scanCompleteness: 'complete' as const,
    proofProtocol: 'p1',
    provedAt: Date.now(),
    lastVerifiedAt: Date.now()
  })

  it('an unknown link (no rows anywhere) reads pending', () => {
    expect(describeLinkBindingHealth(db, runtime, 'link_ghost')).toBe('pending')
  })

  it('a live quarantine outranks every other signal', () => {
    db.putBindingAttempt('link_a')
    db.settleBindingAttempt('link_a', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link_a',
      action: 'quarantine',
      reasonCode: 'test',
      reasonText: 'test',
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_a')).toBe('quarantined')
  })

  it('a revoked binding reads revoked', () => {
    db.putPeerLinkBinding(boundRow('link_b', 'env_1'))
    db.revokePeerLinkBinding('link_b', Date.now())
    expect(describeLinkBindingHealth(db, runtime, 'link_b')).toBe('revoked')
  })

  it('a contested binding reads contested', () => {
    db.contestPeerLinkBinding('link_c', Date.now(), 'incident_1', 'detail', {
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1'
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_c')).toBe('contested')
  })

  it('unpaired_parked reads parked', () => {
    db.putBindingAttempt('link_d')
    db.settleBindingAttempt('link_d', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'unpaired_parked',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 3,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_d')).toBe('parked')
  })

  it('a fresh authorship_unconfirmed advisory reads misroute_suspected, and clears past REVERIFY_MS', () => {
    db.putBindingAttempt('link_e')
    db.settleBindingAttempt('link_e', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    db.putLinkAdvisory('link_e', { kind: 'authorship_unconfirmed' }, Date.now())
    expect(describeLinkBindingHealth(db, runtime, 'link_e')).toBe('misroute_suspected')

    // Same row, but the advisory is now older than LINK_BINDING_REVERIFY_MS — no system-time
    // mutation needed, since describeLinkBindingHealth reads Date.now() itself.
    db.putLinkAdvisory(
      'link_e',
      { kind: 'authorship_unconfirmed' },
      Date.now() - LINK_BINDING_REVERIFY_MS - 1000
    )
    expect(describeLinkBindingHealth(db, runtime, 'link_e')).not.toBe('misroute_suspected')
  })

  it('a fresh peer_reports_contest advisory reads peer_reports_contest', () => {
    db.putBindingAttempt('link_f')
    db.settleBindingAttempt('link_f', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    db.putLinkAdvisory('link_f', { kind: 'peer_reports_contest' }, Date.now())
    expect(describeLinkBindingHealth(db, runtime, 'link_f')).toBe('peer_reports_contest')
  })

  it.each([
    'peer_duplicate',
    'duplicate_environment',
    'multi_grant',
    'unreachable',
    'unsupported',
    'unpaired'
  ] as const)('lastOutcome %s reads the same word', (outcome) => {
    db.putBindingAttempt('link_g')
    db.settleBindingAttempt('link_g', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: outcome,
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_g')).toBe(outcome)
  })

  it('unavailable with local_evidence_unavailable detail reads unavailable', () => {
    db.putBindingAttempt('link_h')
    db.settleBindingAttempt('link_h', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'unavailable',
      lastDetail: 'local_evidence_unavailable',
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_h')).toBe('unavailable')
  })

  it('unavailable with a link_store_empty detail reads peer_no_environments (A4-01 promotes it above unavailable)', () => {
    db.putBindingAttempt('link_i')
    db.settleBindingAttempt('link_i', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'unavailable',
      lastDetail: 'link_store_empty',
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_i')).toBe('peer_no_environments')
  })

  it('proven with a legacy_coalesced grant and no attestation reads legacy_unattested', () => {
    db.putPeerLinkBinding({ ...boundRow('link_j', 'env_1'), grantClass: 'legacy_coalesced' })
    db.putBindingAttempt('link_j')
    db.settleBindingAttempt('link_j', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_j')).toBe('legacy_unattested')
  })

  it('proven with a minted grant that fails the live route check reads stale', () => {
    db.putPeerLinkBinding(boundRow('link_k', 'env_1'))
    db.putBindingAttempt('link_k')
    db.settleBindingAttempt('link_k', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingHealth(db, runtime, 'link_k')).toBe('stale')
  })

  it('a reply-relay row past the unreachable failure threshold contributes unreachable', () => {
    db.putPeerLinkBinding(boundRow('link_l', 'env_1'))
    db.enqueueReplyOutbox({
      localMessageId: 'msg_1',
      linkDeviceId: 'link_l',
      environmentId: 'env_1',
      boundPairingRevision: 1,
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      inReplyToMessageId: 'msg_0',
      peerAgentId: 'agt_peer',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: Date.now()
    })
    const raw = (
      db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }
    ).db
    raw
      .prepare(`UPDATE peer_reply_outbox SET consecutive_failures = 7 WHERE link_device_id = ?`)
      .run('link_l')
    expect(describeLinkBindingHealth(db, runtime, 'link_l')).toBe('unreachable')
  })
})

describe('describeLinkBindingAttention', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(
      (selector: string) => ({ name: `desktop`, id: selector }) as never
    )
  })

  afterEach(() => {
    db.close()
  })

  it('returns null on a host with no attention-worthy link', () => {
    db.putBindingAttempt('link_healthy')
    db.settleBindingAttempt('link_healthy', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'pending',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(describeLinkBindingAttention(db, runtime)).toBeNull()
  })

  it('P-11(a): with link A misroute_suspected and link B peer_reports_contest, names peer_reports_contest and counts one', () => {
    db.putBindingAttempt('link_a')
    db.settleBindingAttempt('link_a', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    db.putLinkAdvisory('link_a', { kind: 'authorship_unconfirmed' }, Date.now())

    db.putBindingAttempt('link_b')
    db.settleBindingAttempt('link_b', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    db.putLinkAdvisory('link_b', { kind: 'peer_reports_contest' }, Date.now())

    const line = describeLinkBindingAttention(db, runtime)
    expect(line).toContain('peer reports contest')
    expect(line).toContain('1 ')
    // P-11(b): a peer-sourced word renders through R21.4's claim shape.
    expect(line).toContain('claim supplied by the remote host')
  })

  it('quarantined outranks everything else and names the count of attention links', () => {
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link_q',
      action: 'quarantine',
      reasonCode: 'test',
      reasonText: 'test',
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })
    db.contestPeerLinkBinding('link_c', Date.now(), 'incident_1', 'detail', {
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1'
    })
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).toContain('2 quarantined')
  })

  it('a live accept_legacy attestation inside the warn window triggers attention even with no attention-set health word', () => {
    const boundRow = {
      linkDeviceId: 'link_leg',
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'legacy_coalesced' as const,
      scanCompleteness: 'complete' as const,
      proofProtocol: 'p1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    }
    db.putPeerLinkBinding(boundRow)
    db.putBindingAttempt('link_leg')
    db.settleBindingAttempt('link_leg', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    const now = Date.now()
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link_leg',
      action: 'accept_legacy',
      reasonCode: null,
      reasonText: 'test',
      detail: JSON.stringify({ environmentId: 'env_1', peerKeyFingerprint: 'fp_key' }),
      createdAt: now,
      expiresAt: now + LINK_BINDING_ATTEST_WARN_MS - 1000
    })
    // Health alone reads legacy_unattested (unattested — the containment above is what makes it
    // legacy_attested, but the underlying health word this test cares about not being in the
    // attention set is unaffected either way): confirm attention still fires.
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).toContain('attestation expiring')
  })
})
