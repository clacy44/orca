// S10-21b B18 (D-R137 F6): proposePact's federated branch must be ONE transaction — a message-
// gate refusal (or crash) between the era-reset UPDATE and the relay enqueue must leave the
// thread's state/era/anchors untouched and write zero pact_steps/messages rows. Fails at base
// b9df9b7061: enqueueFederatedPactVerb ran OUTSIDE proposePact's own `BEGIN IMMEDIATE`, so the
// era-reset UPDATE (and the federated peer-anchor UPDATE) had already committed by the time the
// refusal was thrown.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import type * as PactFederatedEmitModule from './pact-federated-emit'

const { enqueueWithinMock } = vi.hoisted(() => ({ enqueueWithinMock: vi.fn() }))
vi.mock('./pact-federated-emit', async (importOriginal) => {
  const actual = await importOriginal<typeof PactFederatedEmitModule>()
  return {
    ...actual,
    enqueueFederatedPactVerbWithin: (
      ...args: Parameters<typeof actual.enqueueFederatedPactVerbWithin>
    ) => enqueueWithinMock(...args)
  }
})

import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env1'
const REMOTE_AGENT_ID = 'rb'

describe('S10-21b B18 (D-R137 F6): proposePact federated branch is one transaction', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    enqueueWithinMock.mockReset()
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedAgent(d: OrchestrationDb, id: string): string {
    const params: UpsertAgentByPaneSuffixParams = {
      displayName: id,
      role: null,
      hostId: 'local',
      paneKey: `tab:${id}`,
      terminalHandle: `term_${id}`,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: `term_${id}`,
      originHostId: 'local'
    }
    const result = d.upsertAgentByPaneSuffix(params)
    if (result.outcome === 'name_taken') {
      throw new Error(`seedAgent: name taken for ${id}`)
    }
    return result.agent.id
  }

  function actor(agentId: string): {
    callerAgentId: string
    callerPaneKey: string | null
    callerHostId: string
  } {
    return { callerAgentId: agentId, callerPaneKey: `tab:${agentId}`, callerHostId: 'local' }
  }

  function seedFederatedPeer(d: OrchestrationDb): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'b (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(d), {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    return renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId: REMOTE_AGENT_ID })
  }

  it('a refusing message gate leaves state/era/anchors unchanged and writes zero rows', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    const before = d.getThread(thread.id)!
    enqueueWithinMock.mockImplementation(() => ({
      outcome: 'refused',
      verdict: { tier: 'hard', ruleIds: ['test_rule'] },
      refusalId: 1
    }))

    expect(() =>
      d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    ).toThrow()

    const after = d.getThread(thread.id)!
    expect(after.pact_state).toBe(before.pact_state)
    expect(after.pact_era).toBe(before.pact_era)
    expect(after.pact_peer_agent_id).toBeNull()
    expect(after.pact_peer_environment_id).toBeNull()
    expect(after.pact_peer_link_device_id).toBeNull()
    expect(after.pact_peer_key_fingerprint).toBeNull()

    const messageCount = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?`)
      .get(thread.id) as { n: number }
    expect(messageCount.n).toBe(0)
    const ledger = d.getPactLedger({ threadId: thread.id, revealSummaries: true })
    expect(ledger.entries).toHaveLength(0)
  })
})
