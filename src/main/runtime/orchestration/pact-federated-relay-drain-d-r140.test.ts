// S10-21b B20 (D-R140 NF-1/NF-2, N3/21b-E11) — the relay-owed drain's cap-saturation and
// stale-token fixes, and the propose block window's applied-only bump. Split into its own file
// (max-lines discipline) rather than growing pact-federated-containment-b14.test.ts (already at
// its own budget) or pact-federated-propose-race.test.ts further.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import { REPLY_OUTBOX_PER_LINK_CAP, PACT_RESERVED_HEADROOM } from './link-binding-constants'
import { pausePact, resumePact } from './pact-lifecycle'
import { drainPendingRebindParty } from './pact-federated-rebind'
import { OrchestrationError } from './orchestration-error'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_dr140'

describe('S10-21b B20 (D-R140 NF-1/NF-2/N3)', () => {
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

  // Same filler-row cap-saturation technique as F10 (pact-federated-containment-b14.test.ts).
  function fillOutboxCap(raw: Database.Database, remoteAgentId: string, tag: string): void {
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
        `filler_${tag}_${i}`,
        i + 1,
        `msg_filler_${tag}_${i}`,
        ENV,
        ENV,
        1,
        'pcfp',
        'pkfp',
        `msg_filler_${tag}_${i}`,
        remoteAgentId,
        Date.now()
      )
    }
  }

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
  // D-R140 NF-1 (HIGH) — the relay-owed drain must burn nothing while the cap is still
  // saturated. RED at base: each of the three ticks bumped `pact_local_seq` and minted a
  // message row (+3 rows, +3 seq) before ever hitting the enqueue's own cap error.
  // -----------------------------------------------------------------------------------------
  it('NF-1: three pump ticks under a still-saturated cap mint nothing and leave pact_local_seq untouched (RED at base: +3 rows, +3 seq)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_nf1')
    const { threadId } = engagedFederatedPact(d, a, 'r_nf1', 'peer_nf1')
    const raw = rawDb(d)
    fillOutboxCap(raw, 'r_nf1', 'nf1')

    pausePact(raw, { ...actor(a), threadId, reasonCode: 'counterpart_gone' })
    const before = d.getThread(threadId)
    expect(before?.pact_relay_pending).toBe('pause')
    const seqBefore = before!.pact_local_seq
    const messageCountBefore = (
      raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?`).get(threadId) as {
        n: number
      }
    ).n

    // Cap stays saturated across all three ticks — never freed.
    for (let i = 0; i < 3; i++) {
      const drained = drainPendingRebindParty(raw, null)
      expect(drained).toBe(0)
    }

    const after = d.getThread(threadId)
    expect(after?.pact_local_seq).toBe(seqBefore)
    expect(after?.pact_relay_pending).toBe('pause')
    const messageCountAfter = (
      raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?`).get(threadId) as {
        n: number
      }
    ).n
    expect(messageCountAfter).toBe(messageCountBefore)
    const outboxRows = raw
      .prepare(
        `SELECT id FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
      )
      .all(threadId)
    expect(outboxRows).toEqual([])
  })

  // -----------------------------------------------------------------------------------------
  // D-R140 NF-2 — a drain racing a fresh local resume must not relay a superseded pause. RED at
  // base: the drain read the stale `pact_relay_pending = 'pause'` token and relayed
  // `pact_pause` even though the pact was resumed in the meantime, leaving the two hosts
  // disagreeing about who is paused.
  // -----------------------------------------------------------------------------------------
  it('NF-2: a local resume after a cap-error pause relays only the resume, never a stale pause (RED at base: a stale pact_pause relayed)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_nf2')
    const { threadId } = engagedFederatedPact(d, a, 'r_nf2', 'peer_nf2')
    const raw = rawDb(d)
    fillOutboxCap(raw, 'r_nf2', 'nf2')

    pausePact(raw, { ...actor(a), threadId, reasonCode: 'counterpart_gone' })
    expect(d.getThread(threadId)?.pact_relay_pending).toBe('pause')

    // Headroom frees.
    raw.prepare(`DELETE FROM peer_reply_outbox WHERE id LIKE 'filler_nf2_%'`).run()

    // Local resume through the NORMAL (non-cap) path — races the drain, which has not ticked
    // yet.
    resumePact(raw, { ...actor(a), threadId })
    const afterResume = d.getThread(threadId)
    expect(afterResume?.pact_relay_pending).toBeNull()
    expect(afterResume?.pact_paused_at).toBeNull()

    const outboxRows = () =>
      raw
        .prepare(
          `SELECT relay_kind FROM peer_reply_outbox WHERE local_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
        )
        .all(threadId) as { relay_kind: string }[]
    expect(outboxRows()).toEqual([{ relay_kind: 'pact_resume' }])

    // The next tick relays nothing further — the token is gone, and there is nothing else
    // pending.
    const drained = drainPendingRebindParty(raw, null)
    expect(drained).toBe(0)
    expect(outboxRows()).toEqual([{ relay_kind: 'pact_resume' }])
  })

  // -----------------------------------------------------------------------------------------
  // D-R140 N3 (21b-E11) — `bumpProposalBlockWindow` runs AFTER the propose's own transaction
  // commits: applied proposals only. RED at base: a refused retry (bad seq) bumped the window
  // BEFORE the seq check, so a single legitimately-applied propose already read as two arrivals
  // and spuriously suppressed the wait guard's `answer_first` refusal for a still-unanswered
  // first proposal.
  // -----------------------------------------------------------------------------------------
  it('N3: a refused propose retry does not bump the block window (RED at base)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n3')
    const peerKey = seedFederatedPeer(d, 'r_n3', 'peer_n3')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread.id, 'thr_0000000a3001', peerKey)

    // A refused retry — seq must be exactly 1 for a propose (A-F8); this one is refused
    // `pact_out_of_order` before the transaction (and, at base, after the bump).
    expect(() =>
      d.applyInboundPactVerb(
        inboundArgs({
          toAgentId: a,
          senderAgentId: 'r_n3',
          peerThreadId: 'thr_0000000a3001',
          pact: { verb: 'propose', seq: 99, era: 1, stepsTotal: null }
        })
      )
    ).toThrow(OrchestrationError)

    // The corrected retry applies cleanly — the FIRST (and only) applied proposal.
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3',
        peerThreadId: 'thr_0000000a3001',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread.id)?.pact_state).toBe('proposed')

    // Only one APPLIED proposal has ever landed — the wait guard must still treat this as the
    // window-establishing (still-blocking) proposal, not a suppressed re-propose.
    expect(d.isPactProposalReArmSuppressed(peerKey, a)).toBe(false)
  })

  // -----------------------------------------------------------------------------------------
  // N3 guard (b) — an answered-then-re-proposed pair (both APPLIED) still suppresses re-arm,
  // exactly as isProposalReArmSuppressed's unchanged `count >= 2` semantics require. Passes at
  // base too (isProposalReArmSuppressed itself is untouched) — a guard, not a red-at-base test.
  // -----------------------------------------------------------------------------------------
  it('N3 guard: an answered propose followed by a re-propose (both applied) still suppresses re-arm', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n3b')
    const peerKey = seedFederatedPeer(d, 'r_n3b', 'peer_n3b')

    const { thread: thread1 } = d.createThread({
      subject: 's1',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread1.id, 'thr_00000b300001', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3b',
        peerThreadId: 'thr_00000b300001',
        messageId: 'msg_00000b300001',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    // Answered.
    d.declinePact({ ...actor(a), threadId: thread1.id, reasonCode: null })

    const { thread: thread2 } = d.createThread({
      subject: 's2',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread2.id, 'thr_00000b300002', peerKey)
    // A distinct messageId from thread1's own propose — gate 8a's dedupe is scoped by
    // (link, sender, messageId); reusing `inboundArgs`' shared default would collide.
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3b',
        peerThreadId: 'thr_00000b300002',
        messageId: 'msg_00000b300002',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread2.id)?.pact_state).toBe('proposed')

    expect(d.isPactProposalReArmSuppressed(peerKey, a)).toBe(true)
  })

  // -----------------------------------------------------------------------------------------
  // N3 guard (c) — a single, still-unanswered first proposal never suppresses the wait guard.
  // -----------------------------------------------------------------------------------------
  it('N3 guard: a lone unanswered first proposal does not suppress re-arm', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n3c')
    const peerKey = seedFederatedPeer(d, 'r_n3c', 'peer_n3c')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread.id, 'thr_00000c300000', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3c',
        peerThreadId: 'thr_00000c300000',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread.id)?.pact_state).toBe('proposed')
    expect(d.isPactProposalReArmSuppressed(peerKey, a)).toBe(false)
  })
})
