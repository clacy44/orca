import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  getPeerLinkBinding,
  listPeerLinkBindings,
  putPeerLinkBinding,
  contestPeerLinkBinding,
  revokePeerLinkBinding,
  findBindingsByEnvironment,
  findRoutableBindingByKeyFingerprint
} from './link-binding-store'

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
    expect(findRoutableBindingByKeyFingerprint(sqlite, 'peer_key_fp_1')).not.toBeNull()

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
    expect(findRoutableBindingByKeyFingerprint(sqlite, 'peer_key_fp_1')).toBeNull()
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

    // The guard (`WHERE state <> 'contested'`) makes a second contest write on the SAME row a
    // no-op — the proof-bearing columns and the original incident id stay immutable to every
    // writer except the host-side contest-resolution verb.
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
