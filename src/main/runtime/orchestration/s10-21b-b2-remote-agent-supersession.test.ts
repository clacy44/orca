// S10-21b B2 (design §1.4(a), §4.7): remote_agents mirror supersession — listAddressableRemoteAgents
// excludes a superseded row, the ingest quarantine union (isRemoteAgentLocallyQuarantined) stays
// unchanged (keyed on remote_agent_id alone), and walkRemoteAgentSupersessionChain (the bounded
// helper §4.7 says backs B14's containment predicate, §1.4(b) clause 4, and B16's quarantine
// RPC/CLI caller — none of which call it yet in this commit).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb, PACT_SUPERSESSION_CHAIN_MAX } from './db'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

// Test-only: stamps supersession columns directly, since the writer that would normally do this
// (repointFederatedPactParty / rebind_party apply) doesn't land until B3/B13.
function supersede(db: OrchestrationDb, environmentId: string, oldId: string, newId: string): void {
  rawDb(db)
    .prepare(
      `UPDATE remote_agents SET superseded_at = datetime('now'), succeeded_by_remote_agent_id = ?
       WHERE environment_id = ? AND remote_agent_id = ?`
    )
    .run(newId, environmentId, oldId)
}

function seedRemoteAgent(db: OrchestrationDb, environmentId: string, remoteAgentId: string): void {
  db.upsertRemoteAgent({
    environmentId,
    environmentName: environmentId,
    linkKind: 'environment',
    remoteAgentId,
    displayName: remoteAgentId,
    role: null,
    state: 'live',
    derived: false,
    remoteQuarantined: false
  })
}

describe('S10-21b B2: remote_agents accessors exclude superseded rows', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('a superseded row is excluded from listAddressableRemoteAgents but still participates in the (unchanged) ingest quarantine union keyed on remote_agent_id alone', () => {
    db = new OrchestrationDb(':memory:')
    seedRemoteAgent(db, 'env_x', 'agent_old')
    seedRemoteAgent(db, 'env_x', 'agent_new')
    supersede(db, 'env_x', 'agent_old', 'agent_new')

    const addressable = db.listAddressableRemoteAgents({ environmentId: 'env_x' })
    expect(addressable.map((r) => r.remote_agent_id)).toEqual(['agent_new'])

    // The union stays keyed on remote_agent_id alone (§1.4(a)): a quarantine asserted on the
    // superseded row still withholds it at the ingest refusal — this accessor is deliberately
    // NOT made supersession-aware in this commit.
    db.setLocalRemoteAgentQuarantine({
      environmentId: 'env_x',
      remoteAgentId: 'agent_old',
      quarantined: true,
      reasonCode: 'operator_review'
    })
    expect(db.isRemoteAgentLocallyQuarantined('agent_old')).toBe(true)
  })

  it('walkRemoteAgentSupersessionChain follows both directions on a 3-hop chain', () => {
    db = new OrchestrationDb(':memory:')
    seedRemoteAgent(db, 'env_y', 'agent_1')
    seedRemoteAgent(db, 'env_y', 'agent_2')
    seedRemoteAgent(db, 'env_y', 'agent_3')
    seedRemoteAgent(db, 'env_y', 'agent_4')
    supersede(db, 'env_y', 'agent_1', 'agent_2')
    supersede(db, 'env_y', 'agent_2', 'agent_3')
    supersede(db, 'env_y', 'agent_3', 'agent_4')

    expect(db.walkRemoteAgentSupersessionChain('agent_1', 'env_y')).toEqual([
      'agent_1',
      'agent_2',
      'agent_3',
      'agent_4'
    ])
    // Starting from a middle node returns the same full chain, in order.
    expect(db.walkRemoteAgentSupersessionChain('agent_3', 'env_y')).toEqual([
      'agent_1',
      'agent_2',
      'agent_3',
      'agent_4'
    ])
  })

  it('stops at PACT_SUPERSESSION_CHAIN_MAX on a chain longer than the bound', () => {
    db = new OrchestrationDb(':memory:')
    const total = PACT_SUPERSESSION_CHAIN_MAX + 10
    for (let i = 0; i < total; i++) {
      seedRemoteAgent(db, 'env_z', `agent_${i}`)
    }
    for (let i = 0; i < total - 1; i++) {
      supersede(db, 'env_z', `agent_${i}`, `agent_${i + 1}`)
    }

    const chain = db.walkRemoteAgentSupersessionChain('agent_0', 'env_z')
    expect(chain.length).toBe(PACT_SUPERSESSION_CHAIN_MAX)
    expect(chain[0]).toBe('agent_0')
  })

  it('a cycle (structurally impossible via the writer) does not infinite-loop', () => {
    db = new OrchestrationDb(':memory:')
    seedRemoteAgent(db, 'env_c', 'agent_a')
    seedRemoteAgent(db, 'env_c', 'agent_b')
    // Force a 2-cycle directly via raw SQL — the writer (repointFederatedPactParty) never
    // produces this shape; the walker must still terminate.
    supersede(db, 'env_c', 'agent_a', 'agent_b')
    supersede(db, 'env_c', 'agent_b', 'agent_a')

    const chain = db.walkRemoteAgentSupersessionChain('agent_a', 'env_c')
    expect(chain.length).toBeLessThanOrEqual(PACT_SUPERSESSION_CHAIN_MAX)
    expect(new Set(chain).size).toBe(chain.length)
  })
})
