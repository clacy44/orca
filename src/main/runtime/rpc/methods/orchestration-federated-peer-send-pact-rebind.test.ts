// S10-21b B13 (design §1.4(b), §2.10, §2.11) — `rebind_party` inbound apply tests T17-T19 plus
// the retry-idempotency test the chair's transaction-shape answer requires (README "CHAIR
// ANSWERS for B13"). Same one-runtime RECEIVER harness as orchestration-federated-peer-send-
// pact-inbound.test.ts (B8) — the peer's wire calls are constructed directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { createThread } from '../../orchestration/thread-directory'
import { adoptEraOnInboundPropose } from '../../orchestration/pact-federated-era'
import type Database from '../../../sqlite/sync-database'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import { repointFederatedPactParty } from '../../orchestration/pact-federated-identity'
import type * as LinkBindingRoutable from '../../orchestration/link-binding-routable'
import type { RpcContext } from '../core'

vi.mock('../../orchestration/link-binding-routable', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkBindingRoutable>()
  return { ...actual, getRoutableLinkBinding: vi.fn(actual.getRoutableLinkBinding) }
})

const LINK_DEVICE_ID = 'dev_pact_rebind_1'
const LINK_FINGERPRINT = 'fp_pact_rebind_1'
const PANE_B = 'tabB:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OLD_SENDER_ID = 'agt_bbbbbbbbbbb1'
const NEW_SENDER_ID = 'agt_bbbbbbbbbbb2'
const SENDER_DISPLAY_NAME = 'asker-b'

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

describe('S10-21b B13: rebind_party inbound apply', () => {
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
    // The OLD mirror row — as if an earlier ordinary exchange with OLD_SENDER_ID had already
    // mirrored it (clause 3's precondition: the row rebind_party is trying to supersede).
    db.upsertRemoteAgent({
      environmentId: LINK_DEVICE_ID,
      environmentName: LINK_DEVICE_ID,
      linkKind: 'paired_device',
      remoteAgentId: OLD_SENDER_ID,
      displayName: SENDER_DISPLAY_NAME,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
  })

  afterEach(async () => {
    db?.close()
    const actual = await vi.importActual<typeof LinkBindingRoutable>(
      '../../orchestration/link-binding-routable'
    )
    vi.mocked(getRoutableLinkBinding).mockReset()
    vi.mocked(getRoutableLinkBinding).mockImplementation(actual.getRoutableLinkBinding)
  })

  // An ENGAGED federated pact whose remote party is still OLD_SENDER_ID — the state a real
  // pact would be in before its counterpart renamed.
  function seedEngagedFederatedPact(peerThreadId: string, era = 0): string {
    const { thread } = createThread(raw(db) as unknown as Database.Database, {
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: agentB, agentId: agentB, role: 'member' }]
    })
    raw(db)
      .prepare(
        `UPDATE threads SET
           pact_state = 'engaged',
           pact_proposer_agent_id = ?,
           pact_with_agent_id = ?,
           pact_turn_agent_id = ?,
           pact_peer_agent_id = ?,
           pact_peer_link_device_id = ?,
           pact_peer_environment_id = ?,
           pact_peer_thread_id = ?,
           pact_era = ?,
           pact_peer_seq = 0
         WHERE id = ?`
      )
      .run(
        `remote:${LINK_DEVICE_ID}:${OLD_SENDER_ID}`,
        agentB,
        agentB,
        OLD_SENDER_ID,
        LINK_DEVICE_ID,
        LINK_DEVICE_ID,
        peerThreadId,
        era,
        thread.id
      )
    return thread.id
  }

  function rebindSend(overrides: Record<string, unknown> = {}) {
    const { pact: pactOverride, ...rest } = overrides
    return call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: NEW_SENDER_ID, displayName: SENDER_DISPLAY_NAME, role: null },
        toAgentId: agentB,
        messageId: 'msg_aaaaaaaaaaa1',
        threadId: 'thr_aaaaaaaaaaa1',
        subject: 'pact rebind_party',
        pact: {
          verb: 'rebind_party',
          seq: 1,
          era: 0,
          rebind: { oldAgentId: OLD_SENDER_ID },
          ...(pactOverride as Record<string, unknown> | undefined)
        },
        ...rest
      },
      linkCtx(runtime)
    )
  }

  it('T17: happy path — repoints the party, supersedes the old mirror row, applies once', async () => {
    const threadId = seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    await expect(rebindSend()).resolves.toMatchObject({ accepted: true })

    const threadRow = raw(db)
      .prepare(
        `SELECT pact_with_agent_id, pact_proposer_agent_id, pact_peer_agent_id, pact_state FROM threads WHERE id = ?`
      )
      .get(threadId) as {
      pact_with_agent_id: string
      pact_proposer_agent_id: string
      pact_peer_agent_id: string
      pact_state: string
    }
    expect(threadRow.pact_proposer_agent_id).toBe(`remote:${LINK_DEVICE_ID}:${NEW_SENDER_ID}`)
    expect(threadRow.pact_peer_agent_id).toBe(NEW_SENDER_ID)
    // Never touches pact_state (design's explicit "never touches" list).
    expect(threadRow.pact_state).toBe('engaged')

    const oldMirror = raw(db)
      .prepare(
        `SELECT superseded_at, succeeded_by_remote_agent_id FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(LINK_DEVICE_ID, OLD_SENDER_ID) as {
      superseded_at: string | null
      succeeded_by_remote_agent_id: string | null
    }
    expect(oldMirror.superseded_at).not.toBeNull()
    expect(oldMirror.succeeded_by_remote_agent_id).toBe(NEW_SENDER_ID)

    const appliedCount = raw(db)
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_applied_ids WHERE thread_id = ? AND verb = 'rebind_party'`
      )
      .get(threadId) as { n: number }
    expect(appliedCount.n).toBe(1)
  })

  it('retry-idempotency: re-applying the SAME wire message is a no-op (no second repoint audit, no second applied-id row)', async () => {
    const threadId = seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    await rebindSend()
    const repointCountAfterFirst = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'repointFederatedPactParty'`)
      .get() as { n: number }
    const appliedCountAfterFirst = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM pact_applied_ids WHERE thread_id = ?`)
      .get(threadId) as { n: number }

    // Same messageId, same everything — gate 8's dedupe returns the stored receipt.
    await expect(rebindSend()).resolves.toMatchObject({ accepted: true })

    const repointCountAfterRetry = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'repointFederatedPactParty'`)
      .get() as { n: number }
    const appliedCountAfterRetry = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM pact_applied_ids WHERE thread_id = ?`)
      .get(threadId) as { n: number }

    expect(repointCountAfterRetry.n).toBe(repointCountAfterFirst.n)
    expect(appliedCountAfterRetry.n).toBe(appliedCountAfterFirst.n)
  })

  // S10-21b B17 (D-R137 F3): a crash between step 1 (repoint) and step 2 (supersede-stamp +
  // applied-id write) leaves the thread's party already repointed to NEW_SENDER_ID while the
  // old mirror row is still NOT superseded and no applied-id row exists — gate 8's messageId
  // dedupe therefore does NOT short-circuit a retry (no stored receipt), so it reaches clause 5
  // for real. RED at base: clause 5 checked only the OLD party key and threw
  // `not_a_participant` on every such retry forever.
  it('T-F3: retry after a crash between repoint and the ledger write applies cleanly (RED at base: not_a_participant)', async () => {
    const threadId = seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    // Simulate the crash: call the repoint alone (step 1), never step 2.
    repointFederatedPactParty(raw(db) as unknown as Database.Database, threadId, {
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      remoteAgentId: NEW_SENDER_ID,
      reason: 'rebind_party'
    })
    const midCrash = raw(db)
      .prepare(`SELECT pact_proposer_agent_id FROM threads WHERE id = ?`)
      .get(threadId) as { pact_proposer_agent_id: string }
    expect(midCrash.pact_proposer_agent_id).toBe(`remote:${LINK_DEVICE_ID}:${NEW_SENDER_ID}`)
    const oldMirrorMidCrash = raw(db)
      .prepare(`SELECT superseded_at FROM remote_agents WHERE remote_agent_id = ?`)
      .get(OLD_SENDER_ID) as { superseded_at: string | null }
    expect(oldMirrorMidCrash.superseded_at).toBeNull()

    const auditCountBeforeRetry = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'repointFederatedPactParty'`)
      .get() as { n: number }

    // Retry: the identical wire message.
    await expect(rebindSend()).resolves.toMatchObject({ accepted: true })

    const oldMirror = raw(db)
      .prepare(
        `SELECT superseded_at, succeeded_by_remote_agent_id FROM remote_agents WHERE remote_agent_id = ?`
      )
      .get(OLD_SENDER_ID) as {
      superseded_at: string | null
      succeeded_by_remote_agent_id: string | null
    }
    expect(oldMirror.superseded_at).not.toBeNull()
    expect(oldMirror.succeeded_by_remote_agent_id).toBe(NEW_SENDER_ID)

    const appliedCount = raw(db)
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_applied_ids WHERE thread_id = ? AND verb = 'rebind_party'`
      )
      .get(threadId) as { n: number }
    expect(appliedCount.n).toBe(1)

    const repointAuditCountAfterRetry = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'repointFederatedPactParty'`)
      .get() as { n: number }
    // The retry's own repoint call is exactly one more audit row than before it ran — not a
    // double-repoint from clause 5 somehow being re-checked twice.
    expect(repointAuditCountAfterRetry.n).toBe(auditCountBeforeRetry.n + 1)
  })

  it('T18: a locally-quarantined row in the supersession chain refuses agent_quarantined, nothing written, pact auto-paused counterpart_quarantined', async () => {
    const threadId = seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    db.setLocalRemoteAgentQuarantine({
      environmentId: LINK_DEVICE_ID,
      remoteAgentId: OLD_SENDER_ID,
      quarantined: true
    })

    await expect(rebindSend()).rejects.toMatchObject({ code: 'agent_quarantined' })

    const threadRow = raw(db)
      .prepare(
        `SELECT pact_peer_agent_id, pact_paused_at, pact_pause_reason FROM threads WHERE id = ?`
      )
      .get(threadId) as {
      pact_peer_agent_id: string
      pact_paused_at: string | null
      pact_pause_reason: string | null
    }
    // Nothing written: the party is unchanged.
    expect(threadRow.pact_peer_agent_id).toBe(OLD_SENDER_ID)
    // Auto-paused counterpart_quarantined.
    expect(threadRow.pact_paused_at).not.toBeNull()
    expect(threadRow.pact_pause_reason).toBe('counterpart_quarantined')

    const oldMirror = raw(db)
      .prepare(
        `SELECT superseded_at FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(LINK_DEVICE_ID, OLD_SENDER_ID) as { superseded_at: string | null }
    expect(oldMirror.superseded_at).toBeNull()
  })

  it('T19: a different display name refuses, nothing written', async () => {
    seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    await expect(
      rebindSend({ fromAgent: { id: NEW_SENDER_ID, displayName: 'someone-else', role: null } })
    ).rejects.toThrow()
    const oldMirror = raw(db)
      .prepare(
        `SELECT superseded_at FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(LINK_DEVICE_ID, OLD_SENDER_ID) as { superseded_at: string | null }
    expect(oldMirror.superseded_at).toBeNull()
  })

  it('T19: a non-party oldAgentId refuses not_a_participant, nothing written', async () => {
    seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    db.upsertRemoteAgent({
      environmentId: LINK_DEVICE_ID,
      environmentName: LINK_DEVICE_ID,
      linkKind: 'paired_device',
      remoteAgentId: 'agt_deadbeef0001',
      displayName: SENDER_DISPLAY_NAME,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    await expect(
      rebindSend({ pact: { rebind: { oldAgentId: 'agt_deadbeef0001' } } })
    ).rejects.toMatchObject({ code: 'not_a_participant' })
  })

  it('T19: a foreign link (mirror row exists on a different link) refuses, nothing written', async () => {
    seedEngagedFederatedPact('thr_aaaaaaaaaaa1')
    db.upsertRemoteAgent({
      environmentId: 'dev_other_link',
      environmentName: 'dev_other_link',
      linkKind: 'paired_device',
      remoteAgentId: OLD_SENDER_ID,
      displayName: SENDER_DISPLAY_NAME,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    // Delete the (correct-link, OLD_SENDER_ID) row so only the foreign-link one exists.
    raw(db)
      .prepare(`DELETE FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`)
      .run(LINK_DEVICE_ID, OLD_SENDER_ID)
    await expect(rebindSend()).rejects.toMatchObject({ code: 'agent_unknown' })
  })

  it('T19: a mismatched era refuses pact_era_mismatch (equality, no adoption — unlike propose)', async () => {
    const threadId = seedEngagedFederatedPact('thr_aaaaaaaaaaa1', 3)
    await expect(rebindSend({ pact: { era: 0 } })).rejects.toMatchObject({
      code: 'pact_era_mismatch'
    })
    // Nothing written: era stays at 3, not silently re-anchored to the relayed 0.
    const afterRefusal = raw(db)
      .prepare('SELECT pact_era FROM threads WHERE id = ?')
      .get(threadId) as {
      pact_era: number
    }
    expect(afterRefusal.pact_era).toBe(3)

    // Prove this is genuinely different from propose's adoption rule (§2.12): on the exact same
    // mismatch shape (thread era 3, relayed era 0), propose's own era-adoption function
    // (adoptEraOnInboundPropose, imported by commit 8's dispatcher for propose specifically —
    // never called for rebind_party) ADOPTS the relayed era with no refusal at all.
    adoptEraOnInboundPropose(raw(db) as unknown as Database, { id: threadId }, { era: 0 })
    const afterAdoption = raw(db)
      .prepare('SELECT pact_era FROM threads WHERE id = ?')
      .get(threadId) as {
      pact_era: number
    }
    expect(afterAdoption.pact_era).toBe(0)
  })
})
