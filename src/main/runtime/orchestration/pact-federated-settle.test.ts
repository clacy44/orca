// S10-21b B7 (design §2.8, Ruling 34 Addendum 6(4)) — the federated settle path: one guarded
// transaction on (id, era, state, flight token), the checked settleReplyOutboxItem boolean, and
// settle_stale/settle_raced. Every test here fails at base dc5590ead8:
// pact-federated-settle.ts / db.settleFederatedPactDelivery do not exist yet.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import type { AgentAuditRow } from './types'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('pact-federated-settle', () => {
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

  // Same construction as pact-federated-emit.test.ts's own helper (B8's inbound accept apply
  // isn't built yet) — forces an engaged federated pact with the local caller holding the turn.
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
    // S10-21b B6c: proposePact now relays for real (its own outbox row, seq 1) — settle it
    // out of the way here so this fixture's later claim/count assertions (this file's own
    // subject: the SETTLE path, not propose) see only the row THEY create.
    rawDb(d)
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    rawDb(d)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    return { threadId: thread.id, peerKey }
  }

  function pactStepRelay(
    d: OrchestrationDb,
    threadId: string,
    messageId: string
  ): { relay_state: string | null; relay_settled_at: string | null } {
    return rawDb(d)
      .prepare(
        `SELECT relay_state, relay_settled_at FROM pact_steps WHERE thread_id = ? AND message_id = ?`
      )
      .get(threadId, messageId) as { relay_state: string | null; relay_settled_at: string | null }
  }

  function latestAudit(d: OrchestrationDb): AgentAuditRow {
    return rawDb(d)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as AgentAuditRow
  }

  // `claim` mirrors the real pump: a settle only ever runs against a claimed ('sending') row
  // (settleReplyOutboxItem's own guard is `state='sending' -> terminal`). T12's raced case
  // passes `claim: false` to leave the row 'queued' — the concurrent-cancel shape the guard
  // exists to catch (settleReplyOutboxItem then legitimately finds zero 'sending' rows).
  function emitStep(
    d: OrchestrationDb,
    a: string,
    threadId: string,
    claim: boolean = true
  ): { outboxId: string; messageId: string } {
    const result = d.appendPactStep({ ...actor(a), threadId, done: 'did it', runId: 'run1' })
    if (result.outcome === 'refused') {
      throw new Error('unexpected refusal')
    }
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    const stepRow = ledger.entries.find((e) => e.kind === 'step')
    if (!stepRow) {
      throw new Error('step ledger row missing')
    }
    const item = d.getReplyOutboxItemByLocalMessageId(result.message.id)
    if (!item) {
      throw new Error('outbox item missing')
    }
    if (claim) {
      const claimed = d.claimNextReplyOutboxItem(Date.now())
      if (!claimed || claimed.id !== item.id) {
        throw new Error('claim did not select the expected outbox row')
      }
    }
    return { outboxId: item.id, messageId: result.message.id }
  }

  // ---------------------------------------------------------------------------------------
  // T11 — a settle correctly clears pact_turn_in_flight_at and moves the turn (the SETTLE
  // half; the receiver-side pact_settling gate itself is commit 8's).
  // ---------------------------------------------------------------------------------------
  it('T11: settleFederatedPactDelivery clears the in-flight flag and moves the turn', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId, peerKey } = engagedFederatedPact(d, a)

    const { outboxId, messageId } = emitStep(d, a, threadId)
    const before = d.getThread(threadId)
    expect(before?.pact_turn_in_flight_at).not.toBeNull()
    expect(before?.pact_turn_agent_id).toBe(a) // deferred: still the caller pre-settle

    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    expect(item.pactTurnAfter).toBe(peerKey)

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('settled')
    if (settled.outcome !== 'settled') {
      throw new Error('expected settled')
    }
    // The turn moved to the remote party — never a local waiter to wake for THIS thread.
    expect(settled.turnHolderAgentId).toBeNull()

    const after = d.getThread(threadId)
    expect(after?.pact_turn_in_flight_at).toBeNull()
    expect(after?.pact_turn_agent_id).toBe(peerKey)

    const relay = pactStepRelay(d, threadId, messageId)
    expect(relay.relay_state).toBe('delivered')
    expect(relay.relay_settled_at).not.toBeNull()

    const outboxAfter = d.getReplyOutboxItem(outboxId)
    expect(outboxAfter?.state).toBe('delivered')
  })

  // ---------------------------------------------------------------------------------------
  // T12(a) — stale re-read: a different (era, state, flight token) landed between emit and
  // settle. No-op on the pact half; audited settle_stale; the outbox row still settles
  // delivered.
  // ---------------------------------------------------------------------------------------
  it('T12: a stale (era/state/flight-token) mismatch no-ops the pact half, audits settle_stale, still settles the outbox row', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const { outboxId, messageId } = emitStep(d, a, threadId)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    const turnBefore = d.getThread(threadId)?.pact_turn_agent_id

    // Simulate a release-during-flight landing between emit and settle: pact_state changes and
    // pact_flight_token bumps (design §2.8's own example of a flight-token-bumping change).
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_state = 'released', pact_flight_token = pact_flight_token + 1
          WHERE id = ?`
      )
      .run(threadId)

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('stale')

    // The pact half never ran: the turn-flip did not land, but N1 releases the in-flight marker
    // THIS item set (item.pactTurnAfter !== null) even on the stale branch — CORRECTED from
    // "not.toBeNull()": that asserted the pre-N1-fix stranded-marker bug this same delta
    // introduced (D-R136 N1 — see pact-federated-settle.ts's stale branch).
    const after = d.getThread(threadId)
    expect(after?.pact_turn_in_flight_at).toBeNull()
    expect(after?.pact_turn_agent_id).toBe(turnBefore)
    const relay = pactStepRelay(d, threadId, messageId)
    expect(relay.relay_state).not.toBe('delivered')

    // The outbox row still settled delivered.
    const outboxAfter = d.getReplyOutboxItem(outboxId)
    expect(outboxAfter?.state).toBe('delivered')

    const audit = latestAudit(d)
    expect(audit.verb).toBe('replyRelay')
    expect(audit.outcome).toBe('settle_stale')
  })

  // ---------------------------------------------------------------------------------------
  // T12(b) — settleReplyOutboxItem returning false (a concurrent cancel — here, the row was
  // never claimed to 'sending') rolls back the WHOLE settle, audited settle_raced; step 3's
  // deferred effect is provably absent, not merely the audit row present.
  // ---------------------------------------------------------------------------------------
  it('T12: settleReplyOutboxItem returning false rolls back the whole settle, audited settle_raced', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const { outboxId, messageId } = emitStep(d, a, threadId, false)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    // Never claimed to 'sending' (still 'queued') — settleReplyOutboxItem's guarded
    // `state='sending' -> terminal` UPDATE matches zero rows, exactly the concurrent-cancel
    // shape (e.g. resetMessages) the guard exists to catch.
    expect(item.state).toBe('queued')

    const turnBefore = d.getThread(threadId)
    const messageBefore = rawDb(d)
      .prepare(`SELECT peer_relayed_at FROM messages WHERE id = ?`)
      .get(messageId) as { peer_relayed_at: string | null }
    expect(messageBefore.peer_relayed_at).toBeNull()

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('raced')

    // Nothing landed: not the turn flip, not the ledger stamp, not even step 2's own write —
    // the whole transaction rolled back, including the statements that ran before the boolean
    // was known to be false.
    const after = d.getThread(threadId)
    expect(after?.pact_turn_in_flight_at).toBe(turnBefore?.pact_turn_in_flight_at)
    expect(after?.pact_turn_agent_id).toBe(turnBefore?.pact_turn_agent_id)
    const relay = pactStepRelay(d, threadId, messageId)
    expect(relay.relay_state).not.toBe('delivered')
    const messageAfter = rawDb(d)
      .prepare(`SELECT peer_relayed_at FROM messages WHERE id = ?`)
      .get(messageId) as { peer_relayed_at: string | null }
    expect(messageAfter.peer_relayed_at).toBeNull()
    const outboxAfter = d.getReplyOutboxItem(outboxId)
    expect(outboxAfter?.state).toBe('queued')

    const audit = latestAudit(d)
    expect(audit.verb).toBe('replyRelay')
    expect(audit.outcome).toBe('settle_raced')
  })

  // ---------------------------------------------------------------------------------------
  // S10-21b B6b (D-R134 F4 local half): pact_flight_token has no writer anywhere at base
  // outside the inbound apply path (B8c) — every LOCAL commit that changes pact_state or the
  // turn must bump it too, so the settle guard (step 1's re-read) can see it. This suite's own
  // pre-existing T12 test simulates staleness by hand-bumping the column directly (the token had
  // no real writer to call); these two exercise the REAL local writers instead.
  // ---------------------------------------------------------------------------------------

  // A local PAUSE between emit and settle changes NEITHER pact_era NOR pact_state (only
  // pact_paused_at/pact_pause_reason) — the ONE local staleness case the pre-existing state/era
  // comparison cannot see on its own. RED AT BASE: pausePact never bumped pact_flight_token, so
  // the guard's re-read matches the outbox row's stamped values and the settle wrongly proceeds
  // as fresh, moving the turn on a pact this host just paused.
  it('D-R134 F4 local half: a local pause between emit and settle is caught only via pact_flight_token — settle_stale', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const { outboxId, messageId } = emitStep(d, a, threadId)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    const turnBefore = d.getThread(threadId)?.pact_turn_agent_id

    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    // Confirms the premise: era/state are unchanged by a pause — only flight_token can catch it.
    const paused = d.getThread(threadId)
    expect(paused?.pact_era).toBe(item.pactEra)
    expect(paused?.pact_state).toBe(item.pactState)

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('stale')

    // N1: the marker still releases even though the pause is what made this settle stale —
    // CORRECTED from "not.toBeNull()" for the same reason as T12 above (D-R136 N1).
    const after = d.getThread(threadId)
    expect(after?.pact_turn_in_flight_at).toBeNull()
    expect(after?.pact_turn_agent_id).toBe(turnBefore)
    const relay = pactStepRelay(d, threadId, messageId)
    expect(relay.relay_state).not.toBe('delivered')

    const audit = latestAudit(d)
    expect(audit.outcome).toBe('settle_stale')
  })

  // D-R136 N1 — the stale settle must release the marker THIS item set (never just leave the
  // turn-flip undone), so B8c's pact_settling gate does not deadlock both sides forever.
  it('D-R136 N1: a stale settle releases the in-flight marker; a subsequent inbound step is not refused pact_settling', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId, peerKey } = engagedFederatedPact(d, a)

    const { outboxId } = emitStep(d, a, threadId)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    expect(item.pactTurnAfter).toBe(peerKey)

    // Any commit landing in the dial window bumps pact_flight_token (D-R134 F4's real writers —
    // a local pause/resume, or an inbound peer pause); the dial itself still succeeds.
    rawDb(d)
      .prepare(`UPDATE threads SET pact_flight_token = pact_flight_token + 1 WHERE id = ?`)
      .run(threadId)
    rawDb(d)
      .prepare(`UPDATE threads SET pact_peer_thread_id = ? WHERE id = ?`)
      .run('thr_aaaaaaaaaaa9', threadId)

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('stale')

    const after = d.getThread(threadId)
    expect(after?.pact_turn_in_flight_at).toBeNull()

    // RED at base: the stranded marker refuses pact_settling forever, since a delivered outbox
    // row never reaches a terminal settle to clear it any other way.
    let caught: { code?: string } | undefined
    try {
      d.applyInboundPactVerb({
        pairedDeviceId: ENV,
        senderAgentId: REMOTE_AGENT_ID,
        senderEnvironmentId: ENV,
        messageId: 'msg_aaaaaaaaaaa9',
        peerThreadId: 'thr_aaaaaaaaaaa9',
        toAgentId: a,
        body: 'did it',
        pact: { verb: 'step', seq: 1, era: after?.pact_era ?? 0 }
      })
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).not.toBe('pact_settling')
  })

  // The brief's own literal scenario (D-R134 F4 local half): a local RELEASE between emit and
  // settle. GREEN AT BASE, honestly — releasePactRow already changes pact_state
  // ('engaged' -> 'released'), which the pre-existing state comparison (unrelated to
  // pact_flight_token) already catches on its own; the new flight-token bump is redundant here,
  // not load-bearing. Kept as a guard: still asserts settle_stale, and additionally that
  // pact_flight_token moved (the new write actually ran).
  it('D-R134 F4 local half: a local release between emit and settle → settle_stale (state-comparison already caught this at base; flight_token now moves too)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const { outboxId, messageId } = emitStep(d, a, threadId)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    const tokenBefore = d.getThread(threadId)?.pact_flight_token ?? -1

    d.releasePact({ ...actor(a), threadId, reasonCode: null })
    const released = d.getThread(threadId)
    expect(released?.pact_state).toBe('released')
    expect(released?.pact_flight_token).toBe(tokenBefore + 1)

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('stale')

    const relay = pactStepRelay(d, threadId, messageId)
    expect(relay.relay_state).not.toBe('delivered')
    const audit = latestAudit(d)
    expect(audit.outcome).toBe('settle_stale')
  })

  // The settle's own turn flip (steps 3/4) must ALSO bump pact_flight_token, so a LATER settle's
  // guard can see this one landed. RED AT BASE: the turn-flip UPDATE never touched the column.
  it('D-R134 F4 local half: a fresh settle bumps pact_flight_token on its own turn flip', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const { outboxId } = emitStep(d, a, threadId)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }
    const before = d.getThread(threadId)?.pact_flight_token ?? -1

    const settled = d.settleFederatedPactDelivery(item, {
      peerMessageId: 'peer_m1',
      peerReplyThreadId: 'peer_t1'
    })
    expect(settled.outcome).toBe('settled')

    const after = d.getThread(threadId)?.pact_flight_token ?? -1
    expect(after).toBe(before + 1)
  })
})
