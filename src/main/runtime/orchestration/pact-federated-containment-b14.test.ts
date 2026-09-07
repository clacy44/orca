// S10-21b B14 (design §4.4, §4.5, §4.6, errata NB6/NB7/NB8) — containment: resetAll ordering
// fix, remote pause arms, per-pact cap + per-link ceiling with retention exemption, agent_rate
// proposal block. Every test here FAILS AT BASE a725bedda3: the remote arms in
// pauseConditionCleared do not exist, resetAll neither settles federated pacts nor deletes
// pact_applied_ids, no per-pact-cap auto-pause/ceiling/purge/proposal-block code exists yet.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import { PACT_STEPS_PER_PACT_CAP } from './pact-federated-inbound-gates'
import { PACT_STEPS_PER_LINK_CEILING } from './link-binding-constants'
import { pausePact } from './pact-lifecycle'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_b14'

describe('S10-21b B14 containment', () => {
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

  function seedFederatedPeer(d: OrchestrationDb, remoteAgentId: string, name: string): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId,
      displayName: name,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(d), {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: `endpoint_${remoteAgentId}`,
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
    return renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId })
  }

  function engagedFederatedPact(
    d: OrchestrationDb,
    a: string,
    remoteAgentId: string,
    name: string
  ): { threadId: string; peerKey: string } {
    const peerKey = seedFederatedPeer(d, remoteAgentId, name)
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

  function hostPauseRow(threadId: string, reasonCode: string): void {
    rawDb(db!)
      .prepare(
        `INSERT INTO pact_steps
           (thread_id, ordinal, kind, actor_agent_id, actor_pane_key, actor_host_id, message_id,
            summary, summary_sha256, turn_after_agent_id, reason_code, actor_is_remote)
         VALUES (?, 0, 'pause', NULL, NULL, NULL, NULL, NULL, '', NULL, ?, 0)`
      )
      .run(threadId, reasonCode)
  }

  function insertRemoteSteps(threadId: string, count: number, environmentId = ENV): void {
    const raw = rawDb(db!)
    const maxOrdinal = raw
      .prepare(`SELECT COALESCE(MAX(ordinal), 0) AS m FROM pact_steps WHERE thread_id = ?`)
      .get(threadId) as { m: number }
    const eraRow = raw.prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(threadId) as
      | { pact_era: number }
      | undefined
    const insert = raw.prepare(
      `INSERT INTO pact_steps
         (thread_id, ordinal, pact_era, kind, actor_agent_id, actor_pane_key, actor_host_id,
          message_id, summary, summary_sha256, turn_after_agent_id, reason_code, actor_is_remote,
          actor_environment_id, relay_seq)
       VALUES (?, ?, ?, 'step', 'remote:x:y', NULL, NULL, NULL, NULL, '', NULL, NULL, 1, ?, ?)`
    )
    raw.exec('BEGIN')
    for (let i = 0; i < count; i++) {
      insert.run(threadId, maxOrdinal.m + i + 1, eraRow?.pact_era ?? 0, environmentId, i)
    }
    raw.exec('COMMIT')
  }

  // A federated `propose` is resolved (gate 10, `resolvePactThread`) either via an existing
  // `pact_peer_thread_id` mapping, or — for the FIRST propose on a thread — a fallback join
  // through `messages.peer_link_device_id`/`peer_thread_id`, since the two hosts share an
  // ordinary mail thread before any pact exists on it. Seed that minimal mapping row directly.
  function seedPeerThreadMapping(
    d: OrchestrationDb,
    threadId: string,
    peerThreadId: string,
    peerKey: string
  ): void {
    rawDb(d)
      .prepare(
        `INSERT INTO messages (id, from_handle, to_handle, subject, thread_id, peer_link_device_id, peer_thread_id)
         VALUES (?, ?, 'host', 's', ?, ?, ?)`
      )
      .run(`msg_seed_${threadId}`, peerKey, threadId, ENV, peerThreadId)
  }

  function expectErrorCode(fn: () => unknown, code: string): void {
    let threw = false
    try {
      fn()
    } catch (err) {
      threw = true
      expect((err as { code?: string }).code).toBe(code)
    }
    expect(threw).toBe(true)
  }

  function inboundArgs(
    overrides: Partial<ApplyInboundPactVerbArgs> & {
      toAgentId: string
      senderAgentId: string
      peerThreadId: string | null
    }
  ): ApplyInboundPactVerbArgs {
    return {
      pairedDeviceId: ENV,
      senderEnvironmentId: ENV,
      messageId: 'msg_aaaaaaaaaaa1',
      body: undefined,
      pact: { verb: 'step', seq: 1, era: 0 },
      ...overrides
    }
  }

  // -----------------------------------------------------------------------------------------
  // T14 — pauseConditionCleared's remote arm.
  // -----------------------------------------------------------------------------------------
  it('T14: a counterpart_quarantined pause on a federated pact refuses --resume while the mirror is quarantined, and clears once lifted', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'r14', 'peer14')
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_paused_at = datetime('now'), pact_pause_reason = 'counterpart_quarantined' WHERE id = ?`
      )
      .run(threadId)
    hostPauseRow(threadId, 'counterpart_quarantined')
    rawDb(d)
      .prepare(
        `UPDATE remote_agents SET local_quarantined = 1 WHERE environment_id = ? AND remote_agent_id = 'r14'`
      )
      .run(ENV)

    let threw = false
    try {
      d.resumePactOrRequest({ ...actor(a), threadId })
    } catch (err) {
      threw = true
      expect((err as { code?: string }).code).toBe('pact_paused')
    }
    expect(threw).toBe(true)

    rawDb(d)
      .prepare(
        `UPDATE remote_agents SET local_quarantined = 0 WHERE environment_id = ? AND remote_agent_id = 'r14'`
      )
      .run(ENV)
    const outcome = d.resumePactOrRequest({ ...actor(a), threadId })
    expect(outcome.kind).toBe('resumed')
  })

  // -----------------------------------------------------------------------------------------
  // T15 — resetAll's federated-pact settlement + the corrected reserved-release ordering.
  // -----------------------------------------------------------------------------------------
  it('T15: resetAll releases a live federated pact locally BEFORE remote_agents is deleted, and queues ONE reserved release AFTER the outbox delete', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'r15', 'peer15')

    d.resetAll()

    const thread = d.getThread(threadId)
    expect(thread?.pact_state).toBe('released')
    expect(thread?.pact_peer_agent_id).toBeNull()

    const releaseRow = rawDb(d)
      .prepare(
        `SELECT reason_code, actor_is_remote FROM pact_steps WHERE thread_id = ? AND kind = 'release'`
      )
      .get(threadId) as { reason_code: string; actor_is_remote: number } | undefined
    expect(releaseRow?.reason_code).toBe('local_reset')
    expect(releaseRow?.actor_is_remote).toBe(0)

    const outboxRows = rawDb(d)
      .prepare(`SELECT payload FROM peer_reply_outbox WHERE local_thread_id = ?`)
      .all(threadId) as { payload: string }[]
    expect(outboxRows.length).toBe(1)
    const payload = JSON.parse(outboxRows[0].payload) as { pact: { verb: string } }
    expect(payload.pact.verb).toBe('release')
  })

  // -----------------------------------------------------------------------------------------
  // S10-21b B17 (D-R137 F9) — a message-gate refusal on the reserved-release emit must still
  // leave the pact locally released with `pact_release_at` stamped (the retention purge arm's
  // load-bearing column), never a pact that reads 'released' but is permanently unpurgeable.
  // RED at base: the base implementation discarded the emit result — no ledger row,
  // `pact_release_at` stays NULL forever on a refused emit.
  // -----------------------------------------------------------------------------------------
  it('F9: resetAll falls back to a local release when the reserved-release relay is gate-refused (RED at base)', async () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'r9f9', 'peer9f9')

    const gateModule = await import('../../../shared/message-body-gate')
    const spy = vi
      .spyOn(gateModule, 'evaluateMessageBodyGate')
      .mockReturnValue({ tier: 'hard', ruleIds: ['test-forced-refusal'] })
    try {
      d.resetAll()
    } finally {
      spy.mockRestore()
    }

    const thread = d.getThread(threadId)
    expect(thread?.pact_state).toBe('released')
    expect(thread?.pact_release_at).not.toBeNull()

    const releaseRow = rawDb(d)
      .prepare(
        `SELECT reason_code, actor_is_remote FROM pact_steps WHERE thread_id = ? AND kind = 'release'`
      )
      .get(threadId) as { reason_code: string; actor_is_remote: number } | undefined
    expect(releaseRow?.reason_code).toBe('local_reset')
  })

  // -----------------------------------------------------------------------------------------
  // S10-21b B21 (D-D3-A item 7, T2) — guard, pre-existing: a second `pausePact` while the
  // first row is still `queued` coalesces (21b-E7a) — one unsettled pause/resume row, seq
  // unchanged by the replacement.
  // -----------------------------------------------------------------------------------------
  it('T2: a second pausePact while the first is still queued leaves one row and an unchanged seq', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'r10t2', 'peer10t2')
    const raw = rawDb(d)

    pausePact(raw, {
      callerAgentId: a,
      callerPaneKey: `tab:${a}`,
      callerHostId: 'local',
      threadId,
      reasonCode: 'counterpart_gone'
    })
    const afterFirst = d.getThread(threadId)
    const seqAfterFirst = afterFirst!.pact_local_seq
    const outboxIdAfterFirst = (
      raw
        .prepare(
          `SELECT id FROM peer_reply_outbox
             WHERE local_thread_id = ? AND state = 'queued' AND relay_kind IN ('pact_pause', 'pact_resume')`
        )
        .all(threadId) as { id: string }[]
    ).map((r) => r.id)
    expect(outboxIdAfterFirst).toHaveLength(1)

    // A second pause while the pact is already paused re-emits (pausePact has no
    // already-paused guard, D-D3-A EVIDENCE) — the coalescer must still leave exactly one row.
    pausePact(raw, {
      callerAgentId: a,
      callerPaneKey: `tab:${a}`,
      callerHostId: 'local',
      threadId,
      reasonCode: 'counterpart_gone'
    })
    const afterSecond = d.getThread(threadId)
    const outboxIdsAfterSecond = (
      raw
        .prepare(
          `SELECT id FROM peer_reply_outbox
             WHERE local_thread_id = ? AND state = 'queued' AND relay_kind IN ('pact_pause', 'pact_resume')`
        )
        .all(threadId) as { id: string }[]
    ).map((r) => r.id)
    expect(outboxIdsAfterSecond).toEqual(outboxIdAfterFirst)
    expect(afterSecond?.pact_local_seq).toBe(seqAfterFirst)
  })

  // -----------------------------------------------------------------------------------------
  // T10 — no repair loop after resetAll: the peer's next verb gets pact_no_pact terminal, no
  // gap_notice queued; the reserved release from T15 is the peer's only path to learn of it.
  // -----------------------------------------------------------------------------------------
  it("T10: after resetAll, the peer's next verb is refused pact_no_pact with nothing queued — the reserved release is the only signal", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId, peerKey } = engagedFederatedPact(d, a, 'r10', 'peer10')
    d.resetAll()

    expectErrorCode(
      () =>
        d.applyInboundPactVerb(
          inboundArgs({
            toAgentId: a,
            senderAgentId: 'r10',
            peerThreadId: threadId,
            pact: { verb: 'step', seq: 2, era: 0 }
          })
        ),
      'pact_no_pact'
    )

    const thread = d.getThread(threadId)
    expect(thread?.pact_relay_pending).toBeNull()

    const outboxRows = rawDb(d)
      .prepare(`SELECT relay_kind FROM peer_reply_outbox WHERE local_thread_id = ?`)
      .all(threadId) as { relay_kind: string }[]
    expect(outboxRows).toEqual([{ relay_kind: 'pact_release' }])
    void peerKey
  })

  // -----------------------------------------------------------------------------------------
  // T23 — per-pact cap isolates; purge era/current-era semantics.
  // -----------------------------------------------------------------------------------------
  it('T23: driving one pact past its cap auto-pauses ONLY that pact; purge frees prior-era rows but never current-era ones', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const { threadId: threadA } = engagedFederatedPact(d, a, 'r23a', 'peerA')
    const { threadId: threadB } = engagedFederatedPact(d, b, 'r23b', 'peerB')
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_turn_agent_id = 'remote:env_b14:r23a', pact_peer_thread_id = 'thr_aaaaaaaaaaa1' WHERE id = ?`
      )
      .run(threadA)
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_turn_agent_id = 'remote:env_b14:r23b', pact_peer_thread_id = 'thr_bbbbbbbbbbb1' WHERE id = ?`
      )
      .run(threadB)

    insertRemoteSteps(threadA, PACT_STEPS_PER_PACT_CAP)

    expectErrorCode(
      () =>
        d.applyInboundPactVerb(
          inboundArgs({
            toAgentId: a,
            senderAgentId: 'r23a',
            peerThreadId: 'thr_aaaaaaaaaaa1',
            pact: { verb: 'step', seq: 1, era: 1 }
          })
        ),
      'pact_ledger_capped'
    )
    const capped = d.getThread(threadA)
    expect(capped?.pact_paused_at).not.toBeNull()
    // S10-21b B17 (D-R137 F8): the over-cap auto-pause routes through the ONE relay hook — the
    // peer must be told, not just paused locally. RED at base: no outbox row at all (the base
    // implementation wrote the pause directly, bypassing emitFederatedPactSideEffect).
    const pauseRelay = rawDb(d)
      .prepare(
        `SELECT relay_kind FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_pause'`
      )
      .all(threadA) as { relay_kind: string }[]
    expect(pauseRelay).toEqual([{ relay_kind: 'pact_pause' }])

    // pact B, same link, is unaffected.
    const resultB = d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: b,
        senderAgentId: 'r23b',
        peerThreadId: 'thr_bbbbbbbbbbb1',
        messageId: 'msg_bbbbbbbbbbb2',
        pact: { verb: 'step', seq: 1, era: 1 }
      })
    )
    expect(resultB.accepted).toBe(true)
    const notCapped = d.getThread(threadB)
    expect(notCapped?.pact_paused_at).toBeNull()

    // Purge: pact A's over-cap rows are current era, still engaged (well, paused) — not deleted.
    const before = d.purgePeerLedger({ linkId: ENV })
    const stillThere = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ?`)
      .get(threadA) as { n: number }
    expect(stillThere.n).toBeGreaterThanOrEqual(PACT_STEPS_PER_PACT_CAP)
    void before

    // Advance the era (simulating a genuine re-propose cycle) — the old-era rows now purge.
    rawDb(d).prepare(`UPDATE threads SET pact_era = pact_era + 1 WHERE id = ?`).run(threadA)
    const after = d.purgePeerLedger({ linkId: ENV })
    expect(after.purged).toBeGreaterThanOrEqual(PACT_STEPS_PER_PACT_CAP)
    const goneNow = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND actor_is_remote = 1`)
      .get(threadA) as { n: number }
    expect(goneNow.n).toBe(0)
  })

  // -----------------------------------------------------------------------------------------
  // T-NA4 — retention exemption frees a released-and-aged pact's rows; ceiling refuses only
  // NEW pacts, naming the rule.
  // -----------------------------------------------------------------------------------------
  it("T-NA4: a released-and-aged pact's remote rows are purged by the retention arm; the ceiling refuses only a new pact, naming the rule", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'rna4', 'peerNA4')
    insertRemoteSteps(threadId, 10)
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_state = 'released',
           pact_release_at = datetime('now', '-8 days') WHERE id = ?`
      )
      .run(threadId)

    const result = d.purgePeerLedger({ linkId: ENV })
    expect(result.purged).toBeGreaterThanOrEqual(10)
    const remaining = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND actor_is_remote = 1`)
      .get(threadId) as { n: number }
    expect(remaining.n).toBe(0)

    // Saturate the link ceiling on an UNRELATED thread, then confirm a genuinely new pact
    // proposal against a different peer is refused, naming the retention rule.
    insertRemoteSteps(threadId, PACT_STEPS_PER_LINK_CEILING)
    const b = seedAgent(d, 'b_na4')
    const peerKey = seedFederatedPeer(d, 'rna4b', 'peerNA4b')
    const { thread } = d.createThread({
      subject: 's2',
      createdByAgentId: b,
      participants: [
        { participantKey: b, agentId: b },
        { participantKey: peerKey, agentId: null }
      ]
    })
    expectErrorCode(
      () =>
        d.proposePact({ ...actor(b), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null }),
      'pact_link_ceiling'
    )
    try {
      d.proposePact({ ...actor(b), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    } catch (err) {
      expect(String((err as Error).message)).toContain('7 days')
      expect(String((err as Error).message)).toContain('purge-peer-ledger')
    }
  })

  // -----------------------------------------------------------------------------------------
  // T-NB6 — resetAll leaves ZERO rows in pact_applied_ids, including rows its settlement never
  // touched (an already-released pact).
  // -----------------------------------------------------------------------------------------
  it('T-NB6: resetAll clears pact_applied_ids in full, even for a pact never touched by the settlement step', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId: liveThread } = engagedFederatedPact(d, a, 'rnb6a', 'peerNB6a')
    const { threadId: releasedThread } = engagedFederatedPact(
      d,
      seedAgent(d, 'b_nb6'),
      'rnb6b',
      'peerNB6b'
    )
    rawDb(d).prepare(`UPDATE threads SET pact_state = 'released' WHERE id = ?`).run(releasedThread)

    const raw = rawDb(d)
    raw
      .prepare(
        `INSERT INTO pact_applied_ids (thread_id, message_id, verb, applied_at) VALUES (?, 'm1', 'resync', datetime('now'))`
      )
      .run(liveThread)
    raw
      .prepare(
        `INSERT INTO pact_applied_ids (thread_id, message_id, verb, applied_at) VALUES (?, 'm2', 'gap_notice', datetime('now'))`
      )
      .run(releasedThread)

    d.resetAll()

    const remaining = raw.prepare(`SELECT COUNT(*) AS n FROM pact_applied_ids`).get() as {
      n: number
    }
    expect(remaining.n).toBe(0)
  })

  // -----------------------------------------------------------------------------------------
  // T-NB7 — the ceiling refusal names the quarantine remedy; --force-released is refused
  // against a still-engaged pact's current-era rows.
  // -----------------------------------------------------------------------------------------
  it("T-NB7: the ceiling refusal names the quarantine remedy; --force-released refuses a still-engaged pact's current-era rows", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'rnb7', 'peerNB7')
    insertRemoteSteps(threadId, PACT_STEPS_PER_LINK_CEILING)

    const b = seedAgent(d, 'b_nb7')
    const peerKey = seedFederatedPeer(d, 'rnb7b', 'peerNB7b')
    const { thread } = d.createThread({
      subject: 's3',
      createdByAgentId: b,
      participants: [
        { participantKey: b, agentId: b },
        { participantKey: peerKey, agentId: null }
      ]
    })
    try {
      d.proposePact({ ...actor(b), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
      throw new Error('expected pact_link_ceiling')
    } catch (err) {
      expect(String((err as Error).message)).toContain('quarantine')
    }

    expect(() => d.purgePeerLedger({ linkId: ENV, forceReleased: true })).toThrow('still-engaged')
  })

  // -----------------------------------------------------------------------------------------
  // S10-21b B17 (D-R137 F13) — the ceiling refusal's suggested quarantine command must name a
  // HOST LABEL (`resolveOrchestrationWorkerServer`'s own key — the saved-environment NAME) never
  // an agent id / raw environment id. `environment_id`/`remote_agent_id` deliberately differ
  // from `environment_name`/`display_name` here so the two cannot coincidentally match.
  // RED at base: the message named `senderAgentId`/`environment_id` (propose-apply.ts) or
  // `environment_id` twice (propose-accept.ts) — never `environment_name`.
  // -----------------------------------------------------------------------------------------
  it('F13: the ceiling refusal names the mirror display name and the saved-environment NAME, not raw ids (RED at base)', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const a = seedAgent(d, 'a_f13')
    const ENV_F13 = 'env_id_f13_raw'
    const ENV_NAME_F13 = 'my-saved-env-nickname'
    const REMOTE_ID_F13 = 'r_f13_raw_id'
    const DISPLAY_NAME_F13 = 'peer-f13-display'
    d.upsertRemoteAgent({
      environmentId: ENV_F13,
      environmentName: ENV_NAME_F13,
      linkKind: 'environment',
      remoteAgentId: REMOTE_ID_F13,
      displayName: DISPLAY_NAME_F13,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(raw, {
      linkDeviceId: ENV_F13,
      environmentId: ENV_F13,
      boundEndpointId: 'endpoint_f13',
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
    const peerKey = renderFederatedPartyKey({ linkDeviceId: ENV_F13, remoteAgentId: REMOTE_ID_F13 })
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    insertRemoteSteps(thread.id, PACT_STEPS_PER_LINK_CEILING, ENV_F13)

    expectErrorCode(
      () =>
        d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null }),
      'pact_link_ceiling'
    )
    try {
      d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
      throw new Error('expected pact_link_ceiling')
    } catch (err) {
      const message = String((err as Error).message)
      expect(message).toContain(`quarantine ${DISPLAY_NAME_F13}@${ENV_NAME_F13}`)
      expect(message).toContain(`purge-peer-ledger --link ${ENV_NAME_F13}`)
      expect(message).not.toContain(REMOTE_ID_F13)
      expect(message).not.toContain(ENV_F13)
    }
  })

  // -----------------------------------------------------------------------------------------
  // S10-21b B17 (D-R138 B-F6) — quarantining a peer with an outstanding `proposed` (not yet
  // accepted) federated pact must pause it too, mirroring `autoPauseEligible`'s own
  // engaged-or-proposed widening — otherwise the proposal survives containment and
  // `acceptPact` (which checks only the CALLER's own quarantine) can still create an engaged
  // pact with an already-quarantined peer. RED at base: the chain query was `pact_state =
  // 'engaged'` only, so the proposed pact was untouched and accept succeeded.
  // -----------------------------------------------------------------------------------------
  it('F18: quarantine pauses an outstanding proposed pact too; acceptPact then refuses (RED at base)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_f18')
    const peerKey = seedFederatedPeer(d, 'r_f18', 'peer-f18')
    // The PEER proposes TO `a` (inbound) — `a` is the one who would later `acceptPact`.
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread.id, 'thr_f18000000f12', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_f18',
        peerThreadId: 'thr_f18000000f12',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    const beforePause = d.getThread(thread.id)
    expect(beforePause?.pact_state).toBe('proposed')
    expect(beforePause?.pact_paused_at).toBeNull()

    const outcomes = d.autoPausePactsForRemoteAgentChain(['r_f18'], ENV, 'counterpart_quarantined')
    expect(outcomes.map((o) => o.threadId)).toEqual([thread.id])

    const paused = d.getThread(thread.id)
    expect(paused?.pact_state).toBe('proposed')
    expect(paused?.pact_paused_at).not.toBeNull()
    expect(paused?.pact_pause_reason).toBe('counterpart_quarantined')

    // Simulate the peer answering after quarantine — accept must refuse, not silently engage.
    expectErrorCode(() => d.acceptPact({ ...actor(a), threadId: thread.id }), 'pact_paused')
    expect(d.getThread(thread.id)?.pact_state).toBe('proposed')
  })

  // -----------------------------------------------------------------------------------------
  // D-R139 N5 — a `proposed` federated pact's quarantine auto-pause must be LOCAL ONLY: the
  // peer's inbound gate refuses a `pause` for a not-yet-`engaged` pact (`pact_not_engaged`),
  // so relaying one just drives seven days of retries then a terminal settle. RED at base: the
  // pause relayed (a queued `pact_pause` outbox row).
  // -----------------------------------------------------------------------------------------
  it('N5: quarantine pauses a proposed federated pact LOCALLY, no relay row (RED at base: a pact_pause row)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n5')
    const peerKey = seedFederatedPeer(d, 'r_n5', 'peer-n5')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread.id, 'thr_a5000000000f', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n5',
        peerThreadId: 'thr_a5000000000f',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread.id)?.pact_state).toBe('proposed')

    const outcomes = d.autoPausePactsForRemoteAgentChain(['r_n5'], ENV, 'counterpart_quarantined')
    expect(outcomes.map((o) => o.threadId)).toEqual([thread.id])

    const paused = d.getThread(thread.id)
    expect(paused?.pact_state).toBe('proposed')
    expect(paused?.pact_paused_at).not.toBeNull()
    expect(paused?.pact_pause_reason).toBe('counterpart_quarantined')

    const relayRows = rawDb(d)
      .prepare(
        `SELECT relay_kind FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_pause'`
      )
      .all(thread.id) as { relay_kind: string }[]
    expect(relayRows).toEqual([])
  })

  // -----------------------------------------------------------------------------------------
  // T-NB8 — the per-peer-per-window proposal block is keyed per (peer, local agent), not
  // per-thread; resetAll clears agent_rate and the block lifts immediately.
  // -----------------------------------------------------------------------------------------
  it('T-NB8: the proposal block is keyed per (peer, local agent) — a re-propose on a different thread still blocks, and resetAll lifts it', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer(d, 'rnb8', 'peerNB8')
    const { thread: thread1 } = d.createThread({
      subject: 's1',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread1.id, 'thr_000000000001', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'rnb8',
        peerThreadId: 'thr_000000000001',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    d.declinePact({ ...actor(a), threadId: thread1.id, reasonCode: null })

    const { thread: thread2 } = d.createThread({
      subject: 's2',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread2.id, 'thr_000000000002', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'rnb8',
        peerThreadId: 'thr_000000000002',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )

    expect(d.pactProposalBlockingPeers(a)).toEqual([peerKey])

    d.resetAll()
    expect(d.pactProposalBlockingPeers(a)).toEqual([])
  })
})
