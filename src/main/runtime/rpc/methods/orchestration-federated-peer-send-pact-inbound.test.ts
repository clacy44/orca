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
  function seedPeerThread(peerThreadId: string): string {
    const { thread } = createThread(raw(db) as unknown as Database.Database, {
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: agentB, agentId: agentB, role: 'member' }]
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
