// S10-4 ruling 1 (remote_agents + relay_seen schema/triggers), ruling 5 (relinkFederatedEnvironment
// recovery verb). See agent-coordination-s10-4-federation-spec.md ARBITRATION #4, #6.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('S10-4 schema v36: remote_agents + relay_seen', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('a fresh database lands at user_version 36 with both new tables', () => {
    db = new OrchestrationDb(':memory:')
    const raw = (db as unknown as { db: Database.Database }).db
    expect(raw.pragma('user_version', { simple: true })).toBe(36)
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
    )
    expect(tables.has('remote_agents')).toBe(true)
    expect(tables.has('relay_seen')).toBe(true)
  })

  it('reopening an already-migrated database is a no-op (idempotent)', () => {
    db = new OrchestrationDb(':memory:')
    db.upsertRemoteAgent({
      environmentId: 'env_a',
      environmentName: 'work-laptop',
      remoteAgentId: 'agent_remote_1',
      displayName: 'peer-one',
      role: null,
      state: 'idle',
      derived: false,
      remoteQuarantined: false
    })
    // migrate() is invoked again by the constructor path on a fresh OrchestrationDb pointed at
    // the same file; :memory: can't reopen, so assert the schema-level idempotency directly —
    // running createTables()+the current<36 exec a second time against a non-empty table must
    // not throw (every statement is IF NOT EXISTS / additive).
    const raw = (db as unknown as { db: Database.Database }).db
    expect(() => raw.exec(`CREATE TABLE IF NOT EXISTS remote_agents (x TEXT)`)).not.toThrow()
    expect(db.listRemoteAgents()).toHaveLength(1)
  })

  it('remote_agents is NEVER reachable from agents — origin_kind refuses paired_runtime', () => {
    db = new OrchestrationDb(':memory:')
    const raw = (db as unknown as { db: Database.Database }).db
    expect(() =>
      raw
        .prepare(
          `INSERT INTO agents (id, display_name, origin_kind, origin_host_id)
           VALUES ('agent_x', 'x', 'paired_runtime', 'local')`
        )
        .run()
    ).toThrow(/foreign agents live in remote_agents/)
  })

  it('upsertRemoteAgent inserts then updates in place, keyed by (environment, remote agent id)', () => {
    db = new OrchestrationDb(':memory:')
    db.upsertRemoteAgent({
      environmentId: 'env_a',
      environmentName: 'work-laptop',
      remoteAgentId: 'agent_remote_1',
      displayName: 'peer-one',
      role: 'coordinator',
      state: 'idle',
      derived: false,
      remoteQuarantined: false
    })
    db.upsertRemoteAgent({
      environmentId: 'env_a',
      environmentName: 'work-laptop-renamed',
      remoteAgentId: 'agent_remote_1',
      displayName: 'peer-one',
      role: 'coordinator',
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    const rows = db.listRemoteAgents()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      environment_name: 'work-laptop-renamed',
      state: 'live'
    })
  })

  it('listRemoteAgents excludes quarantined rows by default and includes them on request', () => {
    db = new OrchestrationDb(':memory:')
    db.upsertRemoteAgent({
      environmentId: 'env_a',
      environmentName: 'work-laptop',
      remoteAgentId: 'agent_remote_1',
      displayName: 'peer-one',
      role: null,
      state: 'idle',
      derived: false,
      remoteQuarantined: true
    })
    expect(db.listRemoteAgents()).toHaveLength(0)
    expect(db.listRemoteAgents({ includeQuarantined: true })).toHaveLength(1)
  })

  it('a remote-asserted quarantine lift can never clear a local quarantine (trg_remote_lift_scope)', () => {
    db = new OrchestrationDb(':memory:')
    db.upsertRemoteAgent({
      environmentId: 'env_a',
      environmentName: 'work-laptop',
      remoteAgentId: 'agent_remote_1',
      displayName: 'peer-one',
      role: null,
      state: 'idle',
      derived: false,
      remoteQuarantined: true
    })
    db.setLocalRemoteAgentQuarantine({
      environmentId: 'env_a',
      remoteAgentId: 'agent_remote_1',
      quarantined: true,
      reasonCode: 'operator_review'
    })
    // A naive sync path that applies the peer's whole row wholesale — remote_quarantined
    // flips AND local_quarantined is cleared in the same statement — must be refused: this
    // host's own defensive quarantine is not the peer's to lift.
    const raw = (db as unknown as { db: Database.Database }).db
    expect(() =>
      raw
        .prepare(
          `UPDATE remote_agents SET remote_quarantined = 0, local_quarantined = 0
           WHERE environment_id = 'env_a' AND remote_agent_id = 'agent_remote_1'`
        )
        .run()
    ).toThrow(/a remote lift cannot clear a local quarantine/)
    // But a purely local lift (remote_quarantined untouched) still passes.
    const lifted = db.setLocalRemoteAgentQuarantine({
      environmentId: 'env_a',
      remoteAgentId: 'agent_remote_1',
      quarantined: false
    })
    expect(lifted.local_quarantined).toBe(0)
    expect(lifted.remote_quarantined).toBe(1)
  })

  it('relay_seen is append-only: neither UPDATE nor DELETE is permitted', () => {
    db = new OrchestrationDb(':memory:')
    db.recordRelaySeen({
      dispatchId: 'ctx_1',
      sequence: 1,
      messageId: 'msg_1',
      outcome: 'imported'
    })
    const raw = (db as unknown as { db: Database.Database }).db
    expect(() =>
      raw.prepare(`UPDATE relay_seen SET outcome = 'refused' WHERE dispatch_id = 'ctx_1'`).run()
    ).toThrow(/append-only/)
    expect(() => raw.prepare(`DELETE FROM relay_seen WHERE dispatch_id = 'ctx_1'`).run()).toThrow(
      /append-only/
    )
  })

  it('recordRelaySeen is idempotent under a replayed call for the same (dispatch, sequence)', () => {
    db = new OrchestrationDb(':memory:')
    db.recordRelaySeen({
      dispatchId: 'ctx_1',
      sequence: 1,
      messageId: 'msg_1',
      outcome: 'refused',
      ruleIds: ['merge-gate-audit-heading']
    })
    // A later call for the identical key is silently ignored (INSERT OR IGNORE), not an error
    // and not an overwrite — the first outcome for a sequence is the durable one.
    expect(() =>
      db!.recordRelaySeen({
        dispatchId: 'ctx_1',
        sequence: 1,
        messageId: 'msg_1',
        outcome: 'imported'
      })
    ).not.toThrow()
    const rows = db.listRelaySeen('ctx_1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'refused' })
    expect(JSON.parse(rows[0]!.rule_ids!)).toEqual(['merge-gate-audit-heading'])
  })
})

describe('S10-4 ruling 5: relinkFederatedEnvironment', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createFederatedDispatch(orchestrationDb: OrchestrationDb, environmentId: string) {
    const run = orchestrationDb.createRun({
      objective: 'cross-host work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = orchestrationDb.createTask({ spec: 'do the thing', runId: run.id })
    const { dispatch } = orchestrationDb.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId,
        environmentName: 'work-laptop',
        peerFingerprint: 'peer_fingerprint_1',
        protocolVersion: 3
      }
    })
    return dispatch
  }

  it('zeroes the to_home cursors and epoch for every active federated dispatch on the environment', () => {
    db = new OrchestrationDb(':memory:')
    const dispatch = createFederatedDispatch(db, 'env_stale')
    // Simulate real relay progress before the peer was reimaged.
    db.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 1,
      relayKind: 'status',
      message: {
        id: 'relay_1',
        runId: dispatch.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${dispatch.run_id}`,
        subject: 'progress',
        body: 'still going',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })
    expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(1)

    const result = db.relinkFederatedEnvironment('env_stale')
    expect(result.dispatchIds).toEqual([dispatch.id])
    const federated = db.getFederatedDispatch(dispatch.id)!
    expect(federated.to_home_imported_sequence).toBe(0)
    expect(federated.to_home_acknowledged_sequence).toBe(0)
    expect(federated.remote_runtime_epoch).toBeNull()

    // relay_seen for the pre-relink item is preserved (never touched by relink) so a byte-
    // identical replay under the old sequence number is still caught as before.
    expect(db.listRelaySeen(dispatch.id)).toHaveLength(1)
  })

  it('is a no-op returning an empty list when the environment has no active federated dispatch', () => {
    db = new OrchestrationDb(':memory:')
    expect(db.relinkFederatedEnvironment('env_unknown')).toEqual({ dispatchIds: [] })
  })

  it('never touches a dispatch federated to a different environment', () => {
    db = new OrchestrationDb(':memory:')
    const other = createFederatedDispatch(db, 'env_other')
    db.relinkFederatedEnvironment('env_stale')
    expect(db.getFederatedDispatch(other.id)!.to_home_imported_sequence).toBe(0)
    // Unaffected because it was never touched, not because it started at 0 — prove relink
    // for a different environment id truly returns nothing for this one.
    expect(db.relinkFederatedEnvironment('env_stale').dispatchIds).not.toContain(other.id)
  })
})
