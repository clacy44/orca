// S10-21b B13 (design §1.4 "Local side", §2.11) — the pump-side drain of
// `pact_relay_pending = 'rebind'`: emits `rebind_party` naming the local party's most recent
// tombstoned predecessor as `rebind.oldAgentId`, then clears the flag.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { drainPendingRebindParty } from './pact-federated-rebind'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_rebind_drain'
const REMOTE_AGENT_ID = 'peer_rb'

describe('drainPendingRebindParty', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
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

  function seedFederatedPeer(d: OrchestrationDb): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'peer (remote)',
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

  it("emits rebind_party naming the local party's most recent tombstoned predecessor, then clears the flag", () => {
    const d = freshDb()
    const raw = rawDb(d)
    const successorId = seedAgent(d, 'chair-a')
    // A tombstoned predecessor sharing this same (host_id, display_name) pane identity.
    raw
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES ('agt_pred_a', 'chair-a', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
      )
      .run()
    const peerKey = seedFederatedPeer(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: successorId,
      participants: [
        { participantKey: successorId, agentId: successorId },
        { participantKey: peerKey, agentId: null }
      ]
    })
    d.proposePact({
      callerAgentId: successorId,
      callerPaneKey: null,
      callerHostId: 'local',
      threadId: thread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_relay_pending = 'rebind' WHERE id = ?`
      )
      .run(successorId, thread.id)

    const drained = drainPendingRebindParty(raw, null)
    expect(drained).toBe(1)

    const row = raw
      .prepare('SELECT pact_relay_pending FROM threads WHERE id = ?')
      .get(thread.id) as { pact_relay_pending: string | null }
    expect(row.pact_relay_pending).toBeNull()

    const outboxRow = raw
      .prepare(`SELECT payload FROM peer_reply_outbox WHERE local_thread_id = ?`)
      .get(thread.id) as { payload: string } | undefined
    expect(outboxRow).toBeDefined()
    const payload = JSON.parse(outboxRow!.payload) as {
      pact: { verb: string; rebind: { oldAgentId: string } }
    }
    expect(payload.pact.verb).toBe('rebind_party')
    expect(payload.pact.rebind.oldAgentId).toBe('agt_pred_a')
  })

  it('clears the flag with no outbox row when there is no tombstoned predecessor to report', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const successorId = seedAgent(d, 'chair-b')
    const peerKey = seedFederatedPeer(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: successorId,
      participants: [
        { participantKey: successorId, agentId: successorId },
        { participantKey: peerKey, agentId: null }
      ]
    })
    d.proposePact({
      callerAgentId: successorId,
      callerPaneKey: null,
      callerHostId: 'local',
      threadId: thread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_relay_pending = 'rebind' WHERE id = ?`
      )
      .run(successorId, thread.id)

    const drained = drainPendingRebindParty(raw, null)
    expect(drained).toBe(0)
    const row = raw
      .prepare('SELECT pact_relay_pending FROM threads WHERE id = ?')
      .get(thread.id) as { pact_relay_pending: string | null }
    expect(row.pact_relay_pending).toBeNull()
    const outboxCount = raw.prepare('SELECT COUNT(*) AS n FROM peer_reply_outbox').get() as {
      n: number
    }
    expect(outboxCount.n).toBe(0)
  })
})
