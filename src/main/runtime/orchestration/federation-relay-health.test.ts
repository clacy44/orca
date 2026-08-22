import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import { recordFederationRelaySyncOutcome } from './federation-relay-health'
import {
  FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD,
  FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS,
  federationRelayFailuresToOutlast,
  federationRelayIntervalMs,
  federationSyncHealthFromRow
} from './federation-sync-health'
import { OrchestrationError } from './orchestration-error'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('federated relay health persistence', () => {
  let db: OrchestrationDb
  let runId: string
  let notified: { handle: string; type: string | undefined }[]
  let runtime: { notifyMessageArrived: (handle: string, type?: string) => void }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    notified = []
    runtime = {
      notifyMessageArrived: (handle, type) => {
        notified.push({ handle, type })
      }
    }
    runId = db.createRun({
      objective: 'Relay health',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function startFederatedDispatch(): string {
    const taskId = db.createTask({ spec: 'remote audit', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      federation: {
        environmentId: 'environment_peer',
        environmentName: 'peer',
        peerFingerprint: 'peer_fingerprint',
        protocolVersion: 1
      }
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch.id
  }

  function startLocalDispatch(): string {
    const taskId = db.createTask({ spec: 'local refactor', runId }).id
    const started = db.createStartingWorkerDispatch({ taskId, startOptions: {} })
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch.id
  }

  it('round-trips a settled sync through the federated_dispatches row', () => {
    const dispatchId = startFederatedDispatch()

    const healthy = recordFederationRelaySyncOutcome({
      db,
      runtime,
      dispatchId,
      previous: undefined,
      outcome: { kind: 'success', at: '2026-08-22T00:00:00.000Z' }
    })

    expect(healthy).toEqual({
      lastSyncAt: '2026-08-22T00:00:00.000Z',
      lastError: null,
      consecutiveFailures: 0
    })
    expect(db.getFederatedDispatchSyncHealth(dispatchId)).toEqual(healthy)
    expect(db.getFederatedDispatch(dispatchId)).toMatchObject({
      last_sync_at: '2026-08-22T00:00:00.000Z',
      last_error: null,
      consecutive_failures: 0
    })
  })

  it('keeps the last successful sync while the failures accumulate', () => {
    const dispatchId = startFederatedDispatch()
    let health = recordFederationRelaySyncOutcome({
      db,
      runtime,
      dispatchId,
      previous: undefined,
      outcome: { kind: 'success', at: '2026-08-22T00:00:00.000Z' }
    })

    for (let failure = 0; failure < 3; failure += 1) {
      health = recordFederationRelaySyncOutcome({
        db,
        runtime,
        dispatchId,
        previous: health,
        outcome: {
          kind: 'failure',
          error: new OrchestrationError('runtime_unreachable', 'Peer refused the connection.')
        }
      })
    }

    expect(db.getFederatedDispatchSyncHealth(dispatchId)).toEqual({
      lastSyncAt: '2026-08-22T00:00:00.000Z',
      lastError: 'runtime_unreachable: Peer refused the connection.',
      consecutiveFailures: 3
    })
    // Three failures is below the threshold, so nothing was announced yet.
    expect(notified).toEqual([])
  })

  // Why the schedule and not the count: A1 §9 asks for "sustained", and five failures on the 1s
  // doubling curve is ~31 seconds — a peer restart, not an outage.
  it('sets the unreachable threshold from an outage floor rather than a bare count', () => {
    expect(FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD).toBe(
      federationRelayFailuresToOutlast(FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS)
    )
    let elapsedMs = 0
    for (let failure = 1; failure < FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD; failure += 1) {
      elapsedMs += federationRelayIntervalMs(failure)
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS)
    expect(
      elapsedMs - federationRelayIntervalMs(FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD - 1)
    ).toBeLessThan(FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS)
    // A 45-second peer restart cannot reach the threshold on this curve.
    expect(federationRelayFailuresToOutlast(45_000)).toBeLessThan(
      FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD
    )
  })

  it('reports null for a federated Dispatch the relay has never settled on', () => {
    const dispatchId = startFederatedDispatch()

    // Why this stays null rather than becoming a zeroed reading: `sync` may only widen — same field,
    // same shape, non-null more often — so an untouched row must answer exactly as it does today.
    expect(db.getFederatedDispatchSyncHealth(dispatchId)).toBeNull()
    expect(federationSyncHealthFromRow(undefined)).toBeNull()
  })

  it('reports null for a purely local Dispatch, which has no relay row at all', () => {
    expect(db.getFederatedDispatchSyncHealth(startLocalDispatch())).toBeNull()
  })

  it('leaves the health readable but keeps writes off the binding receipt', () => {
    const dispatchId = startFederatedDispatch()
    const before = db.getFederatedDispatch(dispatchId)?.updated_at

    recordFederationRelaySyncOutcome({
      db,
      runtime,
      dispatchId,
      previous: undefined,
      outcome: { kind: 'failure', error: new Error('socket hang up') }
    })

    expect(db.getFederatedDispatch(dispatchId)?.updated_at).toBe(before)
    expect(db.getFederatedDispatchSyncHealth(dispatchId)).toMatchObject({
      lastError: 'socket hang up',
      consecutiveFailures: 1
    })
  })

  it('still reports the in-process health when the row write fails', () => {
    const dispatchId = startFederatedDispatch()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(db, 'recordFederatedDispatchSyncHealth').mockImplementation(() => {
      throw new Error('database is locked')
    })

    expect(
      recordFederationRelaySyncOutcome({
        db,
        runtime,
        dispatchId,
        previous: undefined,
        outcome: { kind: 'success', at: '2026-08-22T00:00:00.000Z' }
      })
    ).toMatchObject({ lastSyncAt: '2026-08-22T00:00:00.000Z', consecutiveFailures: 0 })
    expect(warn).toHaveBeenCalled()
  })

  it('names an unsettled federated Dispatch as a notice target and a settled one never', () => {
    const dispatchId = startFederatedDispatch()
    const target = db.getFederatedRelayNoticeTarget(dispatchId)
    expect(target).toMatchObject({ runId, environmentName: 'peer' })

    db.settleWorkerReport({
      taskId: target!.taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'done'
    })

    expect(db.getFederatedRelayNoticeTarget(dispatchId)).toBeUndefined()
    expect(db.getFederatedRelayNoticeTarget(startLocalDispatch())).toBeUndefined()
  })
})

describe('federated relay health migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // Why every v31 column and not two of the three: the skew table is what decides a database is
  // complete, so a column it does not list is one the repair would never restore.
  it('judges a database claiming v31 incomplete when any v31 column is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-relay-health-skew-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    for (const column of ['last_sync_at', 'last_error', 'consecutive_failures']) {
      const raw = new Database(dbPath)
      expect(resolveOrchestrationMigrationStartVersion(raw, 31, 31)).toBe(31)
      raw.exec(`ALTER TABLE federated_dispatches DROP COLUMN ${column}`)
      expect(resolveOrchestrationMigrationStartVersion(raw, 31, 31)).toBe(6)
      raw.exec(
        `ALTER TABLE federated_dispatches ADD COLUMN ${column} ${
          column === 'consecutive_failures' ? 'INTEGER NOT NULL DEFAULT 0' : 'TEXT'
        }`
      )
      raw.close()
    }
  })

  it('adds the health columns to a v30 database without disturbing its relay state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-relay-health-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('ALTER TABLE federated_dispatches DROP COLUMN last_sync_at')
    oldDb.exec('ALTER TABLE federated_dispatches DROP COLUMN last_error')
    oldDb.exec('ALTER TABLE federated_dispatches DROP COLUMN consecutive_failures')
    oldDb.pragma('user_version = 30')
    oldDb
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint,
           protocol_version, to_home_imported_sequence
         ) VALUES ('ctx_migrated', 'env', 'worker', 'peer', 3, 2)`
      )
      .run()
    oldDb.close()

    db = new OrchestrationDb(dbPath)

    expect(db.getFederatedDispatch('ctx_migrated')).toMatchObject({
      to_home_imported_sequence: 2,
      last_sync_at: null,
      last_error: null,
      consecutive_failures: 0
    })
    // Why null and not a zeroed reading: a Dispatch that predates the columns has not "synced
    // never" in a way anyone measured, and `sync` may only widen from what it reports today.
    expect(db.getFederatedDispatchSyncHealth('ctx_migrated')).toBeNull()
  })
})

// Read the guide source rather than the bundle it generates: `src/cli` is outside this tsconfig
// project, and `verify:bundled-skill-guides` already pins the bundle to this file.
const ORCHESTRATION_GUIDE = readFileSync(
  new URL('../../../../skill-guides/orchestration.md', import.meta.url),
  'utf8'
)

describe('relay health vocabulary in the bundled guide', () => {
  it('names the sync fields a coordinator has to read', () => {
    // Why pinned: A1 section 9 measured zero hits for all three in the bundled guide, so the signal
    // existed and no coordinator had been told it was there.
    for (const field of ['lastSyncAt', 'lastError', 'consecutiveFailures', 'syncHealth']) {
      expect(ORCHESTRATION_GUIDE).toContain(field)
    }
  })

  it('names both relay notices and keeps them off the release ladder', () => {
    expect(ORCHESTRATION_GUIDE).toContain('relay_unreachable')
    expect(ORCHESTRATION_GUIDE).toContain('relay_recovered')
    expect(ORCHESTRATION_GUIDE).toContain('Never fail or release a worker over `relay_unreachable`')
  })

  it('no longer offers tui-idle as the liveness checkpoint', () => {
    // Negative control for the correction: the sentence must still tell a coordinator what to do
    // when a wait window returns nothing, just not with the test that reads a gated agent as idle.
    expect(ORCHESTRATION_GUIDE).not.toContain(
      'or `terminal wait --for tui-idle` as a liveness checkpoint'
    )
    expect(ORCHESTRATION_GUIDE).toContain('`tui-idle` is not one')
  })
})
