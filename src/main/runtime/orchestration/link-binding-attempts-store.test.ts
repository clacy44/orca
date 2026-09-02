import { describe, expect, it, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  getBindingAttempt,
  listBindingAttempts,
  putBindingAttempt,
  settleBindingAttempt,
  putLinkAdvisory,
  clearLinkAdvisory,
  bumpMisrouteAdvisories
} from './link-binding-attempts-store'

// F15/SMOKE: one test per store module that calls EVERY exported statement once against a fresh
// v40 DB — this is the test that would have caught F1: clearLinkAdvisory used to UPDATE
// last_advisory_notified_at, a column the v40 DDL never creates, and threw at prepare() on first
// call. No test exercised it, so it survived to review.

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('link-binding-attempts-store: smoke (every exported statement runs against a fresh v40 DB)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('calls every exported statement once', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const now = Date.now()
    const linkDeviceId = 'link_smoke_2'

    expect(getBindingAttempt(sqlite, linkDeviceId)).toBeNull()
    expect(listBindingAttempts(sqlite)).toEqual([])

    putBindingAttempt(sqlite, linkDeviceId)
    expect(getBindingAttempt(sqlite, linkDeviceId)).not.toBeNull()
    expect(listBindingAttempts(sqlite)).toHaveLength(1)

    settleBindingAttempt(sqlite, linkDeviceId, {
      lastAttemptAt: now,
      lastRoundAt: now,
      lastFullRoundAt: now,
      lastOutcome: 'proven',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: null
    })
    expect(getBindingAttempt(sqlite, linkDeviceId)?.lastOutcome).toBe('proven')

    putLinkAdvisory(sqlite, linkDeviceId, { kind: 'link_contested', incidentId: 'incident_1' }, now)
    expect(getBindingAttempt(sqlite, linkDeviceId)?.lastAdvisory).not.toBeNull()

    bumpMisrouteAdvisories(sqlite, linkDeviceId)
    expect(getBindingAttempt(sqlite, linkDeviceId)?.misrouteAdvisories).toBe(1)

    // The F1 regression: this must not throw (no such column).
    expect(() => clearLinkAdvisory(sqlite, linkDeviceId)).not.toThrow()
    const cleared = getBindingAttempt(sqlite, linkDeviceId)
    expect(cleared?.lastAdvisory).toBeNull()
    expect(cleared?.misrouteAdvisories).toBe(0)
  })
})
