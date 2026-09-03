// S10-16 C4e: closes the C4d delta review (s10-16-review-C4d.md) findings 1/7/8 under Ruling 23
// Addendum 6 (rr)/(vv) — unit tests against `settleOneLink` directly (never through a full round),
// since these are properties of the settle's own contest-write path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { DeviceRegistry } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import {
  createLinkBindingSelfView,
  type LinkBindingSelfView
} from './device-registry-link-credential'
import { OrchestrationDb } from './orchestration/db'
import type { LinkRoundWinner } from './orchestration/link-binding-classify'
import { settleOneLink } from './link-binding-prover-settle'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function winner(overrides: Partial<LinkRoundWinner> = {}): LinkRoundWinner {
  return {
    environmentId: 'env-a',
    createdAt: 0,
    boundEndpointId: 'ep-a',
    boundPairingRevision: 1,
    peerCredentialFp: 'credential-a',
    peerKeyFingerprint: 'key-a',
    ...overrides
  }
}

function contestAuditRows(db: OrchestrationDb): { reason_code: string }[] {
  return rawDb(db)
    .prepare(
      "SELECT reason_code FROM agent_audit WHERE verb = 'linkBinding' AND outcome = 'contested'"
    )
    .all() as { reason_code: string }[]
}

describe('S10-16 C4e: settleOneLink contest write (review C4d findings 1, 7, 8 / Ruling 23 Addendum 6)', () => {
  let root: string
  let userDataPath: string
  let deviceRegistry: DeviceRegistry
  let e2ee: E2EEKeypair
  let db: OrchestrationDb
  let selfView: LinkBindingSelfView
  let linkId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-link-binding-prover-settle-'))
    userDataPath = join(root, 'userdata')
    deviceRegistry = new DeviceRegistry(userDataPath)
    const link = deviceRegistry.mintPendingDevice('home', 'runtime')
    linkId = link.deviceId
    deviceRegistry.updateLastSeen(linkId)
    e2ee = loadOrCreateE2EEKeypair(userDataPath)
    db = new OrchestrationDb(':memory:')
    selfView = createLinkBindingSelfView(deviceRegistry, () => e2ee.publicKeyB64)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('finding 1/Ruling 23 Addendum 6(rr): the contest audit is written UNMETERED — two contests in one rate window both produce a row', () => {
    const winners = [
      winner({
        environmentId: 'env-a',
        peerCredentialFp: 'credential-a',
        peerKeyFingerprint: 'key-a'
      }),
      winner({
        environmentId: 'env-b',
        peerCredentialFp: 'credential-b',
        peerKeyFingerprint: 'key-b'
      })
    ]
    const base = {
      db,
      selfView,
      linkDeviceId: linkId,
      grantClass: 'minted' as const,
      winners,
      peerDuplicateCount: 0,
      attempted: true,
      reconfirmed: false,
      environmentIds: ['env-a', 'env-b'],
      collapseDetail: null
    }
    settleOneLink({ ...base, now: 1000 })
    // A second contest well inside the same LINK_BINDING_RATE_WINDOW_MS — before (rr), the
    // metered write dropped this row; the security audit must never drop a contest.
    settleOneLink({ ...base, now: 2000 })
    expect(contestAuditRows(db)).toHaveLength(2)
  })

  it('findings 7/8/Ruling 23 Addendum 6(vv): winners are ordered by (channel fp, key fp) before the first is taken — array order never decides identity', () => {
    const winnersInOneOrder = [
      winner({
        environmentId: 'env-z',
        peerCredentialFp: 'credential-z',
        peerKeyFingerprint: 'key-z'
      }),
      winner({
        environmentId: 'env-a',
        peerCredentialFp: 'credential-a',
        peerKeyFingerprint: 'key-a'
      })
    ]
    const winnersReversed = winnersInOneOrder.toReversed()
    // Two independent links (not one link contested twice) — this isolates the ordering property
    // from the upsert guard's own "no in-place overwrite of a settled contest" behaviour, which
    // findings 7/8's own store-level test covers separately.
    const linkA = deviceRegistry.mintPendingDevice('home', 'runtime').deviceId
    deviceRegistry.updateLastSeen(linkA)
    const linkB = deviceRegistry.mintPendingDevice('home', 'runtime').deviceId
    deviceRegistry.updateLastSeen(linkB)
    const base = {
      db,
      selfView,
      grantClass: 'minted' as const,
      peerDuplicateCount: 0,
      attempted: true,
      reconfirmed: false,
      environmentIds: ['env-a', 'env-z'],
      collapseDetail: null,
      now: 1000
    }
    settleOneLink({ ...base, linkDeviceId: linkA, winners: winnersInOneOrder })
    const firstRun = db.getPeerLinkBinding(linkA)
    expect(firstRun?.environmentId).toBe('env-a')

    settleOneLink({ ...base, linkDeviceId: linkB, winners: winnersReversed })
    const secondRun = db.getPeerLinkBinding(linkB)
    // Same deterministic pick regardless of the winners array's own order.
    expect(secondRun?.environmentId).toBe('env-a')
  })

  it("finding 7/Ruling 23 Addendum 6(vv): a winner missing a host-derived identity field never writes a junk row — settles 'protocol_violation' instead", () => {
    const winners = [
      // Ordered first by credential fp ('credential-a' < 'credential-z') — this is the one
      // `writeContest` would take as the row's identity, and it is missing `boundEndpointId`.
      winner({
        environmentId: 'env-a',
        peerCredentialFp: 'credential-a',
        peerKeyFingerprint: 'key-a',
        boundEndpointId: ''
      }),
      winner({
        environmentId: 'env-z',
        peerCredentialFp: 'credential-z',
        peerKeyFingerprint: 'key-z'
      })
    ]
    db.putBindingAttempt(linkId)
    settleOneLink({
      db,
      selfView,
      linkDeviceId: linkId,
      grantClass: 'minted',
      winners,
      peerDuplicateCount: 0,
      attempted: true,
      reconfirmed: false,
      now: 1000,
      environmentIds: ['env-a', 'env-z'],
      collapseDetail: null
    })
    expect(db.getPeerLinkBinding(linkId)).toBeNull()
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('protocol_violation')
    expect(contestAuditRows(db)).toHaveLength(0)
  })
})
