// S10-21b B21b (D-R142 N5b): T1 relocated VERBATIM from pact-federated-containment-b14.test.ts
// (lines 303-384 at base 88fc0a6db6) — that file was 875 lines, over the 800-line test budget
// (_common-rules.md); this split brings it back under. 0 assertions changed; fixture helpers
// below are the same subset that file already carries (duplicated, not imported — matching this
// slice's own precedent for test-file splits, e.g. pact-federated-pause-resume-b21-e2e.test.ts's
// header note).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { REPLY_OUTBOX_PER_LINK_CAP, PACT_RESERVED_HEADROOM } from './link-binding-constants'
import { pausePact } from './pact-lifecycle'
import { pactsAwaitingUnpause } from './agent-pact-unpause-lookup'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_b14'

describe('S10-21b B14 containment (relocated from pact-federated-containment-b14.test.ts)', () => {
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

  // -----------------------------------------------------------------------------------------
  // S10-21b B21 (D-D3-A item 7, T1) SCENARIO_CORRECTION of F10 — the cap can no longer refuse
  // a pause/resume at all: `enqueueReplyOutboxCoalescedAcrossKinds` sets `capExempt: true` for
  // the pact_pause/pact_resume insert (reply-outbox-store.ts, bounded by the coalescer to <= 1
  // queued row per pact), so the base F10's premise (a `LinkBindingCapError` on pause, landing
  // locally with a `pact_relay_pending` token for a later drain to relay) no longer arises —
  // the relay-owed drain itself is deleted (21b-E8 REVOKED). The corrected scenario: pause
  // relays IMMEDIATELY, in the same transaction that applies it, even with the link's ordinary
  // headroom fully saturated by unrelated rows.
  // -----------------------------------------------------------------------------------------
  it('T1 (F10 SCENARIO_CORRECTION): a saturated link still relays pause immediately — no token, no drain (RED at base: pact_relay_pending=pause, outbox []))', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a, 'r10f10', 'peer10f10')

    // Fill the reserved-headroom cap for this link with unrelated queued outbox rows, exactly
    // as T20 (pact-federated-emit.test.ts) does — at base this saturation is what forces
    // pause's own enqueue into LinkBindingCapError; under B21 it must NOT.
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
        `filler_f10_${i}`,
        i + 1,
        `msg_filler_f10_${i}`,
        ENV,
        ENV,
        1,
        'pcfp',
        'pkfp',
        `msg_filler_f10_${i}`,
        'r10f10',
        Date.now()
      )
    }

    const before = d.getThread(threadId)
    const seqBefore = before!.pact_local_seq

    pausePact(raw, {
      callerAgentId: a,
      callerPaneKey: `tab:${a}`,
      callerHostId: 'local',
      threadId,
      reasonCode: 'counterpart_gone'
    })

    const after = d.getThread(threadId)
    // No token — there is nothing owed to a drain.
    expect(after?.pact_relay_pending).toBeNull()
    expect(after?.pact_paused_at).not.toBeNull()
    // Exactly one relayed pause/resume row, minted immediately by the pause's own transaction
    // (the propose's own earlier relay, out of this test's scope, is a separate row).
    const outboxRows = raw
      .prepare(
        `SELECT relay_kind FROM peer_reply_outbox
           WHERE local_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
      )
      .all(threadId) as { relay_kind: string }[]
    expect(outboxRows.map((r) => r.relay_kind)).toEqual(['pact_pause'])
    // One host pause ledger row, the real reason intact.
    const stepRows = raw
      .prepare(
        `SELECT reason_code FROM pact_steps WHERE thread_id = ? AND kind = 'pause' AND actor_is_remote = 0`
      )
      .all(threadId) as { reason_code: string }[]
    expect(stepRows).toEqual([{ reason_code: 'counterpart_gone' }])
    // pact_local_seq bumped by exactly one fresh insert — never a coalesced replacement (no
    // prior queued row existed).
    expect(after?.pact_local_seq).toBe(seqBefore + 1)
    // Restart-resumable: the reason is `counterpart_gone`, so the agent-restore path's
    // `pactsAwaitingUnpause` sees it as eligible.
    expect(pactsAwaitingUnpause(raw, a)).toContain(threadId)
  })
})
