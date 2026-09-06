// S10-21b B6 (design §2.3, §2.11, §2.12; Ruling 34 Addendum 6(1)) — the shared federated-pact
// emit primitive, the in-flight guard's `step` wiring, and `propose`'s inbound era-adoption.
// Every test here fails at base 73984e659d: pact-federated-emit.ts / pact-federated-era.ts do
// not exist yet, appendPactStep has no federated branch, and proposePact never writes the
// pact_peer_* anchor columns.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import {
  enqueueFederatedPactVerb,
  PACT_RESERVED_VERBS,
  type FederatedPactEmitRuntime
} from './pact-federated-emit'
import { adoptEraOnInboundPropose } from './pact-federated-era'
import { REPLY_OUTBOX_PER_LINK_CAP, PACT_RESERVED_HEADROOM } from './link-binding-constants'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('pact-federated-emit', () => {
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

  function actor(agentId: string): {
    callerAgentId: string
    callerPaneKey: string | null
    callerHostId: string
  } {
    return { callerAgentId: agentId, callerPaneKey: `tab:${agentId}`, callerHostId: 'local' }
  }

  const ENV = 'env1'
  const REMOTE_AGENT_ID = 'rb'

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

  // Proposes a federated pact and forces it straight to 'engaged' with the local caller
  // holding the turn — the inbound `accept` apply is B8's territory (not built yet), so the
  // test brings the pact to an engaged state directly rather than through an RPC round trip.
  function engagedFederatedPact(
    d: OrchestrationDb,
    a: string
  ): { threadId: string; peerKey: string } {
    const peerKey = seedFederatedPeer(d)
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
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    return { threadId: thread.id, peerKey }
  }

  // ---------------------------------------------------------------------------------------
  // proposePact: federated anchor-column write (batch-1 review D-R133 F2 — closes the
  // half-formed federated pact window).
  // ---------------------------------------------------------------------------------------
  it('proposePact populates pact_peer_* anchors for a federated peer', () => {
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
    const proposed = d.proposePact({
      ...actor(a),
      threadId: thread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    expect(proposed.pact_peer_agent_id).toBe(REMOTE_AGENT_ID)
    expect(proposed.pact_peer_environment_id).toBe(ENV)
    expect(proposed.pact_peer_link_device_id).toBe(ENV)
    expect(proposed.pact_peer_key_fingerprint).toBe('pkfp')
  })

  it('a re-propose against a LOCAL peer clears any stale federated anchor on the same thread row', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const { threadId } = engagedFederatedPact(d, a)
    d.releasePact({ ...actor(a), threadId, reasonCode: null })
    const relocal = d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    expect(relocal.pact_peer_agent_id).toBeNull()
  })

  // ---------------------------------------------------------------------------------------
  // T3 — `step` ⇒ pact_turn_in_flight_at set, turn NOT yet moved (emit half only, this commit).
  // ---------------------------------------------------------------------------------------
  it('T3: a federated step sets pact_turn_in_flight_at and leaves the turn column unmoved', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const before = d.getThread(threadId)
    expect(before?.pact_turn_in_flight_at).toBeNull()

    const result = d.appendPactStep({ ...actor(a), threadId, done: 'did the thing', runId: 'run1' })
    if (result.outcome === 'refused') {
      throw new Error('unexpected refusal')
    }
    expect(result.turn).toBe(a) // deferred flip: the caller still holds the turn
    expect(result.thread.pact_turn_agent_id).toBe(a) // column unchanged
    expect(result.thread.pact_turn_in_flight_at).not.toBeNull()
    expect(result.thread.pact_local_seq).toBe(1)
    expect(result.thread.pact_ordinal).toBe(1) // this host's own ledger progress DOES advance

    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    const stepRow = ledger.entries.find((e) => e.kind === 'step')
    expect(stepRow?.ordinal).toBe(1)
  })

  // ---------------------------------------------------------------------------------------
  // T26 companion: the in-flight flag this test sets is what pact-queries.test.ts's T26
  // exercises against getTurnsHeldBy — not duplicated here.
  // ---------------------------------------------------------------------------------------

  // ---------------------------------------------------------------------------------------
  // T20 — register (rebind_party) cannot fail on the outbox cap: the pact_relay_pending
  // fallback, exercised directly against the primitive with a simulated cap error.
  // ---------------------------------------------------------------------------------------
  it('T20: enqueueFederatedPactVerb falls back to pact_relay_pending=rebind on a full outbox, never throwing', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    expect(PACT_RESERVED_VERBS.has('rebind_party')).toBe(true)

    // Fill the reserved-headroom cap for this link with unrelated queued outbox rows so the
    // NEXT enqueue (any relay_kind, reserved or not) hits LinkBindingCapError.
    const raw = rawDb(d)
    const capTotal = REPLY_OUTBOX_PER_LINK_CAP + PACT_RESERVED_HEADROOM
    const insert = raw.prepare(
      `INSERT INTO peer_reply_outbox (
         id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
         peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
         peer_thread_id, local_thread_id, notice_run_id, notice_pane_key, payload, byte_count,
         state, attempts, consecutive_failures, hold_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '{}', 2, 'queued', 0, 0, 0, ?)`
    )
    for (let i = 0; i < capTotal; i++) {
      insert.run(
        `filler_${i}`,
        i + 1,
        `msg_filler_${i}`,
        ENV,
        ENV,
        1,
        'pcfp',
        'pkfp',
        `msg_filler_${i}`,
        REMOTE_AGENT_ID,
        Date.now()
      )
    }

    const runtime: FederatedPactEmitRuntime = { replyOutbox: { kick: () => {} } }
    const result = enqueueFederatedPactVerb(raw, runtime, threadId, 'rebind_party', {
      actorAgentId: null,
      actorPaneKey: null,
      actorHostId: null,
      runId: 'run1',
      rebind: { oldAgentId: 'old_remote_agent' }
    })
    expect(result.outcome).toBe('relay_pending')
    if (result.outcome !== 'relay_pending') {
      throw new Error('expected relay_pending')
    }
    expect(result.pendingToken).toBe('rebind')
    expect(result.thread.pact_relay_pending).toBe('rebind')
  })

  // ---------------------------------------------------------------------------------------
  // T5 (rewritten — N1) — the era-adoption+seq-reset function, exercised directly.
  // ---------------------------------------------------------------------------------------
  it('T5: adoptEraOnInboundPropose adopts the sender era and resets both seq counters', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [{ participantKey: a, agentId: a }]
    })
    const raw = rawDb(d)
    // A fresh receiver: pact_era = 0 (schema default), and non-zero seq counters left over from
    // some prior local pact activity on this row — the reset must clear both regardless.
    raw
      .prepare(`UPDATE threads SET pact_local_seq = 7, pact_peer_seq = 3 WHERE id = ?`)
      .run(thread.id)
    const eraOf = (id: string): number =>
      (raw.prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(id) as { pact_era: number })
        .pact_era
    expect(eraOf(thread.id)).toBe(0)

    adoptEraOnInboundPropose(raw, { id: thread.id }, { era: 1 })

    const after = d.getThread(thread.id)
    expect(eraOf(thread.id)).toBe(1)
    expect(after?.pact_local_seq).toBe(0)
    expect(after?.pact_peer_seq).toBe(0)
  })

  it('T5: a second adoption (re-propose after release) moves the era again and re-resets seq', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [{ participantKey: a, agentId: a }]
    })
    const raw = rawDb(d)
    adoptEraOnInboundPropose(raw, { id: thread.id }, { era: 1 })
    raw
      .prepare(`UPDATE threads SET pact_local_seq = 5, pact_peer_seq = 5 WHERE id = ?`)
      .run(thread.id)
    adoptEraOnInboundPropose(raw, { id: thread.id }, { era: 2 })
    const after = d.getThread(thread.id)
    const era = (
      raw.prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(thread.id) as {
        pact_era: number
      }
    ).pact_era
    expect(era).toBe(2)
    expect(after?.pact_local_seq).toBe(0)
    expect(after?.pact_peer_seq).toBe(0)
  })
})
