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

    contestPeerLinkBinding(sqlite, linkDeviceId, now, 'incident_smoke_1', 'contested in smoke test')
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('contested')

    revokePeerLinkBinding(sqlite, linkDeviceId, now)
    expect(getPeerLinkBinding(sqlite, linkDeviceId)?.state).toBe('revoked')
    // A revoked binding is no longer routable.
    expect(findRoutableBindingByKeyFingerprint(sqlite, 'peer_key_fp_1')).toBeNull()
  })
})
