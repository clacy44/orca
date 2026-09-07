// S10-21b B21 (D-D3-A item 7 + SYNTHESIS S3, T6) — REPLACES the D-R140 end-to-end test that
// used to live in reply-outbox-round-trip-b17.test.ts (21b-E8 REVOKED: the relay-owed drain
// this D-R140 test exercised is deleted). Same two-store (SENDER/RECEIVER) pump round-trip
// harness as that file, duplicated here (not imported) — forced deviation, declared: adding T6
// in place would have pushed reply-outbox-round-trip-b17.test.ts past the 800-line test budget
// (_common-rules.md); this file is that file's own precedent (split out of
// reply-outbox-round-trip.test.ts for the identical reason) applied one level further.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService, type OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { getRoutableLinkBinding } from './link-binding-routable'
import type * as LinkBindingRoutable from './link-binding-routable'
import type Database from '../../sqlite/sync-database'
import type { RpcContext } from '../rpc/core'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { REPLY_OUTBOX_PER_LINK_CAP, PACT_RESERVED_HEADROOM } from './link-binding-constants'

vi.mock('./link-binding-routable', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkBindingRoutable>()
  return { ...actual, getRoutableLinkBinding: vi.fn(actual.getRoutableLinkBinding) }
})

const LINK_DEVICE_ID = 'dev_rt_link_1'
const LINK_FINGERPRINT = 'fp_rt_link_1'
const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

function raw(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function makeAuthority(
  terminalHandle: string,
  paneKey: string
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

function receiverCtx(runtime: OrcaRuntimeService): RpcContext {
  return {
    runtime,
    pairedDeviceId: LINK_DEVICE_ID,
    clientKind: 'runtime',
    authenticatedCallerFingerprint: LINK_FINGERPRINT
  }
}

const FIXED_BINDING = {
  linkDeviceId: LINK_DEVICE_ID,
  environmentId: LINK_DEVICE_ID,
  boundEndpointId: 'endpoint1',
  boundPairingRevision: 1,
  linkCredentialFp: 'lcfp',
  peerCredentialFp: 'pcfp',
  peerKeyFingerprint: 'pkfp',
  grantClass: 'minted',
  scanCompleteness: 'complete',
  proofProtocol: 'v1',
  state: 'proved',
  detail: null,
  contestIncidentId: null,
  provedAt: Date.now(),
  lastVerifiedAt: Date.now(),
  contestedAt: null,
  revokedAt: null
}

describe('S10-21b B21 (D-D3-A T6): reply-outbox-pump round trip — pause/resume redesign e2e', () => {
  let senderDb: OrchestrationDb
  let senderRuntime: OrcaRuntimeService
  let receiverDb: OrchestrationDb
  let receiverRuntime: OrcaRuntimeService

  beforeEach(() => {
    senderDb = new OrchestrationDb(':memory:')
    senderRuntime = new OrcaRuntimeService()
    senderRuntime.setOrchestrationDb(senderDb)
    senderRuntime.getLinkBindingProver().disarm()
    receiverDb = new OrchestrationDb(':memory:')
    receiverRuntime = new OrcaRuntimeService()
    receiverRuntime.setOrchestrationDb(receiverDb)
    receiverRuntime.getLinkBindingProver().disarm()

    vi.mocked(getRoutableLinkBinding).mockReturnValue(
      FIXED_BINDING as unknown as ReturnType<typeof getRoutableLinkBinding>
    )

    // Item 2's own constraint: no canned result — the SENDER's dial calls the REAL inbound
    // handler against the RECEIVER, and returns exactly what that handler returns (or throws
    // exactly what it throws, letting the pump's own classifyReplyRelayError run unmodified).
    vi.spyOn(senderRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const fedMethod = method('orchestration.federatedSend')
      const parsed = fedMethod.params!.parse(args.params)
      return fedMethod.handler(parsed, receiverCtx(receiverRuntime))
    })
  })

  afterEach(async () => {
    senderRuntime.replyOutbox?.stop()
    receiverRuntime.replyOutbox?.stop()
    senderDb.close()
    receiverDb.close()
    const actual = await vi.importActual<typeof LinkBindingRoutable>('./link-binding-routable')
    vi.mocked(getRoutableLinkBinding).mockReset()
    vi.mocked(getRoutableLinkBinding).mockImplementation(actual.getRoutableLinkBinding)
  })

  async function pumpSettles(
    db: OrchestrationDb,
    outboxId: string,
    wantStates: readonly string[]
  ): Promise<ReturnType<OrchestrationDb['getReplyOutboxItem']>> {
    let item = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 60 && !(item && wantStates.includes(item.state)); i++) {
      await new Promise((r) => setTimeout(r, 50))
      item = db.getReplyOutboxItem(outboxId)
    }
    return item
  }

  // -----------------------------------------------------------------------------------------
  // T6 (S10-21b B21, D-D3-A item 7 + SYNTHESIS S3) — REPLACES the D-R140 e2e. The relay-owed
  // drain is deleted (21b-E8 REVOKED): pause/resume now relay in the SAME transaction that
  // applies them, exempt from the outbox cap (reply-outbox-store.ts's `capExempt`, bounded by
  // the coalescer). A-path: saturate the link, pause DELIVERS immediately (no token, no drain
  // tick needed); a second pause (first row already settled, so no coalesce) is a `pause_noop`
  // at the receiver — fence still advances, no second ledger row; resume then a step, both in
  // lockstep. RED at base on two fronts: the first pause never relays (cap refuses it) and,
  // headroom freed, the second pause is refused `pact_paused` so `pumpSettles` never returns
  // `delivered`.
  // -----------------------------------------------------------------------------------------
  it('T6 (A-path): a saturated link still relays pause immediately; a redundant pause is pause_noop; resume/step stay in lockstep (RED at base: cap refuses pause)', async () => {
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
    const senderAgentId = seedAgent(senderDb, 'sendert6a')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_b_t6a' && evidence.paneKey === PANE_A
          ? makeAuthority('term_b_t6a', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receivert6a', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b_t6a', paneKey: PANE_A }
      }
    )) as { agent: { id: string } }
    const receiverAgentId = registeredReceiver.agent.id

    senderDb.upsertRemoteAgent({
      environmentId: LINK_DEVICE_ID,
      environmentName: LINK_DEVICE_ID,
      linkKind: 'environment',
      remoteAgentId: receiverAgentId,
      displayName: 'receiver (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(raw(senderDb), {
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      boundEndpointId: 'endpoint_t6a',
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
    const peerKey = renderFederatedPartyKey({
      linkDeviceId: LINK_DEVICE_ID,
      remoteAgentId: receiverAgentId
    })
    const { thread: senderThread } = senderDb.createThread({
      subject: 's',
      createdByAgentId: senderAgentId,
      participants: [
        { participantKey: senderAgentId, agentId: senderAgentId },
        { participantKey: peerKey, agentId: null }
      ]
    })
    senderDb.proposePact({
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6a`,
      callerHostId: 'local',
      threadId: senderThread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    raw(senderDb)
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'delivered', settled_at = ? WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(Date.now(), senderThread.id)
    raw(senderDb)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(senderAgentId, senderThread.id)

    const { thread: receiverThread } = receiverDb.createThread({
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: receiverAgentId, agentId: receiverAgentId, role: 'member' }]
    })
    const senderEraT6a = (
      raw(senderDb).prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(senderThread.id) as {
        pact_era: number
      }
    ).pact_era
    raw(receiverDb)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ?,
           pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_peer_agent_id = ?, pact_peer_environment_id = ?, pact_turn_agent_id = ?,
           pact_peer_seq = 1, pact_era = ?
         WHERE id = ?`
      )
      .run(
        LINK_DEVICE_ID,
        senderThread.id,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        receiverAgentId,
        senderAgentId,
        LINK_DEVICE_ID,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        senderEraT6a,
        receiverThread.id
      )

    function fence(): { peerSeq: number; localSeq: number } {
      const peerSeq = (
        raw(receiverDb)
          .prepare(`SELECT pact_peer_seq FROM threads WHERE id = ?`)
          .get(receiverThread.id) as { pact_peer_seq: number }
      ).pact_peer_seq
      const localSeq = (
        raw(senderDb)
          .prepare(`SELECT pact_local_seq FROM threads WHERE id = ?`)
          .get(senderThread.id) as { pact_local_seq: number }
      ).pact_local_seq
      return { peerSeq, localSeq }
    }
    function receiverRepairRows(): unknown[] {
      return raw(receiverDb)
        .prepare(
          `SELECT kind FROM pact_steps WHERE thread_id = ? AND kind IN ('resync', 'resync_request', 'gap_notice')`
        )
        .all(receiverThread.id)
    }
    async function deliver(outboxId: string): Promise<void> {
      senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
      const settled = await pumpSettles(senderDb, outboxId, ['delivered', 'refused', 'abandoned'])
      if (settled?.state !== 'delivered') {
        throw new Error(
          `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
        )
      }
    }

    // --- Saturate the link's ordinary headroom — the cap can no longer refuse pause/resume.
    const senderRaw = raw(senderDb)
    const capTotal = REPLY_OUTBOX_PER_LINK_CAP + PACT_RESERVED_HEADROOM
    const insertFiller = senderRaw.prepare(
      `INSERT INTO peer_reply_outbox (
         id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
         peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
         peer_thread_id, local_thread_id, notice_run_id, notice_pane_key, payload, byte_count,
         state, attempts, consecutive_failures, hold_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '{}', 2, 'queued', 0, 0, 0, ?)`
    )
    for (let i = 0; i < capTotal; i++) {
      insertFiller.run(
        `filler_t6a_${i}`,
        i + 1,
        `msg_filler_t6a_${i}`,
        LINK_DEVICE_ID,
        LINK_DEVICE_ID,
        1,
        'pcfp',
        'pkfp',
        `msg_filler_t6a_${i}`,
        receiverAgentId,
        Date.now()
      )
    }

    const { pausePact, resumePact } = await import('./pact-lifecycle')
    pausePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6a`,
      callerHostId: 'local',
      threadId: senderThread.id,
      reasonCode: 'counterpart_gone'
    })
    const afterPause = senderDb.getThread(senderThread.id)
    // No token — nothing owed to a drain; the pause relayed in its own transaction.
    expect(afterPause?.pact_relay_pending).toBeNull()
    const pauseOutboxRows = senderRaw
      .prepare(
        `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_pause'`
      )
      .all(senderThread.id) as { id: string }[]
    expect(pauseOutboxRows).toHaveLength(1)

    await deliver(pauseOutboxRows[0].id)
    let f = fence()
    expect(f.peerSeq).toBe(f.localSeq)
    expect(receiverDb.getThread(receiverThread.id)?.pact_peer_paused_at).not.toBeNull()
    expect(receiverRepairRows()).toEqual([])

    // --- A SECOND pause: the first row already settled, so no coalesce — a fresh row mints.
    // The receiver already recorded the peer's pause: this must be a `pause_noop`, not a
    // refusal, and must not write a second remote pause ledger row.
    pausePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6a`,
      callerHostId: 'local',
      threadId: senderThread.id,
      reasonCode: 'counterpart_gone'
    })
    const secondPauseOutboxRow = senderRaw
      .prepare(
        `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_pause' AND state = 'queued'`
      )
      .get(senderThread.id) as { id: string }
    await deliver(secondPauseOutboxRow.id)
    f = fence()
    expect(f.peerSeq).toBe(f.localSeq)
    const remotePauseSteps = raw(receiverDb)
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'pause' AND actor_is_remote = 1`
      )
      .get(receiverThread.id) as { n: number }
    expect(remotePauseSteps.n).toBe(1)
    expect(receiverRepairRows()).toEqual([])

    // Headroom frees — both pauses above proved the cap cannot refuse pause/resume even while
    // saturated (D-D3-A item 1); the ordinary `step` verb below is NOT cap-exempt (item 1
    // deliberately covers only pause/resume) and would otherwise be refused by these same
    // filler rows, which is not what this scenario is testing.
    senderRaw.prepare(`DELETE FROM peer_reply_outbox WHERE id LIKE 'filler_t6a_%'`).run()

    // --- Resume: delivers, the receiver's peer-pause record clears.
    resumePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6a`,
      callerHostId: 'local',
      threadId: senderThread.id
    })
    const resumeOutboxRow = senderRaw
      .prepare(
        `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_resume' AND state = 'queued'`
      )
      .get(senderThread.id) as { id: string }
    await deliver(resumeOutboxRow.id)
    f = fence()
    expect(f.peerSeq).toBe(f.localSeq)
    expect(receiverDb.getThread(receiverThread.id)?.pact_peer_paused_at).toBeNull()
    expect(receiverRepairRows()).toEqual([])

    // --- One further step, in lockstep.
    const stepResult = senderDb.appendPactStep({
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6a`,
      callerHostId: 'local',
      threadId: senderThread.id,
      done: 'did the thing (T6a)',
      runId: 'run_t6a'
    })
    if (stepResult.outcome === 'refused') {
      throw new Error('unexpected refusal on the sender step')
    }
    const stepOutboxId = (
      senderRaw
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? ORDER BY seq DESC LIMIT 1`
        )
        .get(senderThread.id) as { id: string }
    ).id
    await deliver(stepOutboxId)
    f = fence()
    expect(f.peerSeq).toBe(f.localSeq)
    const appliedStep = raw(receiverDb)
      .prepare(`SELECT relay_seq FROM pact_steps WHERE thread_id = ? AND kind = 'step'`)
      .get(receiverThread.id) as { relay_seq: number } | undefined
    expect(appliedStep?.relay_seq).toBe(f.peerSeq)
    expect(receiverRepairRows()).toEqual([])
  })

  // -----------------------------------------------------------------------------------------
  // T6 (S10-21b B21, SYNTHESIS S3) — B-path: a sender resume that hits the FALLBACK's
  // missing-anchor/no-binding arm (not the cap, which can no longer refuse) is applied LOCALLY
  // with nothing relayed — the receiver never learns the sender resumed, so its
  // `pact_peer_paused_at` stays stale. The sender's next `step` must still APPLY on the
  // receiver (21b-E13/H1: `step` refuses only on the receiver's OWN pause, never the peer's
  // stale record) and H3 clears the stale flag as a side effect. One further step, driven by
  // the RECEIVER (whose local party now holds the turn), delivers back to the sender in
  // lockstep. RED at base: the sender's post-resume step is refused `pact_paused` on the
  // receiver (base's shared step|pause conjunct consults `pact_peer_paused_at`).
  // -----------------------------------------------------------------------------------------
  it('T6 (B-path): resume applied locally via the fallback; the receiver still ACCEPTS the next step and clears its stale peer-pause record (RED at base: pact_paused)', async () => {
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
    const senderAgentId = seedAgent(senderDb, 'sendert6b')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_b_t6b' && evidence.paneKey === PANE_A
          ? makeAuthority('term_b_t6b', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receivert6b', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b_t6b', paneKey: PANE_A }
      }
    )) as { agent: { id: string } }
    const receiverAgentId = registeredReceiver.agent.id

    senderDb.upsertRemoteAgent({
      environmentId: LINK_DEVICE_ID,
      environmentName: LINK_DEVICE_ID,
      linkKind: 'environment',
      remoteAgentId: receiverAgentId,
      displayName: 'receiver (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(raw(senderDb), {
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      boundEndpointId: 'endpoint_t6b',
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
    // The RECEIVER needs its own live binding for this link too — its own later `step` relay
    // (the receiver -> sender leg below) reads the raw table directly, same as Case C
    // (reply-outbox-round-trip.test.ts) does for its reverse-direction accept/release.
    receiverDb.upsertRemoteAgent({
      environmentId: LINK_DEVICE_ID,
      environmentName: LINK_DEVICE_ID,
      linkKind: 'environment',
      remoteAgentId: senderAgentId,
      displayName: 'sender (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(raw(receiverDb), {
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      boundEndpointId: 'endpoint_t6b',
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
    const peerKey = renderFederatedPartyKey({
      linkDeviceId: LINK_DEVICE_ID,
      remoteAgentId: receiverAgentId
    })
    const { thread: senderThread } = senderDb.createThread({
      subject: 's',
      createdByAgentId: senderAgentId,
      participants: [
        { participantKey: senderAgentId, agentId: senderAgentId },
        { participantKey: peerKey, agentId: null }
      ]
    })
    senderDb.proposePact({
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6b`,
      callerHostId: 'local',
      threadId: senderThread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    raw(senderDb)
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'delivered', settled_at = ? WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(Date.now(), senderThread.id)
    raw(senderDb)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(senderAgentId, senderThread.id)

    const { thread: receiverThread } = receiverDb.createThread({
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: receiverAgentId, agentId: receiverAgentId, role: 'member' }]
    })
    const senderEraT6b = (
      raw(senderDb).prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(senderThread.id) as {
        pact_era: number
      }
    ).pact_era
    raw(receiverDb)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ?,
           pact_state = 'engaged', pact_proposer_agent_id = ?, pact_with_agent_id = ?,
           pact_peer_agent_id = ?, pact_peer_environment_id = ?, pact_turn_agent_id = ?,
           pact_peer_seq = 1, pact_era = ?
         WHERE id = ?`
      )
      .run(
        LINK_DEVICE_ID,
        senderThread.id,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        receiverAgentId,
        senderAgentId,
        LINK_DEVICE_ID,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        senderEraT6b,
        receiverThread.id
      )
    // The SENDER's own `pact_peer_thread_id` — needed so the receiver -> sender leg below
    // resolves via `resolvePactThread`'s ordinary (non-propose) lookup.
    raw(senderDb)
      .prepare(`UPDATE threads SET pact_peer_thread_id = ? WHERE id = ?`)
      .run(receiverThread.id, senderThread.id)

    const senderRaw = raw(senderDb)
    async function deliverFromSender(outboxId: string): Promise<void> {
      senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
      const settled = await pumpSettles(senderDb, outboxId, ['delivered', 'refused', 'abandoned'])
      if (settled?.state !== 'delivered') {
        throw new Error(
          `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
        )
      }
    }
    async function deliverFromReceiver(outboxId: string): Promise<void> {
      receiverRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
      const settled = await pumpSettles(receiverDb, outboxId, ['delivered', 'refused', 'abandoned'])
      if (settled?.state !== 'delivered') {
        throw new Error(
          `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
        )
      }
    }

    // --- Pause: delivers normally, the receiver records the peer's pause.
    const { pausePact, resumePact } = await import('./pact-lifecycle')
    pausePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6b`,
      callerHostId: 'local',
      threadId: senderThread.id,
      reasonCode: 'counterpart_gone'
    })
    const pauseOutboxRow = senderRaw
      .prepare(
        `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_pause'`
      )
      .get(senderThread.id) as { id: string }
    await deliverFromSender(pauseOutboxRow.id)
    expect(receiverDb.getThread(receiverThread.id)?.pact_peer_paused_at).not.toBeNull()
    expect(
      raw(receiverDb)
        .prepare(`SELECT pact_peer_seq FROM threads WHERE id = ?`)
        .get(receiverThread.id)
    ).toEqual(
      raw(senderDb)
        .prepare(`SELECT pact_local_seq AS pact_peer_seq FROM threads WHERE id = ?`)
        .get(senderThread.id)
    )

    // --- Force the fallback's missing-anchor/no-binding arm for the resume — NOT the cap,
    // which is now structurally unable to refuse (D-D3-A item 1). Removing the sender's own
    // live binding row makes `getPeerLinkBinding` return null, so
    // `emitFederatedPactSideEffect`'s `preconditionsOk` check is false and it takes
    // `localFallback('no_live_binding')` directly — never touching `enqueueFederatedPactVerb`.
    senderRaw.prepare(`DELETE FROM peer_link_bindings WHERE link_device_id = ?`).run(LINK_DEVICE_ID)
    resumePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6b`,
      callerHostId: 'local',
      threadId: senderThread.id
    })
    const afterResume = senderDb.getThread(senderThread.id)
    expect(afterResume?.pact_paused_at).toBeNull()
    expect(afterResume?.pact_relay_pending).toBeNull()
    const resumeOutboxRows = senderRaw
      .prepare(
        `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_resume'`
      )
      .all(senderThread.id) as { id: string }[]
    expect(resumeOutboxRows).toEqual([])
    // The receiver never learned of the resume — its peer-pause record is stale.
    expect(receiverDb.getThread(receiverThread.id)?.pact_peer_paused_at).not.toBeNull()

    // Restore the binding so the next verb (a real step) can relay again.
    putPeerLinkBinding(senderRaw, {
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: LINK_DEVICE_ID,
      boundEndpointId: 'endpoint_t6b_2',
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

    // --- The sender's next step: the receiver must ACCEPT it (not `pact_paused`) despite its
    // stale `pact_peer_paused_at` — H1 (step never consults the peer's pause) + H3 (an applied
    // step clears the stale flag as a side effect).
    const stepResult = senderDb.appendPactStep({
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert6b`,
      callerHostId: 'local',
      threadId: senderThread.id,
      done: 'did the thing (T6b)',
      runId: 'run_t6b'
    })
    if (stepResult.outcome === 'refused') {
      throw new Error('unexpected refusal on the sender step')
    }
    const stepOutboxId = (
      senderRaw
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? ORDER BY seq DESC LIMIT 1`
        )
        .get(senderThread.id) as { id: string }
    ).id
    await deliverFromSender(stepOutboxId)

    const receiverAfterStep = receiverDb.getThread(receiverThread.id)
    expect(receiverAfterStep?.pact_peer_paused_at).toBeNull()
    expect(receiverAfterStep?.pact_peer_seq).toBe(
      senderDb.getThread(senderThread.id)?.pact_local_seq
    )
    // Turn moved to the receiver's OWN local party.
    expect(receiverAfterStep?.pact_turn_agent_id).toBe(receiverAgentId)

    // --- One further step, driven BY THE RECEIVER (who now holds the turn), delivering back
    // to the sender in lockstep — the reverse-direction dial, same pattern Case C
    // (reply-outbox-round-trip.test.ts) uses for its accept/release relays.
    vi.spyOn(receiverRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const fedMethod = method('orchestration.federatedSend')
      const parsed = fedMethod.params!.parse(args.params)
      return fedMethod.handler(parsed, receiverCtx(senderRuntime))
    })
    const receiverStepResult = receiverDb.appendPactStep({
      callerAgentId: receiverAgentId,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId: receiverThread.id,
      done: 'did the thing back (T6b)',
      runId: 'run_t6b_2'
    })
    if (receiverStepResult.outcome === 'refused') {
      throw new Error('unexpected refusal on the receiver step')
    }
    const receiverStepOutboxId = (
      raw(receiverDb)
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? ORDER BY seq DESC LIMIT 1`
        )
        .get(receiverThread.id) as { id: string }
    ).id
    await deliverFromReceiver(receiverStepOutboxId)

    const senderAfterSecondStep = senderDb.getThread(senderThread.id)
    const receiverFinal = receiverDb.getThread(receiverThread.id)
    expect(senderAfterSecondStep?.pact_peer_seq).toBe(receiverFinal?.pact_local_seq)
    expect(
      raw(receiverDb)
        .prepare(
          `SELECT kind FROM pact_steps WHERE thread_id = ? AND kind IN ('resync', 'resync_request', 'gap_notice')`
        )
        .all(receiverThread.id)
    ).toEqual([])
    expect(
      raw(senderDb)
        .prepare(
          `SELECT kind FROM pact_steps WHERE thread_id = ? AND kind IN ('resync', 'resync_request', 'gap_notice')`
        )
        .all(senderThread.id)
    ).toEqual([])
  })
})
