// S10-21b B8d (D-R136 N6) — the coalesced `resync` answer replacement must refresh
// local_message_id/pact_state/pact_flight_token, not just payload/byte_count/pact_seq/pact_era,
// or settle stamps the SUPERSEDED message and a stale token makes an actually-delivered answer
// report settle_stale. No test existed for this module before this commit.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import {
  enqueueReplyOutboxCoalesced,
  enqueueReplyOutboxCoalescedAcrossKinds
} from './reply-outbox-pact-answer-coalesce'
import { enqueueReplyOutbox, type EnqueueReplyOutboxParams } from './reply-outbox-store'
import { REPLY_OUTBOX_PER_LINK_CAP } from './link-binding-constants'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('reply-outbox-pact-answer-coalesce (D-R136 N6)', () => {
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

  function baseParams(threadId: string, localMessageId: string): EnqueueReplyOutboxParams {
    return {
      localMessageId,
      linkDeviceId: 'dev1',
      environmentId: 'env1',
      boundPairingRevision: 1,
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      inReplyToMessageId: localMessageId,
      peerAgentId: 'remote:dev1:peer1',
      peerThreadId: 'thr_peerthread0001',
      localThreadId: threadId,
      noticeRunId: null,
      noticePaneKey: null,
      payload: JSON.stringify({ n: 1 }),
      byteCount: 10,
      createdAt: Date.now(),
      reserved: true,
      pactThreadId: threadId,
      pactSeq: 1,
      pactEra: 1,
      relayKind: 'pact_resync'
    }
  }

  it('N6: the replacement UPDATE refreshes local_message_id, pact_state, and pact_flight_token from the CURRENT thread row', () => {
    const d = freshDb()
    const raw = rawDb(d)
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: b, agentId: b }
      ]
    })
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?,
           pact_with_agent_id = ?, pact_turn_agent_id = ?, pact_flight_token = 1 WHERE id = ?`
      )
      .run(a, b, a, thread.id)

    const firstId = enqueueReplyOutboxCoalesced(raw, true, baseParams(thread.id, 'msg_first0001'))

    // Something changes the pact's state/token between the two answers (e.g. a resync applying,
    // a pause) — exactly the window N6 exists to close.
    raw
      .prepare(
        `UPDATE threads SET pact_state = 'released', pact_flight_token = pact_flight_token + 1 WHERE id = ?`
      )
      .run(thread.id)

    const secondId = enqueueReplyOutboxCoalesced(raw, true, baseParams(thread.id, 'msg_second0001'))

    // REPLACED, not appended — same row id.
    expect(secondId).toBe(firstId)
    const rowCount = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_resync'`
      )
      .get(thread.id) as { n: number }
    expect(rowCount.n).toBe(1)

    // RED at base: local_message_id/pact_state/pact_flight_token were never in the replacement
    // UPDATE's column list — this row would still read the FIRST call's stale values.
    const row = raw
      .prepare(
        `SELECT local_message_id, pact_state, pact_flight_token FROM peer_reply_outbox WHERE id = ?`
      )
      .get(firstId) as {
      local_message_id: string
      pact_state: string | null
      pact_flight_token: number | null
    }
    expect(row.local_message_id).toBe('msg_second0001')
    expect(row.pact_state).toBe('released')
    expect(row.pact_flight_token).toBe(2)
  })

  // D-R142 N3/N4 — the capExempt predicate: exactly the {pact_pause, pact_resume} relayKinds
  // SET, AND the row's own relayKind must itself be pact_pause or pact_resume. Every case here
  // saturates its (fresh) link to REPLY_OUTBOX_PER_LINK_CAP first with ordinary rows, so a
  // non-exempt call is observably refused and an exempt one is observably admitted.
  describe('D-R142 N3/N4: enqueueReplyOutboxCoalescedAcrossKinds sets capExempt for exactly {pact_pause, pact_resume}, keyed on the ROW kind', () => {
    function fillOrdinary(raw: Database.Database, linkDeviceId: string, n: number): void {
      for (let i = 0; i < n; i++) {
        enqueueReplyOutbox(raw, {
          localMessageId: `msg_fill_${linkDeviceId}_${i}`,
          linkDeviceId,
          environmentId: 'env_fill',
          boundPairingRevision: 1,
          peerCredentialFp: 'pcfp',
          peerKeyFingerprint: 'pkfp',
          inReplyToMessageId: `msg_fill_${linkDeviceId}_${i}`,
          peerAgentId: 'agent_fill',
          peerThreadId: null,
          localThreadId: null,
          noticeRunId: null,
          noticePaneKey: null,
          payload: '{}',
          byteCount: 2,
          createdAt: Date.now()
        })
      }
    }

    it("N3: relayKinds exactly {pact_pause, pact_resume} with the row's own relayKind = 'pact_pause' IS exempt — admitted past a saturated cap (RED at base by absence: no test pinned this predicate at all)", () => {
      const d = freshDb()
      const raw = rawDb(d)
      const linkDeviceId = 'link_n3_exempt'
      fillOrdinary(raw, linkDeviceId, REPLY_OUTBOX_PER_LINK_CAP)
      expect(() =>
        enqueueReplyOutboxCoalescedAcrossKinds(raw, ['pact_pause', 'pact_resume'], {
          ...baseParams('thr_n3_exempt', 'msg_n3_exempt'),
          linkDeviceId,
          relayKind: 'pact_pause',
          reserved: undefined
        })
      ).not.toThrow()
    })

    it("N3: relayKinds = ['pact_pause'] alone (not the exact pair) is NOT exempt — refused at a saturated cap", () => {
      const d = freshDb()
      const raw = rawDb(d)
      const linkDeviceId = 'link_n3_single'
      fillOrdinary(raw, linkDeviceId, REPLY_OUTBOX_PER_LINK_CAP)
      expect(() =>
        enqueueReplyOutboxCoalescedAcrossKinds(raw, ['pact_pause'], {
          ...baseParams('thr_n3_single', 'msg_n3_single'),
          linkDeviceId,
          relayKind: 'pact_pause',
          reserved: undefined
        })
      ).toThrow()
    })

    it("N4: relayKinds = {pact_pause, pact_resume} but the ROW's own relayKind is 'pact_step' is NOT exempt — refused at a saturated cap (RED at base: the base predicate asserts only the SET, not the row's own kind)", () => {
      const d = freshDb()
      const raw = rawDb(d)
      const linkDeviceId = 'link_n4_wrong_row_kind'
      fillOrdinary(raw, linkDeviceId, REPLY_OUTBOX_PER_LINK_CAP)
      expect(() =>
        enqueueReplyOutboxCoalescedAcrossKinds(raw, ['pact_pause', 'pact_resume'], {
          ...baseParams('thr_n4_wrong_kind', 'msg_n4_wrong_kind'),
          linkDeviceId,
          relayKind: 'pact_step',
          reserved: undefined
        })
      ).toThrow()
    })
  })
})
