// S10-21b B9 (design §2.5 strict fence, §2.6(c) terminal-settle disposition, §2.9 metering) —
// tests T6 (rewritten per NA11), T7, T-NA1 (piecewise, no pump round trip per the chair's
// binding note — 21b-D1's envelope gap means a real pump round trip does not validate today),
// T-NA6, T-NA7, T-NB4. Harness copied from orchestration-federated-peer-send-pact-inbound.test.ts
// (B8): one-runtime RECEIVER harness, wire calls constructed directly rather than dialling a
// second runtime. FAILS AT BASE: base has no strict fence (any seq != peer_seq+1 throws the same
// pact_out_of_order regardless of gap size, never mints a nonce or queues repair), and
// resync/resync_request refuse pact_repair_not_yet_available unconditionally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { createThread } from '../../orchestration/thread-directory'
import type Database from '../../../sqlite/sync-database'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import type * as LinkBindingRoutable from '../../orchestration/link-binding-routable'
import { putPeerLinkBinding } from '../../orchestration/link-binding-store'
import { enqueueReplyOutbox, type RelayKind } from '../../orchestration/reply-outbox-store'
import { claimNextReplyOutboxItem } from '../../orchestration/reply-outbox-lifecycle'
import { PACT_MAX_GAP } from '../../orchestration/pact-federated-repair'
import type { RpcContext } from '../core'

vi.mock('../../orchestration/link-binding-routable', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkBindingRoutable>()
  return { ...actual, getRoutableLinkBinding: vi.fn(actual.getRoutableLinkBinding) }
})

const LINK_DEVICE_ID = 'dev_pact_repair_1'
const LINK_FINGERPRINT = 'fp_pact_repair_1'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SENDER_A = 'agt_a1b2c3d4e5f6'

function method(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
  const m = method(name)
  const parsed = m.params ? m.params.parse(params) : undefined
  return m.handler(parsed, context)
}

function raw(db: OrchestrationDb): {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown
    all: (...a: unknown[]) => unknown
    run: (...a: unknown[]) => unknown
  }
} {
  return (db as unknown as { db: ReturnType<typeof raw> }).db
}

function linkCtx(runtime: OrcaRuntimeService): RpcContext {
  return {
    runtime,
    pairedDeviceId: LINK_DEVICE_ID,
    clientKind: 'runtime',
    authenticatedCallerFingerprint: LINK_FINGERPRINT
  }
}

describe('S10-21b B9: strict fence, resync/resync_request/gap_notice, terminal disposition', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentB: string

  beforeEach(async () => {
    linkBindingSeeded = false
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) =>
      evidence?.terminalHandle === 'term_b' && evidence?.paneKey === PANE_B
        ? {
            hostScope: { kind: 'local', hostId: 'local' },
            paneKey: PANE_B,
            terminalHandle: 'term_b',
            processIncarnation: 'proc-1',
            launchTokenHash: 'hash'
          }
        : null
    )
    const registered = (await call(
      'orchestration.agents.register',
      { name: 'repair-answerer', role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_B } }
    )) as { agent: { id: string } }
    agentB = registered.agent.id
    vi.mocked(getRoutableLinkBinding).mockReturnValue({
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      peerKeyFingerprint: LINK_FINGERPRINT,
      peerCredentialFp: LINK_FINGERPRINT,
      boundPairingRevision: 1
    } as unknown as ReturnType<typeof getRoutableLinkBinding>)
  })

  afterEach(async () => {
    db?.close()
    const actual = await vi.importActual<typeof LinkBindingRoutable>(
      '../../orchestration/link-binding-routable'
    )
    vi.mocked(getRoutableLinkBinding).mockReset()
    vi.mocked(getRoutableLinkBinding).mockImplementation(actual.getRoutableLinkBinding)
  })

  let linkBindingSeeded = false

  // FORCED DEVIATION (S10-21b B8c, A-F15, item 7): gate 12's propose limb now requires the
  // rendered sender to be a live thread_participants row — added here so this file's existing
  // propose-verb tests keep passing under the new precondition.
  function seedPeerThread(peerThreadId: string): string {
    const { thread } = createThread(raw(db) as unknown as Database.Database, {
      subject: 'pact repair seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [
        { participantKey: agentB, agentId: agentB, role: 'member' },
        { participantKey: `remote:${LINK_DEVICE_ID}:${SENDER_A}`, agentId: null, role: 'member' }
      ]
    })
    raw(db)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ?,
           pact_peer_agent_id = ?, pact_peer_environment_id = ? WHERE id = ?`
      )
      .run(LINK_DEVICE_ID, peerThreadId, SENDER_A, LINK_DEVICE_ID, thread.id)
    // enqueueFederatedPactVerb (mintResyncRequestIfNeeded/applyInboundResyncRequestVerb's own
    // emit) requires a real peer_link_bindings row — seed it once per test.
    if (!linkBindingSeeded) {
      putPeerLinkBinding(raw(db) as unknown as Database.Database, {
        linkDeviceId: LINK_DEVICE_ID,
        environmentId: LINK_DEVICE_ID,
        boundEndpointId: 'endpoint_repair',
        boundPairingRevision: 1,
        linkCredentialFp: 'lcfp_repair',
        peerCredentialFp: LINK_FINGERPRINT,
        peerKeyFingerprint: LINK_FINGERPRINT,
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1',
        provedAt: Date.now(),
        lastVerifiedAt: Date.now()
      })
      linkBindingSeeded = true
    }
    return thread.id
  }

  function pactSend(pact: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: SENDER_A, displayName: 'asker-a', role: null },
        toAgentId: agentB,
        messageId: overrides.messageId ?? 'msg_ecded99005ce',
        threadId: overrides.threadId ?? 'thr_a1a1a1a1a1a1',
        subject: 'pact',
        pact,
        ...overrides
      },
      linkCtx(runtime)
    )
  }

  function threadRow(threadId: string): {
    pact_peer_seq: number
    pact_paused_at: string | null
    pact_relay_pending: string | null
    pact_repair_attempts: number
    pact_resync_nonce: string | null
    pact_ordinal: number
    pact_pause_epoch: number
  } {
    return raw(db)
      .prepare(
        `SELECT pact_peer_seq, pact_paused_at, pact_relay_pending, pact_repair_attempts,
                pact_resync_nonce, pact_ordinal, pact_pause_epoch
           FROM threads WHERE id = ?`
      )
      .get(threadId) as never
  }

  // The RPC layer's own generic per-call audit (verb='federatedSend') stamps the thrown error's
  // code as `outcome` too, so an unfiltered query over-counts — every check here is scoped to
  // THIS commit's own audit verbs ('pactRelay' from the fence/disposition, 'pact_resync' from
  // the resync apply), never the generic RPC-call audit.
  function auditCount(verb: string, outcome: string): number {
    return (
      raw(db)
        .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = ? AND outcome = ?`)
        .get(verb, outcome) as { n: number }
    ).n
  }

  describe('T6: the strict fence — seq inflation, unknown-messageId duplicate shape, small gap', () => {
    it('seq = 2^31-1 on an otherwise-fresh pact ⇒ pact_desync, never pact_out_of_order', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      await expect(
        pactSend(
          { verb: 'gap_notice', seq: 2 ** 31 - 1, era: 1 },
          { messageId: 'msg_c4f23feb6fa0' }
        )
      ).rejects.toMatchObject({ code: 'pact_desync' })
      const row = threadRow(threadId)
      expect(row.pact_paused_at).not.toBeNull()
    })

    it('a subsequent legitimate duplicate is still accepted silently after the desync', async () => {
      seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      await expect(
        pactSend(
          { verb: 'gap_notice', seq: 2 ** 31 - 1, era: 1 },
          { messageId: 'msg_b525367c00b9' }
        )
      ).rejects.toMatchObject({ code: 'pact_desync' })
      // Re-sending the ORIGINAL propose (same messageId/verb/seq) is still a genuine duplicate —
      // gate 8's dedupe, upstream of the fence, is unaffected by the desync disposition.
      await expect(
        pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      ).resolves.toMatchObject({ accepted: true })
    })

    it('duplicate-shaped verb (seq <= peer_seq) with an unknown messageId ⇒ pact_desync, audited', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      expect(auditCount('pactRelay', 'pact_desync')).toBe(0)
      await expect(
        pactSend({ verb: 'gap_notice', seq: 1, era: 1 }, { messageId: 'msg_1256999c54a7' })
      ).rejects.toMatchObject({ code: 'pact_desync' })
      expect(auditCount('pactRelay', 'pact_desync')).toBe(1)
      expect(threadRow(threadId).pact_paused_at).not.toBeNull()
    })

    it(`a small in-PACT_MAX_GAP jump (seq = peer_seq + 5) exercises pact_out_of_order and queues a resync_request`, async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      expect(5).toBeLessThanOrEqual(PACT_MAX_GAP)
      await expect(
        pactSend({ verb: 'gap_notice', seq: 6, era: 1 }, { messageId: 'msg_bbd4cce23632' })
      ).rejects.toMatchObject({ code: 'pact_out_of_order' })
      const row = threadRow(threadId)
      expect(row.pact_paused_at).toBeNull() // out_of_order is retryable, never a disposition
      expect(row.pact_resync_nonce).not.toBeNull()
      const outbox = raw(db)
        .prepare(`SELECT relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ?`)
        .all(threadId) as { relay_kind: string }[]
      expect(outbox.some((r) => r.relay_kind === 'pact_resync_request')).toBe(true)
    })

    it('a gap > PACT_MAX_GAP ⇒ pact_desync immediately', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      await expect(
        pactSend(
          { verb: 'gap_notice', seq: 2 + PACT_MAX_GAP + 1, era: 1 },
          { messageId: 'msg_03852d2d7730' }
        )
      ).rejects.toMatchObject({ code: 'pact_desync' })
      expect(threadRow(threadId).pact_paused_at).not.toBeNull()
    })
  })

  describe('T7: resync/resync_request hardening', () => {
    function seedEngagedPaused(threadId: string): void {
      raw(db)
        .prepare(
          `UPDATE threads SET pact_state = 'engaged',
             pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_turn_agent_id = ?,
             pact_paused_at = datetime('now'), pact_pause_reason = 'operator',
             pact_peer_seq = 3, pact_ordinal = 5
           WHERE id = ?`
        )
        .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, agentB, threadId)
    }

    it('resync answering a never-issued nonce is dropped and audited', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      seedEngagedPaused(threadId)
      expect(auditCount('pact_resync', 'dropped_unknown_nonce')).toBe(0)
      await expect(
        pactSend(
          {
            verb: 'resync',
            seq: 99,
            era: 0,
            resync: {
              nonce: 'never_issued_nonce_0001',
              localSeq: 10,
              ordinal: 999,
              state: 'engaged',
              turnHeldBySender: false,
              pauseEpoch: 0,
              senderReleased: false
            }
          },
          { messageId: 'msg_44a4502751e7' }
        )
      ).resolves.toMatchObject({ accepted: true })
      expect(auditCount('pact_resync', 'dropped_unknown_nonce')).toBe(1)
      // Dropped — no state changed.
      expect(threadRow(threadId).pact_peer_seq).toBe(3)
    })

    it('resync answering a superseded (stale) nonce is dropped silently — state unchanged', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      seedEngagedPaused(threadId)
      raw(db)
        .prepare(`UPDATE threads SET pact_resync_nonce = ?, pact_resync_nonce_at = ? WHERE id = ?`)
        .run('nonce_live_b', Date.now(), threadId)
      await expect(
        pactSend(
          {
            verb: 'resync',
            seq: 99,
            era: 0,
            resync: {
              nonce: 'nonce_stale_a',
              localSeq: 10,
              ordinal: 999,
              state: 'engaged',
              turnHeldBySender: false,
              pauseEpoch: 0,
              senderReleased: false
            }
          },
          { messageId: 'msg_3a9b0b84a517' }
        )
      ).resolves.toMatchObject({ accepted: true })
      expect(auditCount('pact_resync', 'dropped_unknown_nonce')).toBe(0)
      const row = threadRow(threadId)
      expect(row.pact_peer_seq).toBe(3)
      expect(row.pact_resync_nonce).toBe('nonce_live_b') // untouched — still the live one
    })

    it('an accepted resync NEVER sets pact_ordinal, even though the wire carries one', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      seedEngagedPaused(threadId)
      raw(db)
        .prepare(`UPDATE threads SET pact_resync_nonce = ?, pact_resync_nonce_at = ? WHERE id = ?`)
        .run('nonce_accept_1', Date.now(), threadId)
      await expect(
        pactSend(
          {
            verb: 'resync',
            seq: 99,
            era: 0,
            resync: {
              nonce: 'nonce_accept_1',
              localSeq: 10,
              ordinal: 777, // hostile wire value — must never land
              state: 'engaged',
              turnHeldBySender: false,
              pauseEpoch: 0,
              senderReleased: false
            }
          },
          { messageId: 'msg_4a1c2c7039f1' }
        )
      ).resolves.toMatchObject({ accepted: true })
      const row = threadRow(threadId)
      expect(row.pact_ordinal).toBe(5) // untouched — recomputed locally, never wire-assigned
      expect(row.pact_peer_seq).toBe(10)
      expect(row.pact_resync_nonce).toBeNull()
    })

    it('both resync_request and resync are applicable to a paused pact', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      seedEngagedPaused(threadId) // paused
      await expect(
        pactSend(
          { verb: 'resync_request', seq: 99, era: 0, resyncRequest: { nonce: 'peer_asks_1' } },
          { messageId: 'msg_5d7b78fb1e6f' }
        )
      ).resolves.toMatchObject({ accepted: true })
      const outbox = raw(db)
        .prepare(`SELECT relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ?`)
        .all(threadId) as { relay_kind: string }[]
      expect(outbox.some((r) => r.relay_kind === 'pact_resync')).toBe(true)

      raw(db)
        .prepare(`UPDATE threads SET pact_resync_nonce = ?, pact_resync_nonce_at = ? WHERE id = ?`)
        .run('nonce_paused_ok', Date.now(), threadId)
      await expect(
        pactSend(
          {
            verb: 'resync',
            seq: 99,
            era: 0,
            resync: {
              nonce: 'nonce_paused_ok',
              localSeq: 11,
              ordinal: 1,
              state: 'engaged',
              turnHeldBySender: false,
              pauseEpoch: 0,
              senderReleased: false
            }
          },
          { messageId: 'msg_0a207dc195eb' }
        )
      ).resolves.toMatchObject({ accepted: true })
    })
  })

  describe('T-NA1 (piecewise, per the chair note — no pump round trip): terminal settle → gap_notice; peer converges via resync_request → resync', () => {
    it('a terminal settle NOT in {pact_no_pact, pact_era_mismatch} queues gap_notice, never resync_request', () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      raw(db)
        .prepare(
          `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?,
             pact_with_agent_id = ?, pact_turn_agent_id = ? WHERE id = ?`
        )
        .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, agentB, threadId)
      const outboxId = enqueueReplyOutbox(raw(db) as unknown as Database.Database, {
        localMessageId: 'msg_f827ad36e09b',
        linkDeviceId: LINK_DEVICE_ID,
        environmentId: LINK_DEVICE_ID,
        boundPairingRevision: 1,
        peerCredentialFp: LINK_FINGERPRINT,
        peerKeyFingerprint: LINK_FINGERPRINT,
        inReplyToMessageId: 'msg_f827ad36e09b',
        peerAgentId: SENDER_A,
        peerThreadId: null,
        localThreadId: threadId,
        noticeRunId: null,
        noticePaneKey: null,
        payload: '{}',
        byteCount: 2,
        createdAt: Date.now(),
        pactThreadId: threadId,
        pactEra: 0,
        reserved: true,
        relayKind: 'pact_release' as RelayKind
      })
      // Claim it (state -> 'sending') so the settle's `WHERE state='sending'` matches.
      claimNextReplyOutboxItem(raw(db) as unknown as Database.Database, Date.now())
      const result = db.firePactTerminalSettleDisposition(
        {
          id: outboxId,
          pactThreadId: threadId,
          linkDeviceId: LINK_DEVICE_ID,
          consecutiveFailures: 0
        } as never,
        'body_gate_refused',
        'refused',
        Date.now()
      )
      expect(result.outcome).toBe('settled')
      const row = threadRow(threadId)
      expect(row.pact_relay_pending).toBe('gap_notice')
      expect(row.pact_paused_at).not.toBeNull()
    })

    it('nothing is queued for pact_no_pact/pact_era_mismatch (Addendum 6(5) carve-out)', () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      const outboxId = enqueueReplyOutbox(raw(db) as unknown as Database.Database, {
        localMessageId: 'msg_2f3b7e733a63',
        linkDeviceId: LINK_DEVICE_ID,
        environmentId: LINK_DEVICE_ID,
        boundPairingRevision: 1,
        peerCredentialFp: LINK_FINGERPRINT,
        peerKeyFingerprint: LINK_FINGERPRINT,
        inReplyToMessageId: 'msg_2f3b7e733a63',
        peerAgentId: SENDER_A,
        peerThreadId: null,
        localThreadId: threadId,
        noticeRunId: null,
        noticePaneKey: null,
        payload: '{}',
        byteCount: 2,
        createdAt: Date.now(),
        pactThreadId: threadId,
        pactEra: 0,
        reserved: true,
        relayKind: 'pact_release' as RelayKind
      })
      claimNextReplyOutboxItem(raw(db) as unknown as Database.Database, Date.now())
      db.firePactTerminalSettleDisposition(
        {
          id: outboxId,
          pactThreadId: threadId,
          linkDeviceId: LINK_DEVICE_ID,
          consecutiveFailures: 0
        } as never,
        'pact_no_pact',
        'refused',
        Date.now()
      )
      expect(threadRow(threadId).pact_relay_pending).toBeNull()
    })

    it('the RECEIVER of a gap_notice mints/queues a resync_request (same gap-handling as any other verb)', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      await expect(
        pactSend({ verb: 'gap_notice', seq: 10, era: 1 }, { messageId: 'msg_99a5d99cb44f' })
      ).rejects.toMatchObject({ code: 'pact_out_of_order' })
      const outbox = raw(db)
        .prepare(`SELECT relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ?`)
        .all(threadId) as { relay_kind: string }[]
      expect(outbox.some((r) => r.relay_kind === 'pact_resync_request')).toBe(true)
    })

    it('the RECEIVER of an in-order gap_notice no-ops: fence advances, no state change', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      await expect(
        pactSend({ verb: 'gap_notice', seq: 2, era: 1 }, { messageId: 'msg_e418368dd852' })
      ).resolves.toMatchObject({ accepted: true })
      expect(threadRow(threadId).pact_peer_seq).toBe(2)
    })
  })

  describe('T-NA6: the fresh-nonce gate', () => {
    it('repeated jittered retries of one lost verb increment pact_repair_attempts exactly once, until reset by an accepted resync', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      for (let i = 0; i < 5; i++) {
        await expect(
          pactSend(
            { verb: 'gap_notice', seq: 6, era: 1 },
            { messageId: `msg_${(1000000000000 + i).toString(16).padStart(12, '0')}` }
          )
        ).rejects.toMatchObject({ code: 'pact_out_of_order' })
      }
      const afterGaps = threadRow(threadId)
      expect(afterGaps.pact_repair_attempts).toBe(1) // one mint, four suppressed re-mints
      const nonce = afterGaps.pact_resync_nonce as string
      expect(nonce).not.toBeNull()

      await expect(
        pactSend(
          {
            verb: 'resync',
            seq: 99,
            era: 1,
            resync: {
              nonce,
              localSeq: 20,
              ordinal: 1,
              state: 'proposed',
              turnHeldBySender: false,
              pauseEpoch: 0,
              senderReleased: false
            }
          },
          { messageId: 'msg_83113fee1db9' }
        )
      ).resolves.toMatchObject({ accepted: true })
      const afterResync = threadRow(threadId)
      expect(afterResync.pact_repair_attempts).toBe(0)
      expect(afterResync.pact_resync_nonce).toBeNull()
    })
  })

  describe('T-NA7: an exempted pact verb is claimable behind a held item on the same pact, still blocked by every other guard', () => {
    function enqueueOn(
      threadId: string,
      relayKind: RelayKind,
      overrides: Partial<Parameters<typeof enqueueReplyOutbox>[1]> = {}
    ): string {
      return enqueueReplyOutbox(raw(db) as unknown as Database.Database, {
        localMessageId: `msg_repair_na7_${relayKind}_${Math.random()}`,
        linkDeviceId: LINK_DEVICE_ID,
        environmentId: LINK_DEVICE_ID,
        boundPairingRevision: 1,
        peerCredentialFp: LINK_FINGERPRINT,
        peerKeyFingerprint: LINK_FINGERPRINT,
        inReplyToMessageId: 'msg_a661a1dbf90d',
        peerAgentId: SENDER_A,
        peerThreadId: null,
        localThreadId: threadId,
        noticeRunId: null,
        noticePaneKey: null,
        payload: '{}',
        byteCount: 2,
        createdAt: Date.now(),
        pactThreadId: threadId,
        pactEra: 0,
        reserved: true,
        relayKind,
        ...overrides
      })
    }

    it('an exempt resync_request is claimable even though a held (backed-off) item sits ahead on the same pact', () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      const heldId = enqueueOn(threadId, 'pact_step')
      // Hold it: next_attempt_after in the future excludes it from candidacy entirely.
      raw(db)
        .prepare(`UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?`)
        .run(Date.now() + 3_600_000, heldId)
      const exemptId = enqueueOn(threadId, 'pact_resync_request')
      const claimed = claimNextReplyOutboxItem(raw(db) as unknown as Database.Database, Date.now())
      expect(claimed?.id).toBe(exemptId)
    })

    it('the SAME exempt verb is still blocked by the per-route in-flight guard', () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      enqueueOn(threadId, 'pact_gap_notice')
      const inFlight = claimNextReplyOutboxItem(raw(db) as unknown as Database.Database, Date.now())
      expect(inFlight).not.toBeNull() // claims the only item — now 'sending' on this route
      const secondThread = seedPeerThread('thr_a2a2a2a2a2a2')
      enqueueOn(secondThread, 'pact_resync_request')
      const blocked = claimNextReplyOutboxItem(raw(db) as unknown as Database.Database, Date.now())
      expect(blocked).toBeNull() // same route already 'sending' — the per-route guard is not exempt
    })
  })

  describe('T-NB4: the resync nonce TTL — an unanswered resync_request does not permanently suppress repair', () => {
    it('an EXPIRED nonce is treated as absent — the next gap mints fresh, re-queues, increments as a first-ever gap would', async () => {
      const threadId = seedPeerThread('thr_a1a1a1a1a1a1')
      await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
      await expect(
        pactSend({ verb: 'gap_notice', seq: 6, era: 1 }, { messageId: 'msg_50ecfe7e9b0a' })
      ).rejects.toMatchObject({ code: 'pact_out_of_order' })
      const afterFirst = threadRow(threadId)
      expect(afterFirst.pact_repair_attempts).toBe(1)
      // Simulate the 24h TTL having elapsed (errata NB4: pact_resync_nonce_at is INTEGER epoch-ms).
      raw(db)
        .prepare(`UPDATE threads SET pact_resync_nonce_at = ? WHERE id = ?`)
        .run(Date.now() - 86_400_001, threadId)
      await expect(
        pactSend({ verb: 'gap_notice', seq: 6, era: 1 }, { messageId: 'msg_1073b61ff8cf' })
      ).rejects.toMatchObject({ code: 'pact_out_of_order' })
      const afterExpiry = threadRow(threadId)
      // A fresh mint — attempts increments again (the live-nonce suppression did NOT apply to an
      // expired one), and a second resync_request outbox row was queued.
      expect(afterExpiry.pact_repair_attempts).toBe(2)
      const outbox = raw(db)
        .prepare(
          `SELECT COUNT(*) AS n FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_resync_request'`
        )
        .get(threadId) as { n: number }
      expect(outbox.n).toBe(2)
    })
  })
})
