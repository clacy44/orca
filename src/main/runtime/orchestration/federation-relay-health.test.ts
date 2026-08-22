import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { recordFederationRelaySyncOutcome } from './federation-relay-health'
import { federationSyncHealthFromRow } from './federation-sync-health'
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
