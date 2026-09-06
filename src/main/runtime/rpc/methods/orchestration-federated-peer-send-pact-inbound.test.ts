// S10-21b B8 (design §4.2 gates 6-13, §2.5's happy-path fence, §2.1 field ownership) — inbound
// pact-verb apply tests T1, T2, T4, T13, T16, T25, T27, T28, T-NA3, T-NB6 (§8.1). One-runtime
// RECEIVER harness (workerDb/workerRuntime plays the receiving host; the peer's wire calls are
// constructed directly, per the existing orchestration-federated-peer-send.test.ts pattern of
// calling the RPC handler with hand-built params rather than dialling a second runtime) — B6's
// emit path is not wired into propose/accept/pause/resume/release yet (only `step`, per its own
// brief), so a real two-runtime relay round trip is not yet constructible; every test here
// exercises the RECEIVING side's gates/apply against a directly-constructed inbound envelope,
// matching the brief's own instruction for T-NB6's gap_notice half.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { createThread } from '../../orchestration/thread-directory'
import type Database from '../../../sqlite/sync-database'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import { putPeerLinkBinding } from '../../orchestration/link-binding-store'
import type * as LinkBindingRoutable from '../../orchestration/link-binding-routable'
import { PACT_STEPS_PER_PACT_CAP } from '../../orchestration/pact-federated-inbound-apply'
import type { RpcContext } from '../core'

vi.mock('../../orchestration/link-binding-routable', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkBindingRoutable>()
  return { ...actual, getRoutableLinkBinding: vi.fn(actual.getRoutableLinkBinding) }
})

const LINK_DEVICE_ID = 'dev_pact_link_1'
const LINK_FINGERPRINT = 'fp_pact_link_1'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SENDER_A = 'agt_aaaaaaaaaaaa'

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

describe('S10-21b B8 inbound pact apply', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentB: string

  beforeEach(async () => {
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
      { name: 'answerer', role: 'test agent' },
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

  // Seeds a local thread already peer-anchored to (LINK_DEVICE_ID, peerThreadId) — the state an
  // ordinary mail exchange would have left before a pact is ever proposed on it (§1.4).
  // FORCED DEVIATION (A-F15, item 7): gate 12's propose limb now requires the rendered sender to
  // be a live thread_participants row — a precondition every pre-existing test in this file
  // relied on implicitly without ever seeding it. `includeSenderParticipant` (default true, so
  // every existing call site is unaffected) adds the SENDER_A rendered key as a participant,
  // matching the ordinary-mail-exchange precondition design's own comment describes; the new
  // A-F15 test below passes `false` to construct the one case that must still be refused.
  function seedPeerThread(
    peerThreadId: string,
    includeSenderParticipant = true,
    sensitive = false
  ): string {
    const participants: { participantKey: string; agentId: string | null; role: 'member' }[] = [
      { participantKey: agentB, agentId: agentB, role: 'member' }
    ]
    if (includeSenderParticipant) {
      participants.push({
        participantKey: `remote:${LINK_DEVICE_ID}:${SENDER_A}`,
        agentId: null,
        role: 'member' as const
      })
    }
    const { thread } = createThread(raw(db) as unknown as Database.Database, {
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      sensitive,
      participants
    })
    raw(db)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ? WHERE id = ?`
      )
      .run(LINK_DEVICE_ID, peerThreadId, thread.id)
    return thread.id
  }

  function pactSend(pact: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: SENDER_A, displayName: 'asker-a', role: null },
        toAgentId: agentB,
        messageId: overrides.messageId ?? 'msg_aaaaaaaaaaa1',
        threadId: overrides.threadId ?? 'thr_aaaaaaaaaaa1',
        subject: 'pact',
        pact,
        ...overrides
      },
      linkCtx(runtime)
    )
  }

  it('T1: propose applies — pact_state proposed, pact_not_federated never raised', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    await expect(
      pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    ).resolves.toMatchObject({ accepted: true })
    const row = raw(db)
      .prepare(
        'SELECT pact_state, pact_with_agent_id, pact_proposer_agent_id FROM threads WHERE id = ?'
      )
      .get(threadId) as {
      pact_state: string
      pact_with_agent_id: string
      pact_proposer_agent_id: string
    }
    expect(row.pact_state).toBe('proposed')
    expect(row.pact_with_agent_id).toBe(agentB)
    expect(row.pact_proposer_agent_id).toBe(`remote:${LINK_DEVICE_ID}:${SENDER_A}`)
  })

  it('T2: inbound accept ⇒ engaged, turn = proposer', async () => {
    // Local (agentB) is the PROPOSER here — A is the addressee accepting inbound, so
    // pact_with_agent_id must be A's rendered key for gate 13's accept precondition.
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ? WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, threadId)
    await pactSend({ verb: 'accept', seq: 1, era: 0 })
    const row = raw(db)
      .prepare(
        'SELECT pact_state, pact_turn_agent_id, pact_proposer_agent_id FROM threads WHERE id = ?'
      )
      .get(threadId) as {
      pact_state: string
      pact_turn_agent_id: string
      pact_proposer_agent_id: string
    }
    expect(row.pact_state).toBe('engaged')
    expect(row.pact_turn_agent_id).toBe(row.pact_proposer_agent_id)
    expect(row.pact_proposer_agent_id).toBe(agentB)
  })

  it('T4: duplicate relay applies once; same id, different verb ⇒ request_mismatch', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    // Genuine duplicate: same messageId, same verb/seq — applies nothing a second time.
    await expect(
      pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    ).resolves.toMatchObject({ accepted: true })
    const count = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE message_id = 'msg_aaaaaaaaaaa1'`)
      .get() as { n: number }
    expect(count.n).toBe(1)
    // Same messageId, a DIFFERENT verb ⇒ request_mismatch (never a silent re-apply).
    await expect(pactSend({ verb: 'accept', seq: 2, era: 1 })).rejects.toMatchObject({
      code: 'request_mismatch'
    })
  })

  it('T13: quarantined link refuses at gate 3, before the identity importer runs', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    db.putContainment({
      subjectKind: 'link',
      subjectId: LINK_DEVICE_ID,
      action: 'quarantine',
      reasonCode: null,
      reasonText: null,
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })
    await expect(pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })).rejects.toThrow()
    const mirrored = raw(db)
      .prepare(`SELECT 1 FROM remote_agents WHERE remote_agent_id = ?`)
      .get(SENDER_A)
    expect(mirrored).toBeUndefined()
  })

  it('T16: identity outcomes capped/absent/invalid refuse pact_identity_unmirrored, no state change', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    // absent: no fromAgent at all.
    await expect(
      call(
        'orchestration.federatedSend',
        {
          toAgentId: agentB,
          messageId: 'msg_aaaaaaaaaaa3',
          threadId: 'thr_aaaaaaaaaaa1',
          subject: 'pact',
          pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
        },
        linkCtx(runtime)
      )
    ).rejects.toMatchObject({ code: 'pact_identity_unmirrored' })
    // invalid: malformed sender id shape.
    await expect(
      pactSend(
        { verb: 'propose', seq: 1, era: 1, stepsTotal: null },
        {
          fromAgent: { id: 'not-a-valid-id', displayName: 'sender-x', role: null },
          messageId: 'msg_aaaaaaaaaaa4'
        }
      )
    ).rejects.toMatchObject({ code: 'pact_identity_unmirrored' })
    const row = raw(db).prepare('SELECT pact_state FROM threads WHERE id = ?').get(threadId) as {
      pact_state: string | null
    }
    expect(row.pact_state).toBeNull()
  })

  it('T25: payload:{kind:"pact_step"} from a peer is still refused payload_kind_reserved', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    await expect(
      call(
        'orchestration.federatedSend',
        {
          fromAgent: { id: SENDER_A, displayName: 'asker-a', role: null },
          toAgentId: agentB,
          messageId: 'msg_aaaaaaaaaaa5',
          threadId: 'thr_aaaaaaaaaaa1',
          subject: 'hi',
          payload: { kind: 'pact_step' }
        },
        linkCtx(runtime)
      )
    ).rejects.toMatchObject({
      code: 'body_gate_refused',
      data: { ruleIds: ['payload_kind_reserved'] }
    })
  })

  it('T27: control verbs are audit_only; step is current_delivery', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ? WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, threadId)
    await pactSend({ verb: 'accept', seq: 1, era: 0 })
    // Turn is now the local proposer's — a peer step needs to hold the turn, so hand it back.
    raw(db)
      .prepare(`UPDATE threads SET pact_turn_agent_id = ? WHERE id = ?`)
      .run(`remote:${LINK_DEVICE_ID}:${SENDER_A}`, threadId)
    await pactSend(
      { verb: 'step', seq: 2, era: 0 },
      { messageId: 'msg_aaaaaaaaaaa2', body: 'did the thing' }
    )
    await pactSend({ verb: 'release', seq: 3, era: 0 }, { messageId: 'msg_aaaaaaaaaaa3' })
    const rows = raw(db)
      .prepare(`SELECT payload_kind, delivery_contract FROM messages ORDER BY sequence`)
      .all() as { payload_kind: string; delivery_contract: string }[]
    const controlRows = rows.filter((r) => r.payload_kind !== 'pact_step')
    const stepRows = rows.filter((r) => r.payload_kind === 'pact_step')
    expect(controlRows.length).toBeGreaterThan(0)
    expect(stepRows.length).toBe(1)
    expect(controlRows.every((r) => r.delivery_contract === 'audit_only')).toBe(true)
    expect(stepRows.every((r) => r.delivery_contract === 'current_delivery')).toBe(true)
  })

  it('T28: id grammar — a hostile threadId ⇒ invalid_argument, one audit row, no wire echo', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    const before = raw(db).prepare(`SELECT COUNT(*) AS n FROM agent_audit`).get() as { n: number }
    let caught: unknown
    try {
      await pactSend(
        { verb: 'propose', seq: 1, era: 1, stepsTotal: null },
        { threadId: "'; DROP TABLE threads; --" }
      )
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('invalid_argument')
    expect((caught as { message?: string } | undefined)?.message ?? '').not.toContain('DROP TABLE')
    const after = raw(db).prepare(`SELECT COUNT(*) AS n FROM agent_audit`).get() as { n: number }
    expect(after.n).toBe(before.n + 1)
  })

  it('T-NA3: resetMessages does not turn a gap_notice retry into pact_desync', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    await pactSend({ verb: 'gap_notice', seq: 2, era: 1 }, { messageId: 'msg_aaaaaaaaaaa2' })
    const applied = raw(db)
      .prepare(`SELECT 1 FROM pact_applied_ids WHERE message_id = 'msg_aaaaaaaaaaa2'`)
      .get()
    expect(applied).toBeDefined()
    // resetMessages: deletes `messages` only, leaves pact_steps/pact_applied_ids intact.
    raw(db).prepare(`DELETE FROM messages`).run()
    await expect(
      pactSend({ verb: 'gap_notice', seq: 2, era: 1 }, { messageId: 'msg_aaaaaaaaaaa2' })
    ).resolves.toMatchObject({ accepted: true })
  })

  it('T-NB6: pact_applied_ids over-cap refuses pact_ledger_capped; gap_notice-after-reset is a duplicate', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    const seedNow = new Date().toISOString()
    const insertMany = raw(db).prepare(
      `INSERT INTO pact_applied_ids (thread_id, message_id, verb, applied_at) VALUES (?, ?, 'gap_notice', ?)`
    )
    for (let i = 0; i < PACT_STEPS_PER_PACT_CAP; i++) {
      insertMany.run(threadId, `msg_capfiller_${i.toString().padStart(6, '0')}`, seedNow)
    }
    await expect(
      pactSend({ verb: 'gap_notice', seq: 2, era: 1 }, { messageId: 'msg_aaaaaaaaaaa2' })
    ).rejects.toMatchObject({ code: 'pact_ledger_capped' })
  })

  // S10-21b B8c (D-R134/D-R135 batch-2 review, README "after D-R134/D-R135") — the 13 items,
  // each RED at base per the brief unless marked otherwise.

  it('B8c item 2 (B-F3): inbound resume clears OUR RECORD of the peer pause, gated on it alone', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_peer_paused_at = datetime('now') WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, agentB, threadId)
    await expect(pactSend({ verb: 'resume', seq: 1, era: 0 })).resolves.toMatchObject({
      accepted: true
    })
    const row = raw(db)
      .prepare('SELECT pact_peer_paused_at FROM threads WHERE id = ?')
      .get(threadId) as { pact_peer_paused_at: string | null }
    expect(row.pact_peer_paused_at).toBeNull()
  })

  it('B8c item 2 (B-F3/N5, CORRECTED): inbound resume against a peer never recorded as paused is an accepted idempotent no-op, never pact_not_paused', async () => {
    // CORRECTED (D-R136 N5): `pact_not_paused` had no classifier entry (disposition.ts) and
    // drove the link's own failure threshold on a duplicate/late resume — now an accepted
    // idempotent no-op, mirroring A-F17's release_noop.
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ? WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, agentB, threadId)
    await expect(pactSend({ verb: 'resume', seq: 1, era: 0 })).resolves.toMatchObject({
      accepted: true
    })
    const row = raw(db)
      .prepare('SELECT pact_peer_paused_at FROM threads WHERE id = ?')
      .get(threadId) as { pact_peer_paused_at: string | null }
    expect(row.pact_peer_paused_at).toBeNull()
  })

  it('B8c item 3 (B-F13): inbound accept refuses pact_paused when this host has paused for containment', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_paused_at = datetime('now') WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, threadId)
    await expect(pactSend({ verb: 'accept', seq: 1, era: 0 })).rejects.toMatchObject({
      code: 'pact_paused'
    })
  })

  it('B8c item 4 (A-F16/B-F4): pact_applied_ids dedupe is scoped per-thread, not globally by message_id', async () => {
    // P and Q use DIFFERENT remote peers so their (proposer, with) pairs differ — idx_pact_pair_
    // live (one live pact per literal pair) is orthogonal to this item and must not fire here.
    const SENDER_Q = 'agt_bbbbbbbbbbbb'
    // A real peer_link_bindings row — enqueueFederatedPactVerb's own anchor check reads this
    // table directly, upstream of the RPC layer's mocked getRoutableLinkBinding.
    putPeerLinkBinding(raw(db) as unknown as Database.Database, {
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      boundEndpointId: 'endpoint_item4',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: LINK_FINGERPRINT,
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    const threadP = seedPeerThread('thr_bbbbbbbbbbb1')
    const threadQ = seedPeerThread('thr_ccccccccccc1')
    const senderKeyP = `remote:${LINK_DEVICE_ID}:${SENDER_A}`
    const senderKeyQ = `remote:${LINK_DEVICE_ID}:${SENDER_Q}`
    // pact_peer_agent_id makes each thread a genuinely federated pact (isFederatedPact) — needed
    // since applyInboundResyncRequestVerb enqueues a real `resync` answer.
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_peer_agent_id = ?, pact_peer_environment_id = ? WHERE id = ?`
      )
      .run(agentB, senderKeyP, agentB, SENDER_A, LINK_DEVICE_ID, threadP)
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_peer_agent_id = ?, pact_peer_environment_id = ? WHERE id = ?`
      )
      .run(agentB, senderKeyQ, agentB, SENDER_Q, LINK_DEVICE_ID, threadQ)
    await expect(
      pactSend(
        { verb: 'resync_request', seq: 1, era: 0, resyncRequest: { nonce: 'nonceP1' } },
        { threadId: 'thr_bbbbbbbbbbb1', messageId: 'msg_ddddddddddd1' }
      )
    ).resolves.toMatchObject({ accepted: true, threadId: threadP })
    // Same message_id, a DIFFERENT pact (Q, a different peer entirely) — must apply for real,
    // never be swallowed as a duplicate of P's row, and never return P's (or the wire's)
    // threadId in the receipt.
    await expect(
      pactSend(
        { verb: 'resync_request', seq: 1, era: 0, resyncRequest: { nonce: 'nonceQ1' } },
        {
          threadId: 'thr_ccccccccccc1',
          messageId: 'msg_ddddddddddd1',
          fromAgent: { id: SENDER_Q, displayName: 'asker-q', role: null }
        }
      )
    ).resolves.toMatchObject({ accepted: true, threadId: threadQ })
    const rows = raw(db)
      .prepare(`SELECT thread_id FROM pact_applied_ids WHERE message_id = 'msg_ddddddddddd1'`)
      .all() as { thread_id: string }[]
    expect(rows.map((r) => r.thread_id).sort()).toEqual([threadP, threadQ].sort())
  })

  it('B8c item 5 (A-F9/B-F7): era adoption commits only inside the propose transaction — a gate-refused propose leaves era/seq untouched', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    const before = raw(db)
      .prepare('SELECT pact_era, pact_local_seq, pact_peer_seq FROM threads WHERE id = ?')
      .get(threadId) as { pact_era: number; pact_local_seq: number; pact_peer_seq: number }
    await expect(
      pactSend(
        { verb: 'propose', seq: 1, era: 5, stepsTotal: null },
        { body: 'SECURITY: hostile relayed content' }
      )
    ).rejects.toMatchObject({ code: 'gate_refused' })
    const after = raw(db)
      .prepare(
        'SELECT pact_era, pact_local_seq, pact_peer_seq, pact_state FROM threads WHERE id = ?'
      )
      .get(threadId) as {
      pact_era: number
      pact_local_seq: number
      pact_peer_seq: number
      pact_state: string | null
    }
    expect(after.pact_era).toBe(before.pact_era)
    expect(after.pact_local_seq).toBe(before.pact_local_seq)
    expect(after.pact_peer_seq).toBe(before.pact_peer_seq)
    expect(after.pact_state).toBeNull()
  })

  it('B8c item 5 (A-F9/B-F7): an adopted era at the grammar ceiling is refused invalid_argument, never adopted', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    await expect(
      pactSend({ verb: 'propose', seq: 1, era: 2 ** 31 - 2, stepsTotal: null })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('B8c item 6 (A-F8): inbound propose must have seq === 1; a peer proposing at seq 5 is refused pact_out_of_order', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1')
    await expect(
      pactSend({ verb: 'propose', seq: 5, era: 1, stepsTotal: null })
    ).rejects.toMatchObject({ code: 'pact_out_of_order' })
  })

  it('B8c item 7 (A-F15/N2, CORRECTED): gate 12s propose limb refuses a sender who is not a live thread participant on a SENSITIVE thread', async () => {
    // CORRECTED from a non-sensitive seed (D-R136 N2): the participant requirement now mirrors
    // the local rule (pact-shared.ts's requireSensitiveMembership) and applies only when the
    // thread is sensitive — this is the one case still refused.
    seedPeerThread('thr_aaaaaaaaaaa1', false, true)
    await expect(
      pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    ).rejects.toMatchObject({ code: 'not_a_participant' })
  })

  it('N2: a non-sensitive thread admits a propose from a sender who is not a live thread participant', async () => {
    seedPeerThread('thr_aaaaaaaaaaa1', false, false)
    await expect(
      pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    ).resolves.toMatchObject({ accepted: true })
  })

  it('B8c item 8 (A-F17): inbound release on an unmapped thread is an accepted idempotent no-op; every other verb still pact_no_pact', async () => {
    await expect(
      pactSend(
        { verb: 'release', seq: 1, era: 0 },
        { threadId: 'thr_000000000000', messageId: 'msg_eeeeeeeeeee1' }
      )
    ).resolves.toMatchObject({ accepted: true })
    await expect(
      pactSend(
        { verb: 'step', seq: 1, era: 0 },
        { threadId: 'thr_000000000000', messageId: 'msg_eeeeeeeeeee2' }
      )
    ).rejects.toMatchObject({ code: 'pact_no_pact' })
  })

  it('B8c item 9 (B-F11): the pair guard runs before B10s tie-break — a second-thread engaged pact (via the identity fallback, T30s own re-registration shape) refuses typed, never the raw UNIQUE error', async () => {
    const senderKey = `remote:${LINK_DEVICE_ID}:${SENDER_A}`
    // A re-registered predecessor of the SAME (link, display_name) identity — matches T30's own
    // "re-registered duplicate peer" fixture. Its LITERAL rendered key differs from SENDER_A's,
    // so seeding Y's pair below never collides with idx_pact_pair_live (a literal-id unique
    // index); only the identity-fallback pair guard (getEngagedPactWithByIdentity) sees it.
    // NOTE: SENDER_A's OWN remote_agents row is (re)written by the RPC's own identity-import
    // gate from the wire's `fromAgent.displayName` ('asker-a', pactSend's own default) — any
    // pre-seeded display_name for SENDER_A here would just be clobbered, so the predecessor's
    // display_name is set to match that wire-asserted value instead.
    const SENDER_A_PREDECESSOR = 'agt_dddddddddddd'
    db.upsertRemoteAgent({
      environmentId: LINK_DEVICE_ID,
      environmentName: LINK_DEVICE_ID,
      linkKind: 'environment',
      remoteAgentId: SENDER_A_PREDECESSOR,
      displayName: 'asker-a',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    const threadX = seedPeerThread('thr_000000000000')
    const threadY = seedPeerThread('thr_bbbbbbbbbbb1')
    // X: an outstanding LOCAL proposal to this exact peer — shapes B10's own tie-break match.
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ? WHERE id = ?`
      )
      .run(agentB, senderKey, threadX)
    // Y: a SECOND thread already engaged with the SAME (link, display_name) identity, under the
    // re-registered predecessor id — the identity-aware pair guard (T30) must still catch this
    // even though B10's own tie-break match (literal-column) never sees it.
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ? WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A_PREDECESSOR}`, agentB, threadY)
    // The wire threadId ('thr_000000000000', all-zero, sorts below virtually any generated
    // local id) makes X the tie-break's LOSER — 'incoming_wins' — the exact path that skipped
    // the pair guard at base.
    await expect(
      pactSend(
        { verb: 'propose', seq: 1, era: 1, stepsTotal: null },
        { threadId: 'thr_000000000000', messageId: 'msg_fffffffffff1' }
      )
    ).rejects.toMatchObject({ code: 'pact_exists_with_peer' })
  })

  it('B8c item 10 (A-F5): a turn-consuming verb arriving during OUR own in-flight emit is retryable pact_settling, never not_a_participant', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    const senderKey = `remote:${LINK_DEVICE_ID}:${SENDER_A}`
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_turn_in_flight_at = datetime('now') WHERE id = ?`
      )
      .run(agentB, senderKey, senderKey, threadId)
    await expect(
      pactSend({ verb: 'step', seq: 1, era: 0 }, { body: 'peer steps mid-settle' })
    ).rejects.toMatchObject({ code: 'pact_settling' })
  })

  it('B8c item 11 (A(ix)/B-F12): a resync-driven release clears turn/paused and writes a ledger row, never pact_release_at', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    const senderKey = `remote:${LINK_DEVICE_ID}:${SENDER_A}`
    const nonce = 'resyncrelnonce1'
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_paused_at = datetime('now'), pact_pause_reason = 'operator',
           pact_resync_nonce = ?, pact_resync_nonce_at = ? WHERE id = ?`
      )
      .run(agentB, senderKey, agentB, nonce, Date.now(), threadId)
    await expect(
      pactSend(
        {
          verb: 'resync',
          seq: 1,
          era: 0,
          resync: {
            nonce,
            localSeq: 5,
            ordinal: 3,
            state: 'released',
            turnHeldBySender: false,
            pauseEpoch: 0,
            senderReleased: true
          }
        },
        { messageId: 'msg_000000000001' }
      )
    ).resolves.toMatchObject({ accepted: true })
    const row = raw(db)
      .prepare(
        `SELECT pact_state, pact_turn_agent_id, pact_paused_at, pact_pause_reason,
           pact_release_at, pact_peer_release_at FROM threads WHERE id = ?`
      )
      .get(threadId) as {
      pact_state: string
      pact_turn_agent_id: string | null
      pact_paused_at: string | null
      pact_pause_reason: string | null
      pact_release_at: string | null
      pact_peer_release_at: string | null
    }
    expect(row.pact_state).toBe('released')
    expect(row.pact_turn_agent_id).toBeNull()
    expect(row.pact_paused_at).toBeNull()
    expect(row.pact_pause_reason).toBeNull()
    expect(row.pact_release_at).toBeNull()
    expect(row.pact_peer_release_at).not.toBeNull()
    const ledgerRow = raw(db)
      .prepare(`SELECT kind FROM pact_steps WHERE thread_id = ? AND kind = 'release'`)
      .get(threadId)
    expect(ledgerRow).toBeDefined()
  })

  it('B8c item 13 (A-F4 inbound half): an applied inbound propose bumps pact_flight_token', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    await pactSend({ verb: 'propose', seq: 1, era: 1, stepsTotal: null })
    const row = raw(db)
      .prepare('SELECT pact_flight_token FROM threads WHERE id = ?')
      .get(threadId) as { pact_flight_token: number }
    expect(row.pact_flight_token).toBeGreaterThan(0)
  })

  it('B8c item 13 (A-F4 inbound half): an applied inbound accept bumps pact_flight_token', async () => {
    const threadId = seedPeerThread('thr_aaaaaaaaaaa1')
    raw(db)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ? WHERE id = ?`
      )
      .run(agentB, `remote:${LINK_DEVICE_ID}:${SENDER_A}`, threadId)
    await pactSend({ verb: 'accept', seq: 1, era: 0 })
    const row = raw(db)
      .prepare('SELECT pact_flight_token FROM threads WHERE id = ?')
      .get(threadId) as { pact_flight_token: number }
    expect(row.pact_flight_token).toBeGreaterThan(0)
  })

  // D-R136 N8 — unreachable through gate 12 today (it guarantees the sender is a named party and
  // exactly one party is local), but the write was unguarded — a synthetic thread where the
  // OTHER (non-sender) party is ALSO remote must refuse rather than null the turn column.
  it('N8: an inbound step whose other local party is itself remote refuses pact_party_unresolved, never writes NULL into the turn column', async () => {
    const senderKey = `remote:${LINK_DEVICE_ID}:${SENDER_A}`
    const otherRemoteKey = `remote:${LINK_DEVICE_ID}:other_remote_1`
    const { thread } = createThread(raw(db) as unknown as Database.Database, {
      subject: 'pact seed n8',
      createdByAgentId: null,
      origin: 'peer',
      participants: [
        { participantKey: senderKey, agentId: null, role: 'member' },
        { participantKey: otherRemoteKey, agentId: null, role: 'member' }
      ]
    })
    raw(db)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ?,
           pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_turn_agent_id = ?, pact_peer_seq = 0 WHERE id = ?`
      )
      .run(LINK_DEVICE_ID, 'thr_aaaaaaaaaaa8', senderKey, otherRemoteKey, senderKey, thread.id)

    await expect(
      pactSend({ verb: 'step', seq: 1, era: 0 }, { threadId: 'thr_aaaaaaaaaaa8', body: 'x' })
    ).rejects.toMatchObject({ code: 'pact_party_unresolved' })

    const row = raw(db)
      .prepare('SELECT pact_turn_agent_id FROM threads WHERE id = ?')
      .get(thread.id) as { pact_turn_agent_id: string | null }
    expect(row.pact_turn_agent_id).toBe(senderKey)
  })
})

// SCOPE item 7 (K25's second minter, design §2.4's closing paragraph): only `appendPactStep`
// (pact-step.ts, whose federated delegate is pact-federated-emit.ts) and this commit's own
// inbound apply may ever construct a `hostPayloadKind` capable of equalling `'pact_step'`. A
// static scan, not a DB test — the invariant is about which SOURCE FILES call
// `insertGatedMessage` with that argument, not runtime behaviour.
describe('K25 second minter (design §2.4 closing paragraph)', () => {
  it('no fourth caller sets hostPayloadKind capable of pact_step', () => {
    const allowed = new Set([
      'pact-step.ts',
      'pact-federated-emit.ts',
      'pact-federated-inbound-apply.ts'
    ])
    const root = join(__dirname, '..', '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
          const text = readFileSync(full, 'utf8')
          if (/hostPayloadKind:\s*(`pact_\$\{|'pact_step')/.test(text) && !allowed.has(entry)) {
            offenders.push(entry)
          }
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
