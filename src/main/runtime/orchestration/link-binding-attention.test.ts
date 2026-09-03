// S10-16 C6/C6a, R21.1/R21.6/R19.5 (Ruling 21 Protocol B2; Ruling 26 Addendum 2(z)/3(gg);
// Ruling 27 — C6 fix-up), test 79's C6 slice: `describeLinkBindingHealth`/
// `describeLinkBindingAttention` against a real OrchestrationDb fixture.
//
// `runtime.linkBindingSelfView` is set to a WORKING stub (`registryLoadSucceeded: () => true`,
// `registryCredentialFingerprint: () => null`) rather than left null: Ruling 27(f)/F6 makes
// `describeLinkBindingHealth` raise `unavailable(local_evidence)` whenever local evidence is
// unavailable, and a null `linkBindingSelfView` IS local evidence being unavailable — leaving it
// null (as C6 did) would make every fixture in this file read `unavailable`, since that word
// outranks `stale`/`legacy_unattested`/`proven`/`pending` in A4-02. The stub still returns null
// from `registryCredentialFingerprint`, so `getRoutableLinkBinding` still refuses on credential
// mismatch before it ever touches a real registry/environment-store file — `routes` is still
// deterministically false without any disk I/O or electron mock, which is exactly what
// distinguishes `stale` from `legacy_unattested`. The dedicated `unavailable(local_evidence)`
// test below is the one place `linkBindingSelfView` is left null on purpose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { describeLinkBindingHealth, describeLinkBindingAttention } from './link-binding-attention'
import * as linkBindingRoutable from './link-binding-routable'
import {
  LINK_BINDING_REVERIFY_MS,
  LINK_BINDING_ATTEST_WARN_MS,
  LINK_BINDING_STATES,
  LINK_BINDING_LAST_OUTCOMES
} from './link-binding-constants'
import { LINK_BINDING_HEALTH_PRECEDENCE } from '../../../shared/link-binding-health'
import type { LinkBindingSelfView } from '../device-registry-link-credential'

function workingSelfView(): LinkBindingSelfView {
  return {
    registryCredentialFingerprint: () => null,
    ownKeyFingerprint: () => null,
    macWithRegistryToken: () => null,
    listRuntimeLinkCandidates: () => [],
    listRuntimeScopeDeviceIds: () => [],
    registryLoadSucceeded: () => true
  }
}

describe('describeLinkBindingHealth / describeLinkBindingAttention', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    // Ruling 28(m): a WORKING transport, matching workingSelfView's role for local evidence —
    // `hasOrchestrationEnvironmentTransport()`/`hasLinkBindingProver()` now gate a real
    // `unavailable(transport)`/`unavailable(prover)` candidate on evidence the wiring was
    // expected (a binding row or a queued reply on the link); every fixture below that puts a
    // binding row down would otherwise trip that candidate purely because this constructed
    // runtime never wires either, masking the word under test the same way the C7 attempt's
    // unconditional check did (the 8-test regression Ruling 28(m)'s comment names). The dedicated
    // `unavailable(transport)`/`unavailable(prover)` tests below construct a runtime WITHOUT one
    // of these on purpose.
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {} as never
    })
    runtime.setOrchestrationDb(db)
    runtime.linkBindingSelfView = workingSelfView()
    runtime.getLinkBindingProver()
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
    expect(describeLinkBindingHealth(db, runtime, 'link_ghost').word).toBe('pending')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_a').word).toBe('quarantined')
  })

  it('a revoked binding (state) reads revoked', () => {
    db.putPeerLinkBinding(boundRow('link_b', 'env_1'))
    db.revokePeerLinkBinding('link_b', Date.now())
    expect(describeLinkBindingHealth(db, runtime, 'link_b').word).toBe('revoked')
  })

  // F7/Ruling 27(e): `revoked_at` is the load-bearing half of the mark — a row revoked through
  // the CHECK-rejection catch branch stamps `revoked_at` alone. Simulate that directly.
  it('a binding with revoked_at stamped but state NOT revoked (the fail-closed repair fallback) still reads revoked', () => {
    db.putPeerLinkBinding(boundRow('link_b2', 'env_1'))
    const raw = (
      db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }
    ).db
    raw
      .prepare(
        `UPDATE peer_link_bindings SET revoked_at = ? WHERE link_device_id = ? AND state != 'revoked'`
      )
      .run(Date.now(), 'link_b2')
    expect(describeLinkBindingHealth(db, runtime, 'link_b2').word).toBe('revoked')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_c').word).toBe('contested')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_d').word).toBe('parked')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_e').word).toBe('misroute_suspected')

    // Same row, but the advisory is now older than LINK_BINDING_REVERIFY_MS — no system-time
    // mutation needed, since describeLinkBindingHealth reads Date.now() itself.
    db.putLinkAdvisory(
      'link_e',
      { kind: 'authorship_unconfirmed' },
      Date.now() - LINK_BINDING_REVERIFY_MS - 1000
    )
    expect(describeLinkBindingHealth(db, runtime, 'link_e').word).not.toBe('misroute_suspected')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_f').word).toBe('peer_reports_contest')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_g').word).toBe(outcome)
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
    expect(describeLinkBindingHealth(db, runtime, 'link_h').word).toBe('unavailable')
  })

  // F6/Ruling 27(f): a LIVE wiring fact — no self-view armed — reads `unavailable` with reason
  // `local_evidence`, independent of any stored attempt outcome.
  it('a null linkBindingSelfView reads unavailable with reason local_evidence, even for an otherwise-pending link', () => {
    runtime.linkBindingSelfView = null
    const result = describeLinkBindingHealth(db, runtime, 'link_h2')
    expect(result.word).toBe('unavailable')
    expect(result.reason).toBe('local_evidence')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_i').word).toBe('peer_no_environments')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_j').word).toBe('legacy_unattested')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_k').word).toBe('stale')
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
    expect(describeLinkBindingHealth(db, runtime, 'link_l').word).toBe('unreachable')
  })

  // Ruling 27 Addendum 1(k)/C6a-4: totality of describeLinkBindingHealth (the DB-reading half)
  // over every stored peer_link_bindings.state x peer_link_attempts.last_outcome combination —
  // distinct from link-binding-health.test.ts's TOTALITY block, which only exercises the pure,
  // DB-free half (worstLinkBindingHealth) and never calls describeLinkBindingHealth itself. No
  // combination may throw or resolve to a word outside LINK_BINDING_HEALTH_PRECEDENCE.
  describe('describeLinkBindingHealth: totality over every stored state/outcome combination', () => {
    const combos = LINK_BINDING_STATES.flatMap((state) =>
      LINK_BINDING_LAST_OUTCOMES.map((outcome) => [state, outcome] as const)
    )

    it.each(combos)(
      'peer_link_bindings.state=%s x peer_link_attempts.last_outcome=%s never throws and yields a member of the precedence list',
      (state, outcome) => {
        const linkDeviceId = `link_totality_${state}_${outcome}`
        if (state === 'confirmed') {
          db.putPeerLinkBinding(boundRow(linkDeviceId, 'env_totality'))
        } else if (state === 'contested') {
          db.contestPeerLinkBinding(linkDeviceId, Date.now(), 'incident_totality', 'detail', {
            environmentId: 'env_totality',
            boundEndpointId: 'ep_1',
            boundPairingRevision: 1,
            linkCredentialFp: 'fp_link',
            peerCredentialFp: 'fp_peer',
            peerKeyFingerprint: 'fp_key',
            grantClass: 'minted',
            scanCompleteness: 'complete',
            proofProtocol: 'p1'
          })
        } else {
          db.putPeerLinkBinding(boundRow(linkDeviceId, 'env_totality'))
          db.revokePeerLinkBinding(linkDeviceId, Date.now())
        }
        db.putBindingAttempt(linkDeviceId)
        db.settleBindingAttempt(linkDeviceId, {
          lastAttemptAt: Date.now(),
          lastRoundAt: Date.now(),
          lastOutcome: outcome,
          lastDetail: null,
          consecutiveFailures: 0,
          consecutiveNoWinner: 0,
          nextAttemptAfter: null
        })

        let result: ReturnType<typeof describeLinkBindingHealth> | undefined
        expect(() => {
          result = describeLinkBindingHealth(db, runtime, linkDeviceId)
        }).not.toThrow()
        expect(result).toBeDefined()
        expect(result?.word).toBeDefined()
        expect(LINK_BINDING_HEALTH_PRECEDENCE).toContain(result?.word)
      }
    )
  })
})

describe('describeLinkBindingAttention', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    // Ruling 28(m): same working-transport/prover wiring as the other describe block's
    // beforeEach — see its comment. Both accessors must read true here so a binding row (which
    // most fixtures below construct) does not trip a spurious unavailable(transport)/(prover)
    // candidate that masks the word actually under test.
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {} as never
    })
    runtime.setOrchestrationDb(db)
    runtime.linkBindingSelfView = workingSelfView()
    runtime.getLinkBindingProver()
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

  // F5/Ruling 27(a): misroute_suspected IS in the attention set (Ruling 23 ADDENDUM (k)
  // AFFIRMED) and outranks peer_reports_contest in A4-02, so it is now the winning word — the
  // opposite of what this test asserted pre-C6a.
  it('with link A misroute_suspected and link B peer_reports_contest, per-word counts both and names misroute_suspected as the worst', () => {
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
    expect(line).toContain('1 misroute suspected')
    expect(line).toContain('1 peer reports contest')
    // P-11(b): a peer-sourced word renders through R21.4's claim shape.
    expect(line).toContain('claim supplied by the remote host')
  })

  // F9/Ruling 27(g): the count is PER WORD, never merged under the worst word alone — two links
  // needing attention, one quarantined and one contested, must never render as "2 quarantined".
  it('quarantined and contested links render distinct per-word counts, never a merged count', () => {
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
    expect(line).not.toContain('2 quarantined')
    expect(line).toContain('1 quarantined')
    expect(line).toContain('1 contested')
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
    // F1/Ruling 27(a): `stale` is now an attention-set word (the reply-relay half of this fix),
    // so a `proven`-outcome attempt whose live legacy attestation moves routingClassOf off
    // `legacy_unattested` would ALSO trigger attention via the health word `stale`, defeating
    // this test's own premise ("even with no attention-set health word"). Deliberately no
    // binding attempt is settled here — no attempt row means the health word is `pending`,
    // which is NOT in the attention set, isolating the attestation trigger.
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
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).toContain('attestation expiring')
  })

  it('an accept_legacy attestation already past expiry reads attestation expired', () => {
    const boundRow = {
      linkDeviceId: 'link_leg2',
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
    const now = Date.now()
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link_leg2',
      action: 'accept_legacy',
      reasonCode: null,
      reasonText: 'test',
      detail: JSON.stringify({ environmentId: 'env_1', peerKeyFingerprint: 'fp_key' }),
      createdAt: now - 1000,
      expiresAt: now - 1
    })
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).toContain('attestation expired')
  })

  // Ruling 27(a): "one test per word proves the line appears" — the F1 half (the reply-relay
  // words unreachable/unsupported/stale, Ruling 26 Addendum 2(z)/3(gg)) plus revoked/unavailable
  // (standing Ruling 23(c) membership) at the ATTENTION LINE level, not just the health level.
  it('a reply-relay row past the unreachable failure threshold reaches the attention line (F1)', () => {
    db.putPeerLinkBinding({
      linkDeviceId: 'link_relay_unreachable',
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    db.enqueueReplyOutbox({
      localMessageId: 'msg_relay_1',
      linkDeviceId: 'link_relay_unreachable',
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
      .run('link_relay_unreachable')
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()
    expect(line).toContain('unreachable')
  })

  it('a reply-relay row abandoned with stale_environment_pairing reaches the attention line as stale (F1/F4)', () => {
    db.putPeerLinkBinding({
      linkDeviceId: 'link_relay_stale',
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    db.enqueueReplyOutbox({
      localMessageId: 'msg_relay_2',
      linkDeviceId: 'link_relay_stale',
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
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'abandoned', last_error_code = 'stale_environment_pairing' WHERE link_device_id = ?`
      )
      .run('link_relay_stale')
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()
    expect(line).toContain('1 stale')
  })

  it('a reply-relay row abandoned with capability_unsupported reaches the attention line as unsupported (F1)', () => {
    db.putPeerLinkBinding({
      linkDeviceId: 'link_relay_unsupported',
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    db.enqueueReplyOutbox({
      localMessageId: 'msg_relay_3',
      linkDeviceId: 'link_relay_unsupported',
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
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'abandoned', last_error_code = 'capability_unsupported' WHERE link_device_id = ?`
      )
      .run('link_relay_unsupported')
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()
    expect(line).toContain('1 unsupported')
  })

  it('a revoked binding reaches the attention line (standing Ruling 23(c) membership)', () => {
    db.putPeerLinkBinding({
      linkDeviceId: 'link_revoked_att',
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    db.revokePeerLinkBinding('link_revoked_att', Date.now())
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()
    expect(line).toContain('1 revoked')
  })

  it('a null linkBindingSelfView reaches the attention line as unavailable(local_evidence) (F6)', () => {
    runtime.linkBindingSelfView = null
    db.putBindingAttempt('link_unavail_att')
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()
    expect(line).toContain('unavailable(local_evidence)')
  })

  // F3's throw-safety is exercised at the RPC layer (orchestration-check-link-attention.test.ts);
  // this file only proves the pure read side stays well-formed on a healthy host.

  // F8/Ruling 27(g)/test 79: for each of Protocol B2's five binding-side codes (contest,
  // unavailable, peer_reports_contest, attestation-expired, attestation-expiring), the DB state
  // that raises it reaches the check attention line WITHOUT any mailbox write —
  // `describeLinkBindingHealth`/`describeLinkBindingAttention` are read-only over `db` (verified
  // by construction: neither function is ever passed anything that could write, and `messages`
  // count is asserted unchanged here). DECLARED RESIDUAL: this does not drive the codes through
  // their real PRODUCING path (createTables()'s v40 repair for `unavailable`, contestPeerLinkBinding
  // for `contest`, the attestation clock for the two expiry codes) — those live outside C6a's file
  // scope (link-binding-attention.ts/link-binding-health.ts/reply-outbox-health.ts/
  // peer-supplied-text.ts/orchestration-check-output.ts/the RPC wrap site/reply-outbox store
  // accessors). Whether those producing paths themselves write an `agent_audit` row is unverified
  // here and carried forward for the whole-slice review, per the C6a commit body.
  it.each([
    'contest',
    'unavailable',
    'peer_reports_contest',
    'attestation_expired',
    'attestation_expiring'
  ] as const)('%s reaches the attention line with zero new messages rows', (code) => {
    const raw = (
      db as unknown as {
        db: {
          prepare: (sql: string) => { get: () => { n: number }; run: (...a: unknown[]) => unknown }
        }
      }
    ).db
    const messagesBefore = raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n

    if (code === 'contest') {
      db.contestPeerLinkBinding('link_code_contest', Date.now(), 'incident_1', 'detail', {
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
    } else if (code === 'unavailable') {
      db.putBindingAttempt('link_code_unavailable')
      db.settleBindingAttempt('link_code_unavailable', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'unavailable',
        lastDetail: 'local_evidence_unavailable',
        consecutiveFailures: 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: null
      })
    } else if (code === 'peer_reports_contest') {
      db.putBindingAttempt('link_code_prc')
      db.settleBindingAttempt('link_code_prc', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'proven',
        lastDetail: null,
        consecutiveFailures: 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: null
      })
      db.putLinkAdvisory('link_code_prc', { kind: 'peer_reports_contest' }, Date.now())
    } else {
      const linkId = code === 'attestation_expired' ? 'link_code_att_exp' : 'link_code_att_soon'
      db.putPeerLinkBinding({
        linkDeviceId: linkId,
        environmentId: 'env_1',
        boundEndpointId: 'ep_1',
        boundPairingRevision: 1,
        linkCredentialFp: 'fp_link',
        peerCredentialFp: 'fp_peer',
        peerKeyFingerprint: 'fp_key',
        grantClass: 'legacy_coalesced',
        scanCompleteness: 'complete',
        proofProtocol: 'p1',
        provedAt: Date.now(),
        lastVerifiedAt: Date.now()
      })
      const now = Date.now()
      db.putContainment({
        subjectKind: 'link',
        subjectId: linkId,
        action: 'accept_legacy',
        reasonCode: null,
        reasonText: 'test',
        detail: JSON.stringify({ environmentId: 'env_1', peerKeyFingerprint: 'fp_key' }),
        createdAt: now - 1000,
        expiresAt:
          code === 'attestation_expired' ? now - 1 : now + LINK_BINDING_ATTEST_WARN_MS - 1000
      })
    }

    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()

    const messagesAfter = raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    expect(messagesAfter).toBe(messagesBefore)
  })

  // Ruling 27 Addendum 1(k)/C6a-5: `parked` is a Ruling 21 B2 original attention-set member with
  // the longest standing claim to the line, but until now was tested only at the health level
  // (describeLinkBindingHealth(...).word === 'parked', first describe block) — never driven
  // through describeLinkBindingAttention.
  it('unpaired_parked renders "1 parked" on the line', () => {
    db.putBindingAttempt('link_parked')
    db.settleBindingAttempt('link_parked', {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'unpaired_parked',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 3,
      nextAttemptAfter: null
    })
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).toContain('1 parked')
  })

  // Ruling 27(b)'s last sentence/C6a-1: "A test asserts the environment file is read once
  // regardless of link count." Spies the store read itself (readEnvironmentSnapshot, hoisted at
  // link-binding-attention.ts:293) rather than the mechanism (default-parameter threading) — a
  // later call site that omits the fifth argument and reintroduces per-link reads fails THIS
  // test even though the threading itself still type-checks.
  // ML-3/F14: settled `proven` (not quarantine-only) so `describeLinkBindingHealth`'s `case
  // 'proven'` arm actually runs `getRoutableLinkBinding` (the only call site) — a quarantine-only
  // fixture never reaches it (the `switch(undefined)` -> 'pending' arm short-circuits first). No
  // binding row exists for these three links, so `routes` is false and the `else` (no binding)
  // branch settles each to 'stale', which IS an attention-set word.
  it('reads the environment store exactly once per check call, regardless of link count', () => {
    const spy = vi.spyOn(linkBindingRoutable, 'readEnvironmentSnapshot')
    try {
      for (const linkDeviceId of ['link_ro_a', 'link_ro_b', 'link_ro_c']) {
        db.putBindingAttempt(linkDeviceId)
        db.settleBindingAttempt(linkDeviceId, {
          lastAttemptAt: Date.now(),
          lastRoundAt: Date.now(),
          lastOutcome: 'proven',
          lastDetail: null,
          consecutiveFailures: 0,
          consecutiveNoWinner: 0,
          nextAttemptAfter: null
        })
      }
      const line = describeLinkBindingAttention(db, runtime)
      expect(line).toContain('3 stale')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  // Ruling 27 Addendum 1(l)/C6a-6: resolveEnvironmentName strips \r/\n before the clamp, closing
  // F13 by construction. The name grammar (runtime-environment-name.ts) never lets this arise
  // through a real write path, so the fixture constructs the newline directly, per the brief.
  it('an environment name containing a newline is stripped before it reaches the line', () => {
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(
      (selector: string) => ({ name: `evil\nname\r\nfor:${selector}`, id: selector }) as never
    )
    db.putPeerLinkBinding({
      linkDeviceId: 'link_nl',
      environmentId: 'env_nl',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link_nl',
      action: 'quarantine',
      reasonCode: 'test',
      reasonText: 'test',
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })
    const line = describeLinkBindingAttention(db, runtime)
    expect(line).not.toBeNull()
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).toContain('evil name for:env_nl')
  })
})
