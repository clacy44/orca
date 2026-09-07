// S10-21b B6 (design §2.3, §2.11, §2.12; Ruling 34 Addendum 6(1)) — the shared federated-pact
// emit primitive, the in-flight guard's `step` wiring, and `propose`'s inbound era-adoption.
// Every test here fails at base 73984e659d: pact-federated-emit.ts / pact-federated-era.ts do
// not exist yet, appendPactStep has no federated branch, and proposePact never writes the
// pact_peer_* anchor columns.
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'

// 21b-D1: the real receiving schema — same lookup pattern as orchestration-federated-peer-
// send.test.ts's `method()` helper.
const FEDERATED_SEND_PARAMS = ORCHESTRATION_METHODS.find(
  (m) => m.name === 'orchestration.federatedSend'
)!.params!

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
  // S10-21b B17 (D-R137 F6): proposePact's era-reset/anchor UPDATE and the federated emit
  // primitive's ledger row/message/outbox row must be ONE transaction — a message-gate refusal
  // (or a crash) between the two must roll the whole transition back, not leave a
  // pact_state='proposed' row with zero pact_steps rows and no relay. RED at base: the base
  // implementation committed the UPDATE, then called `enqueueFederatedPactVerb` (its OWN
  // transaction) afterward — a refusal there left the thread proposed with no rows.
  // ---------------------------------------------------------------------------------------
  it('T-F6: a refusing message gate rolls the whole propose transition back — pact_state/era/anchors unchanged, no rows (RED at base)', async () => {
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
    const before = d.getThread(thread.id)

    const gateModule = await import('../../../shared/message-body-gate')
    const spy = vi
      .spyOn(gateModule, 'evaluateMessageBodyGate')
      .mockReturnValueOnce({ tier: 'hard', ruleIds: ['test-forced-refusal'] })
    try {
      expect(() =>
        d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
      ).toThrow()
    } finally {
      spy.mockRestore()
    }

    const after = d.getThread(thread.id)
    expect(after?.pact_state).toBe(before?.pact_state ?? null)
    expect(after?.pact_era).toBe(before?.pact_era ?? 0)
    expect(after?.pact_peer_agent_id).toBeNull()
    expect(after?.pact_peer_link_device_id).toBeNull()
    const stepRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ?`)
      .get(thread.id) as { n: number }
    expect(stepRows.n).toBe(0)
    const messageRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?`)
      .get(thread.id) as { n: number }
    expect(messageRows.n).toBe(0)
    const outboxRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE pact_thread_id = ?`)
      .get(thread.id) as { n: number }
    expect(outboxRows.n).toBe(0)
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
    // SCENARIO_CORRECTION (S10-21b B6c): was `toBe(1)` — `engagedFederatedPact`'s own
    // `d.proposePact(...)` now relays a real `propose` (this commit wires it through the same
    // emit primitive), consuming seq 1 itself; this step is the SECOND relayed verb, seq 2.
    expect(result.thread.pact_local_seq).toBe(2)
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

  // ---------------------------------------------------------------------------------------
  // 21b-D1 (F1-F4): the emitted outbox payload must conform to FederatedSendParams — the
  // schema the pump's verbatim dial (reply-outbox-pump.ts:135-147) parses against.
  // ---------------------------------------------------------------------------------------
  it('21b-D1: the emitted payload parses as FederatedSendParams (toAgentId/messageId/subject present)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const result = enqueueFederatedPactVerb(rawDb(d), null, threadId, 'step', {
      actorAgentId: a,
      actorPaneKey: `tab:${a}`,
      actorHostId: 'local',
      runId: 'run1',
      ordinal: 1
    })
    if (result.outcome !== 'enqueued') {
      throw new Error(`unexpected outcome: ${result.outcome}`)
    }
    const item = d.getReplyOutboxItem(result.outboxId)
    if (!item) {
      throw new Error('outbox item not found')
    }
    const parsed = JSON.parse(item.payload)
    const verdict = FEDERATED_SEND_PARAMS.safeParse(parsed)
    expect(verdict.success).toBe(true)
    expect(parsed.toAgentId).toBe(REMOTE_AGENT_ID)
    expect(parsed.messageId).toBe(result.message.id)
    expect(parsed.subject).toBe(`pact step`)
    expect(parsed.type).toBe('status')
    expect(parsed.priority).toBe('normal')
    // `pact` is byte-identical to the pre-fix shape: verb/seq/era only for a plain `step`.
    expect(parsed.pact).toEqual({ verb: 'step', seq: result.seq, era: result.era })
  })

  it('21b-D1: fromAgent mirrors buildFederatedSenderIdentity for the local actor', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const result = enqueueFederatedPactVerb(rawDb(d), null, threadId, 'step', {
      actorAgentId: a,
      actorPaneKey: `tab:${a}`,
      actorHostId: 'local',
      runId: 'run1',
      ordinal: 1
    })
    if (result.outcome !== 'enqueued') {
      throw new Error(`unexpected outcome: ${result.outcome}`)
    }
    const item = d.getReplyOutboxItem(result.outboxId)
    const parsed = JSON.parse(item!.payload)
    const agentRow = d.getAgentById(a)
    expect(parsed.fromAgent).toEqual({
      id: a,
      displayName: agentRow?.display_name,
      role: agentRow?.role,
      quarantined: false
    })
  })

  // S10-21b B6b (D-R134 A(xi) / D-R135 (xi), batch-2): field-parity between the pact envelope
  // (pact-federated-emit.ts ~339-352) and the mail literal (orchestration-reply-
  // foreign.ts:126-137) — same top-level field set excluding `body`/`inReplyToMessageId` (mail
  // only) and `pact` (pact only). Both reviews read this as ALREADY MATCHING at base (D-R135
  // (xi): "Confirmed... beside the mail literal's field-for-field shape") — this pins that
  // shape as a regression guard. GREEN AT BASE (the two literals already agree); it would go RED
  // only if a future edit to either literal drops/adds a shared field without the other.
  const MAIL_SHARED_FIELDS = [
    'fromAgent',
    'toAgentId',
    'messageId',
    'threadId',
    'subject',
    'type',
    'priority'
  ].sort()

  it("D-R134 A(xi)/D-R135 (xi): the pact envelope carries the mail literal's shared top-level field set", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const result = enqueueFederatedPactVerb(rawDb(d), null, threadId, 'step', {
      actorAgentId: a,
      actorPaneKey: `tab:${a}`,
      actorHostId: 'local',
      runId: 'run1',
      ordinal: 1
    })
    if (result.outcome !== 'enqueued') {
      throw new Error(`unexpected outcome: ${result.outcome}`)
    }
    const item = d.getReplyOutboxItem(result.outboxId)
    const parsed = JSON.parse(item!.payload) as Record<string, unknown>
    const envelopeSharedKeys = Object.keys(parsed)
      .filter((k) => k !== 'pact')
      .sort()
    expect(envelopeSharedKeys).toEqual(MAIL_SHARED_FIELDS)
  })

  it("D-R134 A(xi)/D-R135 (xi): a host-emitted verb omits fromAgent, matching mail's unregistered-caller shape", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId, peerKey } = engagedFederatedPact(d, a)
    const result = enqueueFederatedPactVerb(rawDb(d), null, threadId, 'resync_request', {
      actorAgentId: null,
      actorPaneKey: null,
      actorHostId: null,
      runId: 'host',
      resyncRequest: { nonce: 'n1' }
    })
    if (result.outcome !== 'enqueued') {
      throw new Error(`unexpected outcome: ${result.outcome}`)
    }
    const item = d.getReplyOutboxItem(result.outboxId)
    const parsed = JSON.parse(item!.payload) as Record<string, unknown>
    expect('fromAgent' in parsed).toBe(false)
    const envelopeSharedKeys = Object.keys(parsed)
      .filter((k) => k !== 'pact')
      .sort()
    expect(envelopeSharedKeys).toEqual(MAIL_SHARED_FIELDS.filter((k) => k !== 'fromAgent'))
    // D-R135 F14 fix (B6b): a host-emitted verb (no actor) addresses the PEER, never our own
    // proposer key — `a` proposed this pact (engagedFederatedPact), so the stored to_handle
    // must be the remote peer's rendered key. RED AT BASE: otherPactParticipant(thread, '')
    // always fell through to pact_proposer_agent_id, i.e. `a` itself.
    expect(result.message.to_handle).toBe(peerKey)
    expect(result.message.to_handle).not.toBe(a)
  })
})

// ---------------------------------------------------------------------------------------
// S10-21b B6c (design §2.3, ruling 21b-E7) — the remaining local arms B6/B15 left unwired:
// propose, accept, decline, release. Every test here fails at base 7298dca7dd: proposePact/
// acceptPact/releasePactRow write their own local ledger row directly on a federated pact and
// never call enqueueFederatedPactVerb, so no peer_reply_outbox row exists for any of these
// four verbs (only `step`, B15's pause/resume, and B10's auto-decline call the primitive).
// ---------------------------------------------------------------------------------------
describe('S10-21b B6c: propose/accept/decline/release route through enqueueFederatedPactVerb', () => {
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

  const ENV2 = 'env_b6c'
  const REMOTE_AGENT_ID2 = 'peer_b6c'

  function seedFederatedPeer2(d: OrchestrationDb): string {
    d.upsertRemoteAgent({
      environmentId: ENV2,
      environmentName: ENV2,
      linkKind: 'environment',
      remoteAgentId: REMOTE_AGENT_ID2,
      displayName: 'peer (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(d), {
      linkDeviceId: ENV2,
      environmentId: ENV2,
      boundEndpointId: 'endpoint_b6c',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_b6c',
      peerCredentialFp: 'pcfp_b6c',
      peerKeyFingerprint: 'pkfp_b6c',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    return renderFederatedPartyKey({ linkDeviceId: ENV2, remoteAgentId: REMOTE_AGENT_ID2 })
  }

  // Forces a federated pact straight to 'proposed' with the LOCAL agent as `pact_with_agent_id`
  // (the answering side) — the shape acceptPact/declinePact both require.
  function proposedToLocal(d: OrchestrationDb, a: string, peerKey: string): { threadId: string } {
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_peer_agent_id = ?, pact_peer_link_device_id = ?, pact_peer_environment_id = ?
         WHERE id = ?`
      )
      .run(peerKey, a, REMOTE_AGENT_ID2, ENV2, ENV2, thread.id)
    return { threadId: thread.id }
  }

  // -------------------------------------------------------------------------------------
  // Item 1 — proposePact: RED at base (no outbox row, no relayed message).
  // -------------------------------------------------------------------------------------
  it('item 1: proposePact (federated) is the single writer — one outbox row, one pact_steps row, a real message', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer2(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    const raw = rawDb(d)

    const proposed = d.proposePact({
      ...actor(a),
      threadId: thread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    expect(proposed.pact_state).toBe('proposed')
    expect(proposed.pact_local_seq).toBe(1)

    const outboxRow = raw
      .prepare(`SELECT relay_kind, pact_seq FROM peer_reply_outbox WHERE pact_thread_id = ?`)
      .get(thread.id) as { relay_kind: string; pact_seq: number } | undefined
    expect(outboxRow).toEqual({ relay_kind: 'pact_propose', pact_seq: 1 })

    const stepCount = raw
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'propose'`)
      .get(thread.id) as { n: number }
    expect(stepCount.n).toBe(1)
    const stepRow = raw
      .prepare(`SELECT message_id FROM pact_steps WHERE thread_id = ? AND kind = 'propose'`)
      .get(thread.id) as { message_id: string | null }
    // The old local-only path always stored `messageId: null` — the single-writer primitive
    // stores the REAL relayed message id instead (the envelope contract requires messageId).
    expect(stepRow.message_id).not.toBeNull()
  })

  // -------------------------------------------------------------------------------------
  // Item 2 — acceptPact: RED at base. Turn is deferred to settle (accept is turn-consuming,
  // PACT_TURN_CONSUMING_VERBS), same shape as `step`.
  // -------------------------------------------------------------------------------------
  it('item 2: acceptPact (federated) is the single writer — turn deferred to settle, one pact_steps row', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer2(d)
    const { threadId } = proposedToLocal(d, a, peerKey)
    const raw = rawDb(d)

    const accepted = d.acceptPact({ ...actor(a), threadId })
    expect(accepted.pact_state).toBe('engaged')
    expect(accepted.pact_turn_in_flight_at).not.toBeNull()
    // `trg_pact_turn_membership` (db.ts, load-bearing) requires an engaged pact's turn to be a
    // valid participant the INSTANT pact_state becomes 'engaged' — unlike `step` (which never
    // touches pact_state), accept cannot defer this write to settle. The turn lands immediately;
    // `pact_turn_in_flight_at` still marks the relay unsettled, and settle's own (idempotent)
    // turn write is what clears it.
    expect(accepted.pact_turn_agent_id).toBe(peerKey)

    const outboxRow = raw
      .prepare(
        `SELECT relay_kind, pact_seq, pact_turn_after FROM peer_reply_outbox WHERE pact_thread_id = ?`
      )
      .get(threadId) as { relay_kind: string; pact_seq: number; pact_turn_after: string | null }
    expect(outboxRow.relay_kind).toBe('pact_accept')
    expect(outboxRow.pact_turn_after).toBe(peerKey) // settle re-applies the same value, clearing in-flight

    const stepCount = raw
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'accept'`)
      .get(threadId) as { n: number }
    expect(stepCount.n).toBe(1)
    const stepRow = raw
      .prepare(
        `SELECT message_id, turn_after_agent_id FROM pact_steps WHERE thread_id = ? AND kind = 'accept'`
      )
      .get(threadId) as { message_id: string | null; turn_after_agent_id: string | null }
    expect(stepRow.message_id).not.toBeNull()
    expect(stepRow.turn_after_agent_id).toBe(peerKey)
  })

  // -------------------------------------------------------------------------------------
  // Item 3 — releasePactRow: RED at base. `release` stamps pact_release_at locally and NEVER
  // pact_peer_release_at (N9); `decline` never stamps pact_release_at at all.
  // -------------------------------------------------------------------------------------
  it('item 3a: releasePact (federated, kind=release) stamps pact_release_at, never pact_peer_release_at', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer2(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    const raw = rawDb(d)
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    raw
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)

    const released = d.releasePact({
      ...actor(a),
      threadId: thread.id,
      reasonCode: null,
      evidence: 'suite run R-1'
    })
    expect(released.pact_state).toBe('released')
    expect(released.pact_release_at).not.toBeNull()
    expect(released.pact_peer_release_at).toBeNull()

    const outboxRow = raw
      .prepare(
        `SELECT relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_release'`
      )
      .get(thread.id) as { relay_kind: string } | undefined
    expect(outboxRow?.relay_kind).toBe('pact_release')

    const stepRow = raw
      .prepare(`SELECT summary FROM pact_steps WHERE thread_id = ? AND kind = 'release'`)
      .get(thread.id) as { summary: string | null } | undefined
    // --evidence rides in the ledger row's summary exactly as the local path stores it.
    expect(stepRow?.summary).toBe('suite run R-1')
    const stepCount = raw
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'release'`)
      .get(thread.id) as { n: number }
    expect(stepCount.n).toBe(1)
  })

  it('item 3b: declinePact (federated) relays kind=decline and never stamps pact_release_at', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer2(d)
    const { threadId } = proposedToLocal(d, a, peerKey)
    const raw = rawDb(d)

    const declined = d.declinePact({ ...actor(a), threadId, reasonCode: 'not_now' })
    expect(declined.pact_state).toBe('released')
    expect(declined.pact_release_at).toBeNull()
    expect(declined.pact_peer_release_at).toBeNull()

    const outboxRow = raw
      .prepare(
        `SELECT relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_decline'`
      )
      .get(threadId) as { relay_kind: string } | undefined
    expect(outboxRow?.relay_kind).toBe('pact_decline')

    const stepCount = raw
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'decline'`)
      .get(threadId) as { n: number }
    expect(stepCount.n).toBe(1)
  })
})
