// S10-21b B17 (D-R138 B-F1) — split out of reply-outbox-round-trip.test.ts (max-lines ratchet)
// once T32 pushed that file over the 800-line test budget. Same two-store (SENDER/RECEIVER)
// pump round-trip harness, duplicated rather than shared via import so each file stays
// independently readable — see that file's own header for the harness's general rationale.
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
import { drainPendingRebindParty } from './pact-federated-rebind'
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

describe('S10-21b B17 (D-R138 B-F1): reply-outbox-pump round trip — pause/resume coalescing', () => {
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
  // T32 (S10-21b B17, D-R138 B-F1, errata 21b-E7a, LR-018) — RED AT BASE: cross-kind pause/
  // resume coalescing burned a wire seq (the coalesced REPLACEMENT reused the bump from the
  // resume call, which the pause's own row had already consumed a DIFFERENT seq for and never
  // sent) — the peer's fence then desyncs on the very next legitimate item. Missing at base:
  // no test of `coalesceAcrossRelayKinds` drove this through a real round trip at all.
  // -----------------------------------------------------------------------------------------
  it('T32: pause then resume before a pump tick — exactly one outbox row, its pact_seq == threads.pact_local_seq, no gap/desync on delivery (RED at base)', async () => {
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
    const senderAgentId = seedAgent(senderDb, 'sendert32')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_b_t32' && evidence.paneKey === PANE_A
          ? makeAuthority('term_b_t32', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receivert32', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b_t32', paneKey: PANE_A }
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
      boundEndpointId: 'endpoint_t32',
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
      callerPaneKey: `tab:sendert32`,
      callerHostId: 'local',
      threadId: senderThread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    // The propose's own relay (seq 1) is out of this test's scope — mark it already delivered,
    // exactly as Case B does, so only the pause/resume coalescing under test produces new rows.
    raw(senderDb)
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'delivered', settled_at = ? WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(Date.now(), senderThread.id)
    raw(senderDb)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(senderAgentId, senderThread.id)

    // --- RECEIVER: pre-anchored to the sender's own thread id, fabricated already-at-seq-1
    // (the propose), engaged — same construction as Case B.
    const { thread: receiverThread } = receiverDb.createThread({
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: receiverAgentId, agentId: receiverAgentId, role: 'member' }]
    })
    const senderEraT32 = (
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
        senderEraT32,
        receiverThread.id
      )

    // --- Pause then resume on the SENDER, BEFORE any pump tick — cross-kind coalescing must
    // collapse these into ONE outbox row, and the seq that row's payload carries must be the
    // SAME seq `threads.pact_local_seq` already holds (no bump consumed by the discarded pause).
    const { pausePact, resumePact } = await import('./pact-lifecycle')
    pausePact(raw(senderDb), {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert32`,
      callerHostId: 'local',
      threadId: senderThread.id,
      reasonCode: 'operator'
    })
    resumePact(raw(senderDb), {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendert32`,
      callerHostId: 'local',
      threadId: senderThread.id
    })

    // Core claim (D-R138 B-F1): the coalesced REPLACEMENT reuses the pause row's own seq —
    // no new wire seq is consumed for the discarded pause.
    const outboxRows = raw(senderDb)
      .prepare(
        `SELECT id, pact_seq, relay_kind, payload FROM peer_reply_outbox
          WHERE pact_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
      )
      .all(senderThread.id) as {
      id: string
      pact_seq: number
      relay_kind: string
      payload: string
    }[]
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0].relay_kind).toBe('pact_resume')
    const senderThreadNow = senderDb.getThread(senderThread.id)
    expect(outboxRows[0].pact_seq).toBe(senderThreadNow?.pact_local_seq)
    const payload = JSON.parse(outboxRows[0].payload) as { pact: { seq: number } }
    expect(payload.pact.seq).toBe(senderThreadNow?.pact_local_seq)

    // Round-trip delivery: the pump claims and dials the coalesced row without error.
    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const settled = await pumpSettles(senderDb, outboxRows[0].id, [
      'delivered',
      'refused',
      'abandoned'
    ])
    if (settled?.state !== 'delivered') {
      throw new Error(
        `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
      )
    }
    expect(settled?.state).toBe('delivered')
  })

  // -----------------------------------------------------------------------------------------
  // D-R140 B20 — the END-TO-END regression: a cap-saturated pause (NF-1) that never even
  // attempts a relay, a local resume that supersedes it (NF-2), delivered through the REAL
  // `orchestration.federatedSend` handler on the RECEIVER, whose `resume_noop` must still
  // advance its fence (NF-3) so the sender's very next `step` applies cleanly — no gap, no
  // resync, no desync. RED at base on all three fronts: base burns a wire seq every drain tick
  // while the cap is saturated, can relay a stale pause after a resume, and drops the resume's
  // seq at the receiver, desyncing the step.
  // -----------------------------------------------------------------------------------------
  it('D-R140: cap-saturated pause -> resume -> step round-trips through the real handler with the receiver fence in lockstep after each delivery (RED at base: desync)', async () => {
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
    const senderAgentId = seedAgent(senderDb, 'senderdr140')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_b_dr140' && evidence.paneKey === PANE_A
          ? makeAuthority('term_b_dr140', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receiverdr140', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b_dr140', paneKey: PANE_A }
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
      boundEndpointId: 'endpoint_dr140',
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
      callerPaneKey: `tab:senderdr140`,
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
    const senderEraDr140 = (
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
        senderEraDr140,
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

    // --- NF-1: saturate the sender's link so the pause's own enqueue hits LinkBindingCapError
    // — same filler-row technique as F10 (pact-federated-containment-b14.test.ts).
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
        `filler_dr140_${i}`,
        i + 1,
        `msg_filler_dr140_${i}`,
        LINK_DEVICE_ID,
        LINK_DEVICE_ID,
        1,
        'pcfp',
        'pkfp',
        `msg_filler_dr140_${i}`,
        receiverAgentId,
        Date.now()
      )
    }

    const { pausePact, resumePact } = await import('./pact-lifecycle')
    pausePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:senderdr140`,
      callerHostId: 'local',
      threadId: senderThread.id,
      reasonCode: 'counterpart_gone'
    })
    const afterPause = senderDb.getThread(senderThread.id)
    expect(afterPause?.pact_relay_pending).toBe('pause')
    expect(afterPause?.pact_paused_at).not.toBeNull()
    const localSeqBeforeDrain = afterPause!.pact_local_seq

    // Three drain ticks while STILL saturated: mint nothing, bump nothing (NF-1).
    for (let i = 0; i < 3; i++) {
      expect(drainPendingRebindParty(senderRaw, null)).toBe(0)
    }
    const afterDrainStillCapped = senderDb.getThread(senderThread.id)
    expect(afterDrainStillCapped?.pact_local_seq).toBe(localSeqBeforeDrain)
    expect(afterDrainStillCapped?.pact_relay_pending).toBe('pause')
    expect(
      senderRaw
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
        )
        .all(senderThread.id)
    ).toEqual([])

    // --- NF-2: free headroom, resume LOCALLY (not via the drain) — the resume's own successful
    // enqueue must clear the stale 'pause' token and be the ONLY thing ever relayed.
    senderRaw.prepare(`DELETE FROM peer_reply_outbox WHERE id LIKE 'filler_dr140_%'`).run()
    resumePact(senderRaw, {
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:senderdr140`,
      callerHostId: 'local',
      threadId: senderThread.id
    })
    const afterResume = senderDb.getThread(senderThread.id)
    expect(afterResume?.pact_relay_pending).toBeNull()
    expect(afterResume?.pact_paused_at).toBeNull()
    const resumeOutboxRows = senderRaw
      .prepare(
        `SELECT id, relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind IN ('pact_pause', 'pact_resume')`
      )
      .all(senderThread.id) as { id: string; relay_kind: string }[]
    expect(resumeOutboxRows).toHaveLength(1)
    expect(resumeOutboxRows[0].relay_kind).toBe('pact_resume')

    // --- Deliver the resume through the REAL receiver handler. The receiver never recorded a
    // peer pause (the pause never even attempted a relay) — this is a `resume_noop` at the
    // matrix gate that D-R140 NF-3 requires still advance the fence.
    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const resumeSettled = await pumpSettles(senderDb, resumeOutboxRows[0].id, [
      'delivered',
      'refused',
      'abandoned'
    ])
    if (resumeSettled?.state !== 'delivered') {
      throw new Error(
        `resume: state=${resumeSettled?.state} code=${resumeSettled?.lastErrorCode} err=${resumeSettled?.lastError}`
      )
    }
    const fenceAfterResume = fence()
    expect(fenceAfterResume.peerSeq).toBe(fenceAfterResume.localSeq)
    expect(receiverDb.getThread(receiverThread.id)?.pact_paused_at).toBeNull()
    // No repair traffic — a desync/gap would have paused and minted a resync_request.
    expect(
      raw(receiverDb)
        .prepare(
          `SELECT kind FROM pact_steps WHERE thread_id = ? AND kind IN ('resync', 'resync_request', 'gap_notice')`
        )
        .all(receiverThread.id)
    ).toEqual([])

    // --- The sender's very next verb: a real `step`, driven through the emit primitive exactly
    // as reply-outbox-round-trip.test.ts's own step case does. If NF-3 were still open, the
    // resume_noop's dropped seq would desync this delivery.
    const stepResult = senderDb.appendPactStep({
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:senderdr140`,
      callerHostId: 'local',
      threadId: senderThread.id,
      done: 'did the thing (D-R140)',
      runId: 'run_dr140'
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
    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const stepSettled = await pumpSettles(senderDb, stepOutboxId, [
      'delivered',
      'refused',
      'abandoned'
    ])
    if (stepSettled?.state !== 'delivered') {
      throw new Error(
        `step: state=${stepSettled?.state} code=${stepSettled?.lastErrorCode} err=${stepSettled?.lastError}`
      )
    }
    const fenceAfterStep = fence()
    expect(fenceAfterStep.peerSeq).toBe(fenceAfterStep.localSeq)
    expect(receiverDb.getThread(receiverThread.id)?.pact_paused_at).toBeNull()
    const appliedStep = raw(receiverDb)
      .prepare(`SELECT relay_seq FROM pact_steps WHERE thread_id = ? AND kind = 'step'`)
      .get(receiverThread.id) as { relay_seq: number } | undefined
    expect(appliedStep?.relay_seq).toBe(fenceAfterStep.peerSeq)
    expect(
      raw(receiverDb)
        .prepare(
          `SELECT kind FROM pact_steps WHERE thread_id = ? AND kind IN ('resync', 'resync_request', 'gap_notice')`
        )
        .all(receiverThread.id)
    ).toEqual([])
  })
})
