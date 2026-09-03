import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  getScanFact,
  listScanFacts,
  putScanFact,
  listConfirmObservations,
  putConfirmObservation,
  getContainment,
  listContainment,
  isPeerLinkQuarantined,
  putContainment,
  liftContainment,
  deleteBindingsAndAttemptsNotIn
} from './link-binding-observations-store'
import { putPeerLinkBinding } from './link-binding-store'
import { putBindingAttempt } from './link-binding-attempts-store'

// F15/SMOKE: one test per store module that calls EVERY exported statement once against a fresh
// v40 DB — this is the test that would have caught F1 (a prepared statement whose column names
// are only validated when it runs).

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('link-binding-observations-store: smoke (every exported statement runs against a fresh v40 DB)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('calls every exported statement once', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const linkDeviceId = 'link_smoke_3'
    const environmentId = 'env_smoke_3'

    // --- peer_link_scan_facts ---
    expect(getScanFact(sqlite, linkDeviceId, environmentId)).toBeNull()
    expect(listScanFacts(sqlite, linkDeviceId)).toEqual([])
    putScanFact(sqlite, {
      linkDeviceId,
      environmentId,
      outcome: 'proven',
      environmentPairingRevision: 1,
      linkCredentialFp: 'link_fp_3',
      detail: null,
      observedAt: now
    })
    expect(getScanFact(sqlite, linkDeviceId, environmentId)).not.toBeNull()
    expect(listScanFacts(sqlite, linkDeviceId)).toHaveLength(1)

    // --- peer_link_confirm_observations ---
    expect(listConfirmObservations(sqlite, linkDeviceId)).toEqual([])
    putConfirmObservation(sqlite, {
      linkDeviceId,
      environmentId,
      kind: 'peer_confirmed',
      detail: null,
      observedAt: now
    })
    expect(listConfirmObservations(sqlite, linkDeviceId)).toHaveLength(1)

    // --- peer_link_containment ---
    expect(getContainment(sqlite, 'link', linkDeviceId, 'quarantine')).toBeNull()
    expect(listContainment(sqlite)).toEqual([])
    expect(isPeerLinkQuarantined(sqlite, linkDeviceId)).toBe(false)

    putContainment(sqlite, {
      subjectKind: 'link',
      subjectId: linkDeviceId,
      action: 'quarantine',
      reasonCode: 'smoke_test',
      reasonText: null,
      detail: null,
      createdAt: now,
      expiresAt: null
    })
    expect(isPeerLinkQuarantined(sqlite, linkDeviceId)).toBe(true)
    expect(getContainment(sqlite, 'link', linkDeviceId, 'quarantine')).not.toBeNull()
    expect(listContainment(sqlite)).toHaveLength(1)

    liftContainment(sqlite, 'link', linkDeviceId, 'quarantine', now)
    expect(isPeerLinkQuarantined(sqlite, linkDeviceId)).toBe(false)

    // --- deleteBindingsAndAttemptsNotIn (R5.1 purge) ---
    putPeerLinkBinding(sqlite, {
      linkDeviceId,
      environmentId,
      boundEndpointId: 'endpoint_smoke_3',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_3',
      peerCredentialFp: 'peer_fp_3',
      peerKeyFingerprint: 'peer_key_fp_3',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: now,
      lastVerifiedAt: now
    })
    putBindingAttempt(sqlite, linkDeviceId)

    deleteBindingsAndAttemptsNotIn(sqlite, [])
    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS n FROM peer_link_bindings WHERE link_device_id = ?')
      .get(linkDeviceId) as { n: number }
    expect(remaining.n).toBe(0)
  })
})
