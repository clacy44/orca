import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  getPeerLinkBinding,
  listPeerLinkBindings,
  putPeerLinkBinding,
  contestPeerLinkBinding,
  revokePeerLinkBinding,
  unrevokePeerLinkBinding,
  resolvePeerLinkBindingContest,
  findBindingsByEnvironment,
  findBindingCandidateByKeyFingerprint,
  LinkBindingCapError,
  type ContestFirstWinner
} from './link-binding-store'
import { LINK_BINDING_ROWS_CAP } from './link-binding-constants'

// F15/SMOKE: one test per store module that calls EVERY exported statement once against a fresh
// v40 DB — this is the test that would have caught F1 (a prepared statement whose column names
// are only validated when it runs).

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('link-binding-store: smoke (every exported statement runs against a fresh v40 DB)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('calls every exported statement once', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const linkDeviceId = 'link_smoke_1'

    expect(getPeerLinkBinding(sqlite, linkDeviceId)).toBeNull()
    expect(listPeerLinkBindings(sqlite)).toEqual([])

    putPeerLinkBinding(sqlite, {
      linkDeviceId,
      environmentId: 'env_smoke_1',
      boundEndpointId: 'endpoint_smoke_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_1',
      peerCredentialFp: 'peer_fp_1',
      peerKeyFingerprint: 'peer_key_fp_1',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: now,
      lastVerifiedAt: now
    })

    expect(getPeerLinkBinding(sqlite, linkDeviceId)).not.toBeNull()
    expect(listPeerLinkBindings(sqlite)).toHaveLength(1)
    expect(findBindingsByEnvironment(sqlite, 'env_smoke_1')).toHaveLength(1)
    expect(findBindingCandidateByKeyFingerprint(sqlite, 'peer_key_fp_1')).not.toBeNull()

    contestPeerLinkBinding(
      sqlite,
      linkDeviceId,
      now,
      'incident_smoke_1',
      'contested in smoke test',
      {
        environmentId: 'env_smoke_1',
        boundEndpointId: 'endpoint_smoke_1',
        boundPairingRevision: 1,
        linkCredentialFp: 'link_fp_1',
        peerCredentialFp: 'peer_fp_1',
        peerKeyFingerprint: 'peer_key_fp_1',
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1'
      }
    )
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('contested')

    revokePeerLinkBinding(sqlite, linkDeviceId, now)
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('revoked')
    // A revoked binding is no longer routable.
    expect(findBindingCandidateByKeyFingerprint(sqlite, 'peer_key_fp_1')).toBeNull()
  })
})

describe('contestPeerLinkBinding: Ruling 23 Addendum 5(jj) — a contest creates its own row', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('upserts a contested row from the first winner when no incumbent binding exists', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const linkDeviceId = 'link_no_incumbent'

    expect(getPeerLinkBinding(sqlite, linkDeviceId)).toBeNull()

    contestPeerLinkBinding(sqlite, linkDeviceId, 1000, 'incident_no_incumbent', 'contest detail', {
      environmentId: 'env_challenger_1',
      boundEndpointId: 'endpoint_challenger_1',
      boundPairingRevision: 2,
      linkCredentialFp: 'link_fp_2',
      peerCredentialFp: 'peer_fp_2',
      peerKeyFingerprint: 'peer_key_fp_2',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1'
    })

    const row = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(row?.state).toBe('contested')
    expect(row?.contestIncidentId).toBe('incident_no_incumbent')
    expect(row?.detail).toBe('contest detail')
    expect(row?.environmentId).toBe('env_challenger_1')

    // The guard (Ruling 23 Addendum 6(vv): `WHERE state = 'confirmed'`) makes a second contest
    // write on the SAME row a no-op — the proof-bearing columns and the original incident id stay
    // immutable to every writer except the host-side contest-resolution verb.
    contestPeerLinkBinding(
      sqlite,
      linkDeviceId,
      2000,
      'incident_should_not_land',
      'second detail',
      {
        environmentId: 'env_challenger_2',
        boundEndpointId: 'endpoint_challenger_2',
        boundPairingRevision: 3,
        linkCredentialFp: 'link_fp_3',
        peerCredentialFp: 'peer_fp_3',
        peerKeyFingerprint: 'peer_key_fp_3',
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1'
      }
    )
    const unchanged = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(unchanged?.contestIncidentId).toBe('incident_no_incumbent')
    expect(unchanged?.environmentId).toBe('env_challenger_1')
    expect(unchanged?.contestedAt).toBe(1000)
  })
})

describe('C4e: contestPeerLinkBinding under Ruling 23 Addendum 6 (tt)/(vv)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function firstWinner(overrides: Partial<ContestFirstWinner> = {}): ContestFirstWinner {
    return {
      environmentId: 'env_cap_x',
      boundEndpointId: 'endpoint_cap_x',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_cap',
      peerCredentialFp: 'peer_fp_cap',
      peerKeyFingerprint: 'peer_key_fp_cap',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      ...overrides
    }
  }

  // Finding 3/(tt): the contested INSERT respects LINK_BINDING_ROWS_CAP exactly as
  // putPeerLinkBinding's own pre-check does — same refusal code.
  it('refuses a NEW contested row past LINK_BINDING_ROWS_CAP with the same LinkBindingCapError as putPeerLinkBinding', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    for (let i = 0; i < LINK_BINDING_ROWS_CAP; i += 1) {
      putPeerLinkBinding(sqlite, {
        linkDeviceId: `link_cap_fill_${i}`,
        environmentId: `env_cap_fill_${i}`,
        boundEndpointId: `endpoint_cap_fill_${i}`,
        boundPairingRevision: 1,
        linkCredentialFp: `link_fp_cap_${i}`,
        peerCredentialFp: `peer_fp_cap_${i}`,
        peerKeyFingerprint: `peer_key_fp_cap_${i}`,
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1',
        provedAt: 0,
        lastVerifiedAt: 0
      })
    }
    expect(listPeerLinkBindings(sqlite)).toHaveLength(LINK_BINDING_ROWS_CAP)
    let thrown: unknown
    try {
      contestPeerLinkBinding(
        sqlite,
        'link_cap_overflow',
        1000,
        'incident_cap_overflow',
        'contest at cap',
        firstWinner()
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LinkBindingCapError)
    expect((thrown as LinkBindingCapError).code).toBe('link_binding_conflict')
    expect(getPeerLinkBinding(sqlite, 'link_cap_overflow')).toBeNull()
  })

  // Contesting an EXISTING row (an UPDATE, not a growth of the table) must never be refused by
  // the cap, exactly like putPeerLinkBinding's own re-bind path.
  it('never refuses a contest that upserts an EXISTING row, even at the cap', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    putPeerLinkBinding(sqlite, {
      linkDeviceId: 'link_cap_existing',
      environmentId: 'env_cap_existing',
      boundEndpointId: 'endpoint_cap_existing',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_existing',
      peerCredentialFp: 'peer_fp_existing',
      peerKeyFingerprint: 'peer_key_fp_existing',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    for (let i = 0; i < LINK_BINDING_ROWS_CAP - 1; i += 1) {
      putPeerLinkBinding(sqlite, {
        linkDeviceId: `link_cap_fill2_${i}`,
        environmentId: `env_cap_fill2_${i}`,
        boundEndpointId: `endpoint_cap_fill2_${i}`,
        boundPairingRevision: 1,
        linkCredentialFp: `link_fp_cap2_${i}`,
        peerCredentialFp: `peer_fp_cap2_${i}`,
        peerKeyFingerprint: `peer_key_fp_cap2_${i}`,
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1',
        provedAt: 0,
        lastVerifiedAt: 0
      })
    }
    expect(listPeerLinkBindings(sqlite)).toHaveLength(LINK_BINDING_ROWS_CAP)
    expect(() =>
      contestPeerLinkBinding(
        sqlite,
        'link_cap_existing',
        1000,
        'incident_cap_existing',
        'contest existing at cap',
        firstWinner()
      )
    ).not.toThrow()
    expect(getPeerLinkBinding(sqlite, 'link_cap_existing')?.state).toBe('contested')
  })

  // Finding 8/(vv): the upsert guard admits ONLY `state = 'confirmed'` — a revoked row is never
  // flipped to contested in place (the prior `<> 'contested'` guard would have admitted it).
  it('never overwrites a REVOKED row in place — the guard admits only state = confirmed', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const linkDeviceId = 'link_revoked_guard'
    putPeerLinkBinding(sqlite, {
      linkDeviceId,
      environmentId: 'env_revoked_original',
      boundEndpointId: 'endpoint_revoked_original',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_revoked',
      peerCredentialFp: 'peer_fp_revoked',
      peerKeyFingerprint: 'peer_key_fp_revoked',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    revokePeerLinkBinding(sqlite, linkDeviceId, 500)
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('revoked')

    contestPeerLinkBinding(
      sqlite,
      linkDeviceId,
      1000,
      'incident_should_not_land_on_revoked',
      'contest a revoked row',
      firstWinner({ environmentId: 'env_challenger_revoked' })
    )
    const row = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(row?.state).toBe('revoked')
    expect(row?.environmentId).toBe('env_revoked_original')
    expect(row?.contestIncidentId).toBeNull()
  })
})

// Ruling 28(b) (C8a)/protocol F2: `putPeerLinkBinding`'s upsert must never resurrect a revoked
// row — the sticky-revoke invariant applies to EVERY automatic writer, not only the round's own
// candidate-exclusion check.
describe('Ruling 28(b): putPeerLinkBinding never rebinds a revoked row', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('a fresh proof landing mid-round on a revoked link is a no-op', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const linkDeviceId = 'link_revoke_race'
    putPeerLinkBinding(sqlite, {
      linkDeviceId,
      environmentId: 'env_revoke_race_original',
      boundEndpointId: 'endpoint_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_1',
      peerCredentialFp: 'peer_fp_1',
      peerKeyFingerprint: 'peer_key_fp_1',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    revokePeerLinkBinding(sqlite, linkDeviceId, 500)
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.revokedAt).toBe(500)

    // A round that started before the revoke landed reaches its own write AFTER it — the exact
    // race protocol review F2 named live once C7 shipped `linkRevoke`.
    putPeerLinkBinding(sqlite, {
      linkDeviceId,
      environmentId: 'env_revoke_race_challenger',
      boundEndpointId: 'endpoint_2',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_1',
      peerCredentialFp: 'peer_fp_2',
      peerKeyFingerprint: 'peer_key_fp_2',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })

    const row = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(row?.state).toBe('revoked')
    expect(row?.revokedAt).toBe(500)
    expect(row?.environmentId).toBe('env_revoke_race_original')
    expect(row?.peerKeyFingerprint).toBe('peer_key_fp_1')
  })
})

// Ruling 28(a) (C8a): the two new guarded writes — `unrevokePeerLinkBinding` (lifts a sticky
// revoke) and `resolvePeerLinkBindingContest` (clears an existing contest).
describe('Ruling 28(a): unrevokePeerLinkBinding and resolvePeerLinkBindingContest', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('unrevokePeerLinkBinding clears revoked_at and reports true only when the row was revoked', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const linkDeviceId = 'link_unrevoke'
    putPeerLinkBinding(sqlite, {
      linkDeviceId,
      environmentId: 'env_unrevoke',
      boundEndpointId: 'endpoint_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_1',
      peerCredentialFp: 'peer_fp_1',
      peerKeyFingerprint: 'peer_key_fp_1',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    expect(unrevokePeerLinkBinding(sqlite, linkDeviceId, 100)).toBe(false)
    revokePeerLinkBinding(sqlite, linkDeviceId, 200)
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('revoked')
    expect(unrevokePeerLinkBinding(sqlite, linkDeviceId, 300)).toBe(true)
    const row = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(row?.state).toBe('confirmed')
    expect(row?.revokedAt).toBeNull()
  })

  it('resolvePeerLinkBindingContest clears an existing contest on a clean single winner, and is a no-op on a confirmed row', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const linkDeviceId = 'link_resolve_contest'
    contestPeerLinkBinding(sqlite, linkDeviceId, 100, 'incident_resolve', 'two winners', {
      environmentId: 'env_a',
      boundEndpointId: 'endpoint_a',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_a',
      peerCredentialFp: 'peer_fp_a',
      peerKeyFingerprint: 'peer_key_fp_a',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1'
    })
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('contested')

    resolvePeerLinkBindingContest(sqlite, {
      linkDeviceId,
      environmentId: 'env_b',
      boundEndpointId: 'endpoint_b',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_b',
      peerCredentialFp: 'peer_fp_b',
      peerKeyFingerprint: 'peer_key_fp_b',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 500,
      lastVerifiedAt: 500
    })
    const resolved = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(resolved?.state).toBe('confirmed')
    expect(resolved?.contestIncidentId).toBeNull()
    expect(resolved?.contestedAt).toBeNull()
    expect(resolved?.environmentId).toBe('env_b')
    expect(resolved?.peerKeyFingerprint).toBe('peer_key_fp_b')

    // Ruling 28(a): a merely-confirmed row is untouched by this statement — the ordinary path
    // stays `putPeerLinkBinding`.
    resolvePeerLinkBindingContest(sqlite, {
      linkDeviceId,
      environmentId: 'env_c',
      boundEndpointId: 'endpoint_c',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_c',
      peerCredentialFp: 'peer_fp_c',
      peerKeyFingerprint: 'peer_key_fp_c',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 900,
      lastVerifiedAt: 900
    })
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.environmentId).toBe('env_b')
  })

  // Ruling 28 Addendum 1(r)/D3: a revoke never strands a contest — unrevoking a row that is
  // ALSO contested must not downgrade it to 'confirmed'; only `resolvePeerLinkBindingContest`
  // clears contested_at/contest_incident_id.
  it('revoke -> link-bind on a contested link keeps it contested with the incident id', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const linkDeviceId = 'link_revoke_contested'
    contestPeerLinkBinding(sqlite, linkDeviceId, 100, 'incident_revoke_contested', 'two winners', {
      environmentId: 'env_a',
      boundEndpointId: 'endpoint_a',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_a',
      peerCredentialFp: 'peer_fp_a',
      peerKeyFingerprint: 'peer_key_fp_a',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1'
    })
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('contested')

    // revokePeerLinkBinding on a contested row keeps the contest columns intact.
    revokePeerLinkBinding(sqlite, linkDeviceId, 200)
    const revoked = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(revoked?.state).toBe('revoked')
    expect(revoked?.revokedAt).toBe(200)
    expect(revoked?.contestIncidentId).toBe('incident_revoke_contested')
    expect(revoked?.contestedAt).not.toBeNull()

    // linkBind's own unrevoke step: must NOT downgrade a still-contested row to 'confirmed'.
    expect(unrevokePeerLinkBinding(sqlite, linkDeviceId, 300)).toBe(true)
    const lifted = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(lifted?.state).toBe('contested')
    expect(lifted?.revokedAt).toBeNull()
    expect(lifted?.contestIncidentId).toBe('incident_revoke_contested')
    expect(lifted?.contestedAt).not.toBeNull()

    // Only resolvePeerLinkBindingContest clears the contest — and D-8: it never touches
    // revoked_at (already NULL here, from the unrevoke above).
    resolvePeerLinkBindingContest(sqlite, {
      linkDeviceId,
      environmentId: 'env_b',
      boundEndpointId: 'endpoint_b',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_b',
      peerCredentialFp: 'peer_fp_b',
      peerKeyFingerprint: 'peer_key_fp_b',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 400,
      lastVerifiedAt: 400
    })
    const resolved = getPeerLinkBinding(sqlite, linkDeviceId)
    expect(resolved?.state).toBe('confirmed')
    expect(resolved?.contestIncidentId).toBeNull()
    expect(resolved?.contestedAt).toBeNull()
    expect(resolved?.revokedAt).toBeNull()
  })
})
