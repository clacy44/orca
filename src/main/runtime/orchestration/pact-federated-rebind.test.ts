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
    // S10-21b B6c: proposePact now relays for real (its own outbox row) — remove it so this
    // test's own single-row assertion below (this file's own subject: the rebind_party drain)
    // sees only the row THEY create.
    raw
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
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
    // S10-21b B6c: proposePact now relays for real (its own outbox row) — remove it so this
    // test's own "zero outbox rows" assertion below (this file's own subject: the rebind_party
    // drain, absent a predecessor to report) sees a clean table.
    raw
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
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

  // ---------------------------------------------------------------------------------------
  // S10-21b B17 (D-R138 A-F7/B-F11): the drain's double-emit guard must be PER TOKEN — a
  // queued relay of one kind must never block a DIFFERENT kind's drain on the same thread.
  // RED at base: the shared `relay_kind = 'pact_gap_notice'` guard blocked ANY token's drain
  // for as long as a gap_notice sat queued.
  // ---------------------------------------------------------------------------------------
  it('F19a: a queued gap_notice does not block the rebind drain (RED at base)', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const successorId = seedAgent(d, 'chair-f19a')
    raw
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES ('agt_pred_f19a', 'chair-f19a', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
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
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_relay_pending = 'rebind' WHERE id = ?`
      )
      .run(successorId, thread.id)
    // A stuck/queued gap_notice relay item on this SAME thread — must not block the rebind.
    raw
      .prepare(
        `INSERT INTO peer_reply_outbox (
           id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
           peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
           peer_thread_id, local_thread_id, pact_thread_id, notice_run_id, notice_pane_key, payload,
           byte_count, relay_kind, state, attempts, consecutive_failures, hold_count, created_at
         ) VALUES ('stuck_gap_f19a', 1, 'msg_stuck_f19a', ?, ?, 1, 'pcfp', 'pkfp', 'msg_stuck_f19a',
                   ?, NULL, ?, ?, NULL, NULL, '{}', 2, 'pact_gap_notice', 'queued', 0, 0, 0, ?)`
      )
      .run(ENV, ENV, REMOTE_AGENT_ID, thread.id, thread.id, Date.now())

    const drained = drainPendingRebindParty(raw, null)
    expect(drained).toBe(1)
    const row = raw
      .prepare('SELECT pact_relay_pending FROM threads WHERE id = ?')
      .get(thread.id) as { pact_relay_pending: string | null }
    expect(row.pact_relay_pending).toBeNull()
    const rebindRow = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_rebind_party'`
      )
      .get(thread.id) as { n: number }
    expect(rebindRow.n).toBe(1)
  })

  it('F19b: a queued rebind is not double-emitted (RED at base)', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const successorId = seedAgent(d, 'chair-f19b')
    raw
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES ('agt_pred_f19b', 'chair-f19b', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
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
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_relay_pending = 'rebind' WHERE id = ?`
      )
      .run(successorId, thread.id)
    // An already-queued rebind_party relay on this thread (e.g. from a prior partial tick) —
    // a second tick must not mint a SECOND one.
    raw
      .prepare(
        `INSERT INTO peer_reply_outbox (
           id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
           peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
           peer_thread_id, local_thread_id, pact_thread_id, notice_run_id, notice_pane_key, payload,
           byte_count, relay_kind, state, attempts, consecutive_failures, hold_count, created_at
         ) VALUES ('stuck_rebind_f19b', 1, 'msg_stuck_f19b', ?, ?, 1, 'pcfp', 'pkfp', 'msg_stuck_f19b',
                   ?, NULL, ?, ?, NULL, NULL, '{}', 2, 'pact_rebind_party', 'queued', 0, 0, 0, ?)`
      )
      .run(ENV, ENV, REMOTE_AGENT_ID, thread.id, thread.id, Date.now())

    const drained = drainPendingRebindParty(raw, null)
    expect(drained).toBe(0)
    const row = raw
      .prepare('SELECT pact_relay_pending FROM threads WHERE id = ?')
      .get(thread.id) as { pact_relay_pending: string | null }
    // Still pending — the drain is deliberately skipped this tick, not cleared prematurely.
    expect(row.pact_relay_pending).toBe('rebind')
    const rebindRowCount = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_rebind_party'`
      )
      .get(thread.id) as { n: number }
    expect(rebindRowCount.n).toBe(1)
  })
})

// B9c (D-R134 F3/D-R135 F2, chair NOTE "after B13"): the SAME drain extended to
// `pact_relay_pending = 'gap_notice'` — one scan, a per-token emit. FAILS AT BASE: base has no
// 'gap_notice' member of FederatedPactVerb/PACT_VERB_RELAY_KIND and no reader of
// pact_relay_pending='gap_notice' anywhere — the token is set (repair.ts) but never drained.
describe('drainPendingRebindParty — gap_notice (B9c)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedEngagedFederatedThread(d: OrchestrationDb): {
    threadId: string
    raw: Database.Database
  } {
    const raw = rawDb(d)
    const successorId = (() => {
      const params: UpsertAgentByPaneSuffixParams = {
        displayName: 'gap-holder',
        role: null,
        hostId: 'local',
        paneKey: 'tab:gap-holder',
        terminalHandle: 'term_gap_holder',
        processIncarnation: null,
        worktreeId: null,
        worktreePath: null,
        branch: null,
        title: null,
        agentLabel: null,
        originHandle: 'term_gap_holder',
        originHostId: 'local'
      }
      const result = d.upsertAgentByPaneSuffix(params)
      if (result.outcome === 'name_taken') {
        throw new Error('seedAgent: name taken')
      }
      return result.agent.id
    })()
    d.upsertRemoteAgent({
      environmentId: 'env_gap_drain',
      environmentName: 'env_gap_drain',
      linkKind: 'environment',
      remoteAgentId: 'peer_gap',
      displayName: 'peer (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(raw, {
      linkDeviceId: 'env_gap_drain',
      environmentId: 'env_gap_drain',
      boundEndpointId: 'endpoint_gap',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_gap',
      peerCredentialFp: 'pcfp_gap',
      peerKeyFingerprint: 'pkfp_gap',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    const peerKey = renderFederatedPartyKey({
      linkDeviceId: 'env_gap_drain',
      remoteAgentId: 'peer_gap'
    })
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
    // S10-21b B6c: proposePact now relays for real (its own outbox row) — settle it out of the
    // way so this fixture's own "exactly one outbox row" assertions (this file's own subject:
    // the gap_notice drain) see only the row THEY create. `pact_local_seq = 3` below already
    // overwrites the emit's own seq bump, so this settle is cosmetic for seq but load-bearing
    // for row count/relay_kind.
    raw
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?,
           pact_relay_pending = 'gap_notice', pact_local_seq = 3 WHERE id = ?`
      )
      .run(successorId, thread.id)
    return { threadId: thread.id, raw }
  }

  it('enqueues one gap_notice (seq = pact_local_seq + 1) and clears the token in one scan', () => {
    const d = freshDb()
    const { threadId, raw } = seedEngagedFederatedThread(d)

    const drained = drainPendingRebindParty(raw, null)
    expect(drained).toBe(1)

    const row = raw
      .prepare('SELECT pact_relay_pending, pact_local_seq FROM threads WHERE id = ?')
      .get(threadId) as { pact_relay_pending: string | null; pact_local_seq: number }
    expect(row.pact_relay_pending).toBeNull()
    expect(row.pact_local_seq).toBe(4) // bumped by the emit primitive's own step 3

    const outboxRow = raw
      .prepare(`SELECT payload, relay_kind FROM peer_reply_outbox WHERE local_thread_id = ?`)
      .get(threadId) as { payload: string; relay_kind: string } | undefined
    expect(outboxRow).toBeDefined()
    expect(outboxRow!.relay_kind).toBe('pact_gap_notice')
    const payload = JSON.parse(outboxRow!.payload) as { pact: { verb: string; seq: number } }
    expect(payload.pact.verb).toBe('gap_notice')
    expect(payload.pact.seq).toBe(4)
  })

  it('a second tick is a no-op once the token is drained — never a duplicate gap_notice', () => {
    const d = freshDb()
    const { threadId, raw } = seedEngagedFederatedThread(d)
    expect(drainPendingRebindParty(raw, null)).toBe(1)
    expect(drainPendingRebindParty(raw, null)).toBe(0)
    const outboxCount = raw
      .prepare(`SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE local_thread_id = ?`)
      .get(threadId) as { n: number }
    expect(outboxCount.n).toBe(1)
  })
})

// S10-21b B21 (D-D3-A item 7, T5) — the legacy clear arm (item 4): a 'pause'/'resume' token is
// no longer a mint instruction for this drain (21b-E8 REVOKED, the relay-owed drain and its
// relay-only minter are deleted) — it is NULLed and audited, minting nothing.
describe('drainPendingRebindParty — legacy pause/resume token (S10-21b B21)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedFederatedThread(
    d: OrchestrationDb,
    token: 'pause' | 'resume'
  ): { threadId: string; raw: Database.Database } {
    const raw = rawDb(d)
    const params: UpsertAgentByPaneSuffixParams = {
      displayName: 'legacy-holder',
      role: null,
      hostId: 'local',
      paneKey: 'tab:legacy-holder',
      terminalHandle: 'term_legacy_holder',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_legacy_holder',
      originHostId: 'local'
    }
    const result = d.upsertAgentByPaneSuffix(params)
    if (result.outcome === 'name_taken') {
      throw new Error('seedAgent: name taken')
    }
    const successorId = result.agent.id
    d.upsertRemoteAgent({
      environmentId: 'env_legacy_drain',
      environmentName: 'env_legacy_drain',
      linkKind: 'environment',
      remoteAgentId: 'peer_legacy',
      displayName: 'peer (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(raw, {
      linkDeviceId: 'env_legacy_drain',
      environmentId: 'env_legacy_drain',
      boundEndpointId: 'endpoint_legacy',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp_legacy',
      peerCredentialFp: 'pcfp_legacy',
      peerKeyFingerprint: 'pkfp_legacy',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    const peerKey = renderFederatedPartyKey({
      linkDeviceId: 'env_legacy_drain',
      remoteAgentId: 'peer_legacy'
    })
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
        `DELETE FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    // Simulates a token a pre-B21 build left behind — v42 is unshipped, so this never happens
    // in practice; the arm is defensive, not lossy-repair.
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ?, pact_relay_pending = ? WHERE id = ?`
      )
      .run(successorId, token, thread.id)
    return { threadId: thread.id, raw }
  }

  it.each(['pause', 'resume'] as const)(
    'T5 (%s): a legacy token is cleared and audited, minting nothing (RED at base: relays)',
    (token) => {
      const d = freshDb()
      const { threadId, raw } = seedFederatedThread(d, token)
      const before = raw
        .prepare('SELECT pact_local_seq FROM threads WHERE id = ?')
        .get(threadId) as { pact_local_seq: number }

      const drained = drainPendingRebindParty(raw, null)
      expect(drained).toBe(0)

      const row = raw
        .prepare('SELECT pact_relay_pending, pact_local_seq FROM threads WHERE id = ?')
        .get(threadId) as { pact_relay_pending: string | null; pact_local_seq: number }
      expect(row.pact_relay_pending).toBeNull()
      expect(row.pact_local_seq).toBe(before.pact_local_seq)

      const messageCount = raw
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
             WHERE thread_id = ? AND payload_kind IN ('pact_pause', 'pact_resume')`
        )
        .get(threadId) as { n: number }
      expect(messageCount.n).toBe(0)

      const outboxCount = raw
        .prepare(
          `SELECT COUNT(*) AS n FROM peer_reply_outbox
             WHERE local_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
        )
        .get(threadId) as { n: number }
      expect(outboxCount.n).toBe(0)

      const auditRow = raw
        .prepare(
          `SELECT outcome FROM agent_audit WHERE verb = 'pact_relay_pending_legacy_cleared'
             ORDER BY seq DESC LIMIT 1`
        )
        .get() as { outcome: string } | undefined
      expect(auditRow?.outcome).toBe('cleared')
    }
  )
})
