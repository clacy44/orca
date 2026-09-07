// S10-21b B6b (chair ruling, errata 21b-E5, after B9c's STOP): the gap_notice suppression
// predicate. B9c's drainer clears `pact_relay_pending` on enqueue, so the token is transient
// (one pump tick) — suppression of a fresh mint must ALSO check for an unsettled
// ('queued'/'sending') peer_reply_outbox row with relay_kind = 'pact_gap_notice', or the window
// between drain and the row settling lets a fresh resync_request/gap_notice mint over a
// gap_notice that is still in flight. No TTL, no schema change (chair ruling).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { drainPendingRebindParty } from './pact-federated-rebind'
import { mintResyncRequestIfNeeded } from './pact-federated-repair'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('gap_notice suppression (errata 21b-E5)', () => {
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

  const ENV = 'env_gap_suppress'
  const REMOTE_AGENT_ID = 'peer_gap_suppress'

  // Engages a federated pact, then drives it through a real terminal-settle-style gap_notice
  // token set + drain — a REAL `pact_gap_notice` outbox row, not a hand-inserted one — so its
  // `state` reflects the emit primitive's own writes exactly.
  function engagedWithDrainedGapNotice(d: OrchestrationDb): {
    threadId: string
    raw: Database.Database
  } {
    const raw = rawDb(d)
    const a = seedAgent(d, 'holder')
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
    putPeerLinkBinding(raw, {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint_gap_suppress',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_gs',
      peerCredentialFp: 'pcfp_gs',
      peerKeyFingerprint: 'pkfp_gs',
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
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?,
           pact_relay_pending = 'gap_notice' WHERE id = ?`
      )
      .run(a, thread.id)

    // The real drain: enqueues one `pact_gap_notice` outbox row and clears the token — exactly
    // what a pump tick does (pact-federated-rebind.ts's drainGapNotice).
    const drained = drainPendingRebindParty(raw, null)
    if (drained !== 1) {
      throw new Error(`expected the drain to enqueue one gap_notice, got ${drained}`)
    }
    const tokenAfterDrain = raw
      .prepare('SELECT pact_relay_pending FROM threads WHERE id = ?')
      .get(thread.id) as { pact_relay_pending: string | null }
    if (tokenAfterDrain.pact_relay_pending !== null) {
      throw new Error('expected the token to be cleared by the drain')
    }
    return { threadId: thread.id, raw }
  }

  function outboxRowState(raw: Database.Database, threadId: string): string {
    const row = raw
      .prepare(
        `SELECT state FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_gap_notice'`
      )
      .get(threadId) as { state: string } | undefined
    if (!row) {
      throw new Error('expected a pact_gap_notice outbox row')
    }
    return row.state
  }

  // (a) — token drained, and the gap_notice row has since SETTLED (delivered). GREEN AT BASE,
  // honestly: base only ever checked the (already-cleared) token, so a later gap already minted
  // here too — this scenario was never the bug.
  it('(a) token drained + gap_notice row settled (delivered): a later gap mints a fresh resync_request', () => {
    const d = freshDb()
    const { threadId, raw } = engagedWithDrainedGapNotice(d)
    expect(outboxRowState(raw, threadId)).toBe('queued')
    raw
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'delivered' WHERE pact_thread_id = ? AND relay_kind = 'pact_gap_notice'`
      )
      .run(threadId)

    const minted = mintResyncRequestIfNeeded(raw, threadId)
    expect(minted).toBe(true)
    const after = raw
      .prepare('SELECT pact_resync_nonce FROM threads WHERE id = ?')
      .get(threadId) as { pact_resync_nonce: string | null }
    expect(after.pact_resync_nonce).not.toBeNull()
  })

  // (b) — token drained, gap_notice row still UNSETTLED (still 'queued', in flight). RED AT
  // BASE: only `pact_relay_pending === 'gap_notice'` was checked, and the drain already cleared
  // it, so base wrongly mints a second, redundant resync_request over a gap_notice that hasn't
  // even been delivered yet.
  it('(b) token drained, gap_notice row still unsettled (queued): a gap does NOT mint', () => {
    const d = freshDb()
    const { threadId, raw } = engagedWithDrainedGapNotice(d)
    expect(outboxRowState(raw, threadId)).toBe('queued')

    const minted = mintResyncRequestIfNeeded(raw, threadId)
    expect(minted).toBe(false)
    const after = raw
      .prepare('SELECT pact_resync_nonce FROM threads WHERE id = ?')
      .get(threadId) as { pact_resync_nonce: string | null }
    expect(after.pact_resync_nonce).toBeNull()
  })

  // 'sending' (claimed by the pump, not yet delivered) is unsettled too.
  it('(b) token drained, gap_notice row claimed (sending): a gap does NOT mint', () => {
    const d = freshDb()
    const { threadId, raw } = engagedWithDrainedGapNotice(d)
    raw
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'sending' WHERE pact_thread_id = ? AND relay_kind = 'pact_gap_notice'`
      )
      .run(threadId)

    expect(mintResyncRequestIfNeeded(raw, threadId)).toBe(false)
  })

  // Guard (existing behaviour, unaffected by this fix): a re-propose still clears the token —
  // proposePact's own reset list (pact-propose-accept.ts) never included pact_relay_pending in
  // the "must never reset" exclusion list, unlike pact_flight_token. GREEN AT BASE.
  it('guard: a re-propose clears pact_relay_pending', () => {
    const d = freshDb()
    const { threadId, raw } = engagedWithDrainedGapNotice(d)
    raw.prepare(`UPDATE threads SET pact_relay_pending = 'gap_notice' WHERE id = ?`).run(threadId)
    const a = raw
      .prepare('SELECT pact_proposer_agent_id FROM threads WHERE id = ?')
      .get(threadId) as { pact_proposer_agent_id: string }

    d.releasePact({ ...actor(a.pact_proposer_agent_id), threadId, reasonCode: null })
    const b = seedAgent(d, 'other')
    d.proposePact({
      ...actor(a.pact_proposer_agent_id),
      threadId,
      peerAgentId: b,
      stepsTotal: null
    })
    const after = raw
      .prepare('SELECT pact_relay_pending FROM threads WHERE id = ?')
      .get(threadId) as { pact_relay_pending: string | null }
    expect(after.pact_relay_pending).toBeNull()
  })

  // NOTE on cancelPactTailAndPauseBody's own arm (~:266, the same shape added there): its step 2

  // (this same function, above the fresh-nonce gate) unconditionally cancels every
  // 'queued'/'sending' row for the pact — including any prior gap_notice — before the gate ever
  // runs, inside the SAME transaction (no concurrent writer can land between them, BEGIN
  // IMMEDIATE). So by the time that arm's `hasUnsettledGapNoticeOutbox` check executes, no
  // unsettled gap_notice row for THIS pact can exist through `cancelPactTailAndPause`'s own
  // public entry — the added check there cannot be exercised red-vs-green through that path
  // today; it is added for shape-parity with mintResyncRequestIfNeeded (chair ruling 21b-E5:
  // "the two suppression predicates") and as a defensive backstop if step 2's ordering ever
  // changes. Not testable as a red-at-base regression through the public API; left unasserted
  // rather than writing a test against an unreachable branch.
})

// D-R136 N4 — firePactTerminalSettleDisposition must guard on (era, state) exactly as the
// delivery settle does (settle.ts), or a relay queued under a stale era pauses/tail-cancels a
// freshly re-proposed pact it has nothing to do with.
describe('D-R136 N4: firePactTerminalSettleDisposition is era/state-guarded', () => {
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

  const ENV = 'env_n4'
  const REMOTE_AGENT_ID = 'peer_n4'

  function engagedFederatedPactWithQueuedStep(d: OrchestrationDb): {
    threadId: string
    a: string
    outboxId: string
  } {
    const raw = rawDb(d)
    const a = seedAgent(d, 'a')
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
    putPeerLinkBinding(raw, {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint_n4',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_n4',
      peerCredentialFp: 'pcfp_n4',
      peerKeyFingerprint: 'pkfp_n4',
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
    // S10-21b B6c: proposePact now relays for real (its own outbox row, seq 1) — remove it so
    // the claim below (this fixture's own subject: the STEP's outbox row) selects the row THIS
    // helper's caller actually wants, not the propose relay ahead of it in queue order.
    raw
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    raw
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    const result = d.appendPactStep({ ...actor(a), threadId: thread.id, done: 'x', runId: 'r1' })
    if (result.outcome === 'refused') {
      throw new Error('unexpected refusal')
    }
    const item = d.getReplyOutboxItemByLocalMessageId(result.message.id)
    if (!item) {
      throw new Error('outbox item missing')
    }
    const claimed = d.claimNextReplyOutboxItem(Date.now())
    if (!claimed || claimed.id !== item.id) {
      throw new Error('claim did not select the expected outbox row')
    }
    return { threadId: thread.id, a, outboxId: item.id }
  }

  // RED at base: the terminal settle has no era/state guard — it cancels/pauses the BRAND-NEW
  // era's pact even though the settling item belongs to the era that was just released.
  it('a relay queued under a released era does not cancel/pause the freshly re-proposed pact', () => {
    const d = freshDb()
    const { threadId, a, outboxId } = engagedFederatedPactWithQueuedStep(d)
    const item = d.getReplyOutboxItem(outboxId)
    if (!item) {
      throw new Error('outbox item missing')
    }

    // Release, then re-propose — a fresh era, unrelated to the item still in flight.
    d.releasePact({ ...actor(a), threadId, reasonCode: null })
    const other = seedAgent(d, 'other')
    d.proposePact({ ...actor(a), threadId, peerAgentId: other, stepsTotal: null })
    const reproposed = d.getThread(threadId)
    expect(reproposed?.pact_era).not.toBe(item.pactEra)

    const outcome = d.firePactTerminalSettleDisposition(
      item,
      'pact_relay_failed',
      'transport failure',
      Date.now()
    )
    expect(outcome.outcome).toBe('settled')

    // The freshly re-proposed pact must be untouched: still proposed, not paused, no tail
    // cancelled (there is nothing queued for the NEW era to cancel).
    const after = d.getThread(threadId)
    expect(after?.pact_state).toBe('proposed')
    expect(after?.pact_paused_at).toBeNull()
    expect(after?.pact_era).toBe(reproposed?.pact_era)
  })
})

// D-R136 N7 — the gap_notice drain must not double-emit across a crash between the enqueue's own
// commit and the token-clear UPDATE.
describe('D-R136 N7: the gap_notice drain excludes a thread with an already-unsettled row', () => {
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

  const ENV = 'env_n7'
  const REMOTE_AGENT_ID = 'peer_n7'

  // RED at base: the SELECT has no NOT EXISTS guard, so a thread whose token got re-set to
  // 'gap_notice' (simulating a crash between the enqueue commit and the token clear, then a
  // second cause re-flagging it) while an unsettled row from the FIRST drain is still queued
  // enqueues a SECOND gap_notice on the very next tick.
  it('a thread with an unsettled pact_gap_notice row is excluded from the next drain tick', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const a = seedAgent(d, 'holder')
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
    putPeerLinkBinding(raw, {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint_n7',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_n7',
      peerCredentialFp: 'pcfp_n7',
      peerKeyFingerprint: 'pkfp_n7',
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
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?,
           pact_relay_pending = 'gap_notice' WHERE id = ?`
      )
      .run(a, thread.id)

    // First tick: real drain, enqueues one row, clears the token.
    const firstDrain = drainPendingRebindParty(raw, null)
    expect(firstDrain).toBe(1)
    const rowCountAfterFirst = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_gap_notice'`
      )
      .get(thread.id) as { n: number }
    expect(rowCountAfterFirst.n).toBe(1)

    // Simulate a second terminal-settle disposition re-flagging the token while the first
    // gap_notice row is still unsettled ('queued') — the crash-window shape N7 describes.
    raw.prepare(`UPDATE threads SET pact_relay_pending = 'gap_notice' WHERE id = ?`).run(thread.id)

    const secondDrain = drainPendingRebindParty(raw, null)
    expect(secondDrain).toBe(0)
    const rowCountAfterSecond = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_gap_notice'`
      )
      .get(thread.id) as { n: number }
    expect(rowCountAfterSecond.n).toBe(1)
  })
})

// D-R139 N2 — the era-reset tail cancel must be kind-scoped: a queued `pact_release` the peer
// still needs must survive a re-propose on the same thread.
describe('D-R139 N2: the era-reset tail cancel is kind-scoped', () => {
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

  const ENV = 'env_n2'
  const REMOTE_AGENT_ID = 'peer_n2'

  it('release queued on a downed link, re-propose → the pact_release row survives (RED at base: cancelled)', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const a = seedAgent(d, 'a')
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
    putPeerLinkBinding(raw, {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint_n2',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_n2',
      peerCredentialFp: 'pcfp_n2',
      peerKeyFingerprint: 'pkfp_n2',
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
    raw
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    raw
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)

    // Release — relays a `pact_release`; the link is down, so the pump never drains it, leaving
    // the row 'queued'.
    d.releasePact({ ...actor(a), threadId: thread.id, reasonCode: null })
    const releaseRow = raw
      .prepare(
        `SELECT id, state FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_release'`
      )
      .get(thread.id) as { id: string; state: string } | undefined
    if (!releaseRow) {
      throw new Error('expected a queued pact_release row')
    }
    expect(releaseRow.state).toBe('queued')

    // Re-propose on the same thread — requireUnclaimedPact permits a `released` pact.
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })

    const afterRepropose = raw
      .prepare(`SELECT state, last_error_code FROM peer_reply_outbox WHERE id = ?`)
      .get(releaseRow.id) as { state: string; last_error_code: string | null }
    expect(afterRepropose.state).toBe('queued')
    expect(afterRepropose.last_error_code).not.toBe('pact_tail_cancelled')
  })
})
