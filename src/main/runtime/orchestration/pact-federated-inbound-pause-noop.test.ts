// S10-21b B21 (D-D3-A item 7 T3/T4; SYNTHESIS S2, ruling 21b-E13) — the inbound `pause`/`step`
// gate 13 split: `pause` never consults OUR `pact_paused_at`, only the peer's already-recorded
// half (a redundant relayed pause is acknowledged `pause_noop`, symmetric to `resume_noop`);
// `step` refuses `pact_paused` on OUR `pact_paused_at` ONLY, never on the peer's — a peer's
// applied `step`/`accept` is proof they resumed and clears `pact_peer_paused_at` (H3).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_pause_noop'
const REMOTE_AGENT_ID = 'peer_pn'

describe('inbound pause/step — 21b-E13 pause_noop and peer-pause supersession', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function actor(agentId: string): {
    callerAgentId: string
    callerPaneKey: string | null
    callerHostId: string
  } {
    return { callerAgentId: agentId, callerPaneKey: `tab:${agentId}`, callerHostId: 'local' }
  }

  // Engaged federated pact, turn held by the REMOTE peer (so an inbound `step` is not refused
  // `not_a_participant`), `pact_peer_thread_id` mapped so inbound verbs resolve to this thread.
  function engagedFederatedPactTurnOnPeer(d: OrchestrationDb): {
    threadId: string
    a: string
    era: number
  } {
    const params: UpsertAgentByPaneSuffixParams = {
      displayName: 'a_pn',
      role: null,
      hostId: 'local',
      paneKey: 'tab:a_pn',
      terminalHandle: 'term_a_pn',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_a_pn',
      originHostId: 'local'
    }
    const result = d.upsertAgentByPaneSuffix(params)
    if (result.outcome === 'name_taken') {
      throw new Error('seedAgent: name taken')
    }
    const a = result.agent.id
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
      boundEndpointId: 'endpoint_pn',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_pn',
      peerCredentialFp: 'pcfp_pn',
      peerKeyFingerprint: 'pkfp_pn',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    const peerKey = renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId: REMOTE_AGENT_ID })
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_peer_thread_id = ?
         WHERE id = ?`
      )
      .run(peerKey, 'thr_aaaaaaaaaaa1', thread.id)
    const era = (
      rawDb(d).prepare('SELECT pact_era FROM threads WHERE id = ?').get(thread.id) as {
        pact_era: number
      }
    ).pact_era
    return { threadId: thread.id, a, era }
  }

  function inboundArgs(overrides: Partial<ApplyInboundPactVerbArgs>): ApplyInboundPactVerbArgs {
    return {
      pairedDeviceId: ENV,
      senderAgentId: REMOTE_AGENT_ID,
      senderEnvironmentId: ENV,
      messageId: 'msg_aaaaaaaaaaa0',
      peerThreadId: 'thr_aaaaaaaaaaa1',
      toAgentId: '',
      body: undefined,
      pact: { verb: 'pause', seq: 1, era: 0 },
      ...overrides
    }
  }

  // -----------------------------------------------------------------------------------------
  // T3 (D-D3-A) — an inbound `pause` at peer_seq+1 with `pact_peer_paused_at` already set: no
  // throw, the fence advances, an applied-id row exists, no second remote pause ledger row, an
  // audit row exists. RED at base: throws `pact_paused` (base's own-pause conjunct on `pause`).
  // -----------------------------------------------------------------------------------------
  it('T3: a redundant inbound pause (peer already recorded paused) is pause_noop, not a refusal', () => {
    const d = freshDb()
    const { threadId, a, era } = engagedFederatedPactTurnOnPeer(d)
    const raw = rawDb(d)
    raw
      .prepare(`UPDATE threads SET pact_peer_paused_at = datetime('now') WHERE id = ?`)
      .run(threadId)

    const result = d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        messageId: 'msg_aaaaaaaaaaa3',
        pact: { verb: 'pause', seq: 1, era }
      })
    )
    expect(result.accepted).toBe(true)

    const after = raw.prepare('SELECT pact_peer_seq FROM threads WHERE id = ?').get(threadId) as {
      pact_peer_seq: number
    }
    expect(after.pact_peer_seq).toBe(1)

    const appliedIdRow = raw
      .prepare(`SELECT 1 FROM pact_applied_ids WHERE thread_id = ? AND message_id = ?`)
      .get(threadId, 'msg_aaaaaaaaaaa3')
    expect(appliedIdRow).toBeDefined()

    const remotePauseSteps = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'pause' AND actor_is_remote = 1`
      )
      .get(threadId) as { n: number }
    expect(remotePauseSteps.n).toBe(0)

    const auditRow = raw
      .prepare(
        `SELECT outcome FROM agent_audit WHERE verb = 'pact_pause' ORDER BY seq DESC LIMIT 1`
      )
      .get() as { outcome: string } | undefined
    expect(auditRow?.outcome).toBe('applied')
  })

  // -----------------------------------------------------------------------------------------
  // T4 (D-D3-A) — an inbound `pause` while OUR `pact_paused_at` is set and the peer's is NULL:
  // applied (never consults our pause), `pact_peer_paused_at` set, fence advanced. RED at base:
  // throws `pact_paused` (base's `thread.pact_paused_at !== null` conjunct on `pause`).
  // -----------------------------------------------------------------------------------------
  it('T4: an inbound pause applies even while OUR pause is set, since pause never consults it', () => {
    const d = freshDb()
    const { threadId, a, era } = engagedFederatedPactTurnOnPeer(d)
    const raw = rawDb(d)
    raw.prepare(`UPDATE threads SET pact_paused_at = datetime('now') WHERE id = ?`).run(threadId)

    const result = d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        messageId: 'msg_aaaaaaaaaaa4',
        pact: { verb: 'pause', seq: 1, era }
      })
    )
    expect(result.accepted).toBe(true)

    const after = raw
      .prepare('SELECT pact_peer_paused_at, pact_peer_seq FROM threads WHERE id = ?')
      .get(threadId) as { pact_peer_paused_at: string | null; pact_peer_seq: number }
    expect(after.pact_peer_paused_at).not.toBeNull()
    expect(after.pact_peer_seq).toBe(1)
  })

  // -----------------------------------------------------------------------------------------
  // SYNTHESIS S2 (B's T3) — an inbound `step` with the peer's pause recorded and OURS NULL
  // applies, flips the turn, and clears `pact_peer_paused_at` (H3: a peer that steps has
  // provably resumed). RED at base: throws `pact_paused` (base's shared step|pause conjunct).
  // -----------------------------------------------------------------------------------------
  it("S2/H1+H3: an inbound step applies despite the peer's recorded pause, and clears it", () => {
    const d = freshDb()
    const { threadId, a, era } = engagedFederatedPactTurnOnPeer(d)
    const raw = rawDb(d)
    raw
      .prepare(`UPDATE threads SET pact_peer_paused_at = datetime('now') WHERE id = ?`)
      .run(threadId)

    const result = d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        messageId: 'msg_aaaaaaaaaaa5',
        body: 'stepping',
        pact: { verb: 'step', seq: 1, era }
      })
    )
    expect(result.accepted).toBe(true)

    const after = raw
      .prepare(
        'SELECT pact_peer_paused_at, pact_turn_agent_id, pact_ordinal FROM threads WHERE id = ?'
      )
      .get(threadId) as {
      pact_peer_paused_at: string | null
      pact_turn_agent_id: string
      pact_ordinal: number
    }
    expect(after.pact_peer_paused_at).toBeNull()
    expect(after.pact_turn_agent_id).toBe(a)
    expect(after.pact_ordinal).toBe(1)
  })

  // -----------------------------------------------------------------------------------------
  // SYNTHESIS S2 (B's T4, guard) — an inbound `step` while OUR `pact_paused_at` is set still
  // refuses `pact_paused` — the guard `step` keeps (only OUR column, never the peer's).
  // -----------------------------------------------------------------------------------------
  it('S2/H1 guard: an inbound step still refuses pact_paused while OUR pause is set', () => {
    const d = freshDb()
    const { threadId, a, era } = engagedFederatedPactTurnOnPeer(d)
    const raw = rawDb(d)
    raw.prepare(`UPDATE threads SET pact_paused_at = datetime('now') WHERE id = ?`).run(threadId)

    let caught: { code?: string } | undefined
    try {
      d.applyInboundPactVerb(
        inboundArgs({
          toAgentId: a,
          messageId: 'msg_aaaaaaaaaaa6',
          body: 'stepping',
          pact: { verb: 'step', seq: 1, era }
        })
      )
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe('pact_paused')
  })
})
