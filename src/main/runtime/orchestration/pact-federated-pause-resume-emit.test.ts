// S10-21b B21b (D-R142 N1) — the per-LINK ceiling on cap-exempt pact_pause/pact_resume rows.
// FAILS AT BASE 88fc0a6db6: `enqueueReplyOutbox`'s `capExempt` branch skips the cap
// unconditionally (no per-link count), so a 257th exempt row on one link inserts cleanly instead
// of throwing `LinkBindingCapError` — this test's core assertion (no outbox row minted for the
// pact that trips the ceiling) fails at base because a row IS minted.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { enqueueReplyOutbox } from './reply-outbox-store'
import { PACT_PAUSE_RESUME_PER_LINK_CEILING } from './link-binding-constants'
import { emitFederatedPactSideEffect } from './pact-federated-pause-resume-emit'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_n1_ceiling'
const REMOTE_AGENT_ID = 'rb_n1'

type AuditRow = { verb: string; outcome: string; reason_code: string | null }

function listAudit(db: OrchestrationDb): AuditRow[] {
  return rawDb(db)
    .prepare('SELECT verb, outcome, reason_code FROM agent_audit ORDER BY seq DESC LIMIT 1')
    .all() as AuditRow[]
}

describe('D-R142 N1: PACT_PAUSE_RESUME_PER_LINK_CEILING bounds the cap exemption per link', () => {
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

  function engagedFederatedPact(d: OrchestrationDb, a: string): { threadId: string } {
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
    // Settle the propose's own relay out of the way — this test's own subject is the LATER
    // pause insert, not proposePact's.
    rawDb(d)
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    rawDb(d)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    return { threadId: thread.id }
  }

  it(`${PACT_PAUSE_RESUME_PER_LINK_CEILING} exempt pause rows on one link, then the ${PACT_PAUSE_RESUME_PER_LINK_CEILING + 1}th pact's pause: LinkBindingCapError caught by the loud local fallback — one ledger row, audit local_only/relay_cap, no outbox row (RED at base: a 257th exempt row inserts cleanly)`, () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const sqlite = rawDb(d)
    const now = Date.now()

    // Fill the link to the ceiling with cap-exempt pact_pause rows for OTHER (fictitious) pacts
    // — the ceiling is a per-LINK bound, not per-pact, so these do not need real pact rows.
    for (let i = 0; i < PACT_PAUSE_RESUME_PER_LINK_CEILING; i++) {
      enqueueReplyOutbox(sqlite, {
        localMessageId: `msg_n1_filler_${i}`,
        linkDeviceId: ENV,
        environmentId: ENV,
        boundPairingRevision: 1,
        peerCredentialFp: 'pcfp',
        peerKeyFingerprint: 'pkfp',
        inReplyToMessageId: `msg_n1_filler_${i}`,
        peerAgentId: REMOTE_AGENT_ID,
        peerThreadId: null,
        localThreadId: null,
        noticeRunId: null,
        noticePaneKey: null,
        payload: '{}',
        byteCount: 2,
        createdAt: now,
        capExempt: true,
        relayKind: 'pact_pause',
        pactThreadId: `thr_n1_filler_${i}`
      })
    }

    // One REAL engaged federated pact, still unpaused, on the SAME link.
    const { threadId } = engagedFederatedPact(d, a)

    // This pause is the (ceiling + 1)th exempt row on the link — must be refused by the
    // ceiling and caught into the loud local fallback, never minted as an outbox row.
    emitFederatedPactSideEffect(sqlite, null, threadId, 'pause', 'counterpart_gone')

    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).not.toBeNull()
    expect(thread?.pact_pause_reason).toBe('counterpart_gone')

    const pauseRows = sqlite
      .prepare(`SELECT reason_code FROM pact_steps WHERE thread_id = ? AND kind = 'pause'`)
      .all(threadId) as { reason_code: string }[]
    expect(pauseRows).toEqual([{ reason_code: 'counterpart_gone' }])

    const audit = listAudit(d)
    expect(audit).toEqual([
      {
        verb: 'pact_federated_side_effect_relay_failed',
        outcome: 'local_only',
        reason_code: 'relay_cap'
      }
    ])

    const outboxRows = sqlite
      .prepare(`SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ?`)
      .all(threadId) as { id: string }[]
    expect(outboxRows).toEqual([])

    // The link's exempt-row count stayed exactly at the ceiling — nothing snuck past it.
    const exemptCount = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM peer_reply_outbox
          WHERE link_device_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')
            AND state IN ('queued', 'sending') AND settled_at IS NULL`
      )
      .get(ENV) as { n: number }
    expect(exemptCount.n).toBe(PACT_PAUSE_RESUME_PER_LINK_CEILING)
  })
})
