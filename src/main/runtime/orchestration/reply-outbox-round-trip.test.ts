// S10-21b B8b (21b-D1, README "after the 21b-D1 fact sweep") — the pump-level round trip no
// prior B6/B8/B9 test ever drove (every one of them bypassed the pump: a directly-constructed
// `federatedSend` params object, never a real enqueue -> claim -> dial). Two in-memory stores
// (SENDER, RECEIVER); the SENDER's `runtime.callPinnedEnvironment` is stubbed to invoke the REAL
// `orchestration.federatedSend` handler (from ORCHESTRATION_METHODS) against the RECEIVER
// store/runtime with the params the pump itself parsed off the outbox row — never a canned
// result. Case A (mail) is the harness control — green before this commit's envelope fix, since
// the mail path was never broken. Case B (pact step) is red at base (73984e659d..1f2d041ab8):
// pact-federated-emit.ts's `{ pact: wirePact }`-only payload fails FederatedSendParams.parse on
// the REAL dial (F3/F4) — this test is the first to exercise that failure through the pump
// itself rather than by inspecting the payload directly (pact-federated-emit.test.ts's own
// 21b-D1 tests do that half).
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

describe('S10-21b B8b (21b-D1): reply-outbox-pump round trip through the REAL orchestration.federatedSend handler', () => {
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
  // Case A (mail) — the harness control. GREEN AT BASE (1f2d041ab8): the mail envelope
  // (orchestration-reply-foreign.ts:126-137) was never broken by 21b-D1; this proves the
  // two-store/stubbed-dial harness itself works, not a fix.
  // -----------------------------------------------------------------------------------------
  it('Case A (mail): a foreign-reply row relays through the pump and the receiver holds the message', async () => {
    vi.spyOn(senderRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        (evidence?.terminalHandle === 'term_a' || evidence?.terminalHandle?.startsWith('agent:')) &&
        evidence.paneKey === PANE_A
          ? makeAuthority(evidence.terminalHandle, PANE_A)
          : null
    )
    const registeredAsker = (await call(
      'orchestration.agents.register',
      { name: 'asker', role: 'test agent' },
      {
        runtime: senderRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
      }
    )) as { agent: { id: string } }
    const askerId = registeredAsker.agent.id

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_b' && evidence.paneKey === PANE_A
          ? makeAuthority('term_b', PANE_A)
          : null
    )
    const registeredAnswerer = (await call(
      'orchestration.agents.register',
      { name: 'answerer', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_A }
      }
    )) as { agent: { id: string } }
    const answererId = registeredAnswerer.agent.id

    const outboundId = 'msg_bbbbbbbbbbb1'
    senderDb.insertGatedMessage({
      id: outboundId,
      from: `remote:${LINK_DEVICE_ID}:${answererId}`,
      to: `agent:${askerId}`,
      subject: 'hello',
      body: 'hello from receiver',
      runId: 'run_peer_local',
      verb: 'federation_import',
      peerLinkDeviceId: LINK_DEVICE_ID,
      peerAgentId: answererId,
      threadId: null
    })

    const reply = (await call(
      'orchestration.reply',
      { id: outboundId, body: 'reply body' },
      {
        runtime: senderRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: `agent:${askerId}`, paneKey: PANE_A },
        orchestrationCompatibilityCallerAuthority: makeAuthority(`agent:${askerId}`, PANE_A)
      }
    )) as { message: { id: string }; relay: { outboxId: string } }

    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const settled = await pumpSettles(senderDb, reply.relay.outboxId, ['delivered'])
    if (settled?.state !== 'delivered') {
      throw new Error(
        `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
      )
    }
    expect(settled?.state).toBe('delivered')

    const onReceiver = receiverDb.getMessageById(reply.message.id)
    expect(onReceiver).toBeDefined()
    expect(onReceiver?.to_handle).toBe(`agent:${answererId}`)
    expect(onReceiver?.body).toBe('reply body')
  })

  // -----------------------------------------------------------------------------------------
  // Case B (pact step) — RED AT BASE (1f2d041ab8): pact-federated-emit.ts's `{ pact: wirePact }`
  // payload fails FederatedSendParams.parse on the real dial (zod issue path shown in this
  // commit's return); the pump's own classifyReplyRelayError turns that thrown ZodError into a
  // settle, never a silent hang, so the row still reaches a terminal state at base — just never
  // 'delivered'. After this commit's envelope fix it settles 'delivered'.
  // -----------------------------------------------------------------------------------------
  it('Case B (pact step): a federated step relays through the pump, applies on the receiver, and the sender settles+flips', async () => {
    // --- SENDER: a real registered local agent, a real peer_link_bindings row (pact-federated-
    // emit.ts's own getPeerLinkBinding reads the RAW table, never the routable wrapper), and a
    // federated pact forced straight to 'engaged' with the sender holding the turn — matching
    // pact-federated-emit.test.ts's own `engagedFederatedPact` fixture.
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
    const senderAgentId = seedAgent(senderDb, 'sendera')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_b' && evidence.paneKey === PANE_A
          ? makeAuthority('term_b', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receiverb', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_A }
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
      callerPaneKey: `tab:sendera`,
      callerHostId: 'local',
      threadId: senderThread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    // S10-21b B6c: proposePact now relays too (this file's own Case C exercises that relay for
    // real). This fixture's own subject is the STEP relay, not propose — mark the propose's own
    // outbox row already delivered (as if it happened before this test's timeline starts,
    // exactly like the pre-existing "force straight to engaged" line below) so the later
    // `senderRuntime.replyOutbox?.kick` for the step doesn't also attempt this pre-dated,
    // deliberately-fabricated propose out of order.
    raw(senderDb)
      .prepare(
        `UPDATE peer_reply_outbox SET state = 'delivered', settled_at = ? WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(Date.now(), senderThread.id)
    raw(senderDb)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(senderAgentId, senderThread.id)

    // --- RECEIVER: the B8 fixture pattern (orchestration-federated-peer-send-pact-
    // inbound.test.ts's own seedPeerThread/T27) — a local thread pre-anchored to the SENDER's
    // OWN thread id (the value the wire `threadId` carries, per this commit's Gate-1 note on the
    // threadId field), then driven through REAL propose+accept so every gate-required column
    // lands correctly, with the turn handed to the (remote) sender for the step that follows.
    function seedPeerThread(peerThreadId: string): string {
      const { thread } = receiverDb.createThread({
        subject: 'pact seed',
        createdByAgentId: null,
        origin: 'peer',
        participants: [
          { participantKey: receiverAgentId, agentId: receiverAgentId, role: 'member' }
        ]
      })
      raw(receiverDb)
        .prepare(
          `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ? WHERE id = ?`
        )
        .run(LINK_DEVICE_ID, peerThreadId, thread.id)
      return thread.id
    }
    const receiverThreadId = seedPeerThread(senderThread.id)
    // A-F2 fixture correction (SCENARIO_CORRECTION, deviation declared): the original fixture
    // seeded the RECEIVER as the (local) proposer — backwards from physical reality (the SENDER
    // is the one that really called `proposePact` above) — purely so it could drive an inbound
    // `accept` RPC (accept isn't wired as a LOCAL federated-emit source, B6's own scope note),
    // and then HAND-SET the receiver's turn column to the remote sender key to fake the state a
    // real peer step would need. That hand-set is what hid A-F2: the inbound `step` apply never
    // flipped the turn at base, so the round trip below never actually exercised the fix. Fixed
    // here by seeding the receiver's copy to match physical reality — proposer = the REMOTE
    // sender key, with = the local receiver — and driving the acceptance through `acceptPact`
    // (a real, non-fabricated, LOCAL call: this thread's local party is `pact_with_agent_id`
    // here, so its own acceptance is legitimately local, not relayed). Turn correctly lands on
    // the proposer — the remote sender — with zero raw hand-set, exactly the precondition the
    // sender's real `step` below needs to reach gate 13's holder check at all.
    const senderEra = (
      raw(senderDb).prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(senderThread.id) as {
        pact_era: number
      }
    ).pact_era
    // S10-21b B6c: proposePact now relays for real, consuming wire seq 1 (this file's own
    // Case C exercises that relay). `pact_peer_seq = 1` here fabricates "the propose already
    // arrived" on the receiver's mirror, matching physical reality now that the SENDER's
    // subsequent `step` below is genuinely seq 2, not the pre-B6c seq 1 gate 14 used to see.
    raw(receiverDb)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_era = ?, pact_peer_seq = 1 WHERE id = ?`
      )
      .run(
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        receiverAgentId,
        senderEra,
        receiverThreadId
      )
    receiverDb.acceptPact({
      callerAgentId: receiverAgentId,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId: receiverThreadId
    })

    // --- Drive the SENDER's real `step` through the emit primitive (the fix under test), then
    // pump one tick — the dial invokes the REAL receiver handler via the stubbed
    // callPinnedEnvironment installed in beforeEach.
    const stepResult = senderDb.appendPactStep({
      callerAgentId: senderAgentId,
      callerPaneKey: `tab:sendera`,
      callerHostId: 'local',
      threadId: senderThread.id,
      done: 'did the thing',
      runId: 'run1'
    })
    if (stepResult.outcome === 'refused') {
      throw new Error('unexpected refusal on the sender step')
    }
    const outboxId = (
      raw(senderDb)
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? ORDER BY seq DESC LIMIT 1`
        )
        .get(senderThread.id) as { id: string }
    ).id

    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const settled = await pumpSettles(senderDb, outboxId, ['delivered', 'refused', 'abandoned'])
    if (settled?.state !== 'delivered') {
      throw new Error(
        `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
      )
    }
    expect(settled?.state).toBe('delivered')

    const appliedStep = raw(receiverDb)
      .prepare(`SELECT relay_seq FROM pact_steps WHERE thread_id = ? AND kind = 'step'`)
      .get(receiverThreadId) as { relay_seq: number } | undefined
    // SCENARIO_CORRECTION (S10-21b B6c): was `toBe(1)` — the SENDER's `proposePact` above now
    // relays for real and consumes wire seq 1 itself (fabricated as already-arrived on the
    // receiver via `pact_peer_seq = 1` above); this step is the sender's SECOND relayed verb,
    // seq 2.
    expect(appliedStep?.relay_seq).toBe(2)

    // Identity mirroring: this is the FIRST inbound RPC call to touch receiverDb (accept was
    // local) — the sender's remote_agents row is minted during this step's own apply.
    const mirroredAfterStep = raw(receiverDb)
      .prepare(`SELECT 1 FROM remote_agents WHERE remote_agent_id = ?`)
      .get(senderAgentId)
    if (!mirroredAfterStep) {
      throw new Error(`no remote_agents row for ${senderAgentId} after the inbound step`)
    }

    // A-F2 (BLOCKER, the fix under test): the applied inbound `step` flips the RECEIVER's own
    // turn to the OTHER LOCAL party — itself — not left dangling on the remote sender forever.
    const receiverThreadAfter = receiverDb.getThread(receiverThreadId)
    expect(receiverThreadAfter?.pact_turn_agent_id).toBe(receiverAgentId)
    // ...and the receiver's own local `pact --step` now succeeds (RED at base: `not_your_turn`,
    // since at base the turn column was never flipped by the inbound apply at all).
    const receiverOwnStep = receiverDb.appendPactStep({
      callerAgentId: receiverAgentId,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId: receiverThreadId,
      done: 'receiver takes the turn back',
      runId: 'run2'
    })
    expect(receiverOwnStep.outcome).toBe('stepped')

    const senderThreadAfter = senderDb.getThread(senderThread.id)
    expect(senderThreadAfter?.pact_turn_agent_id).toBe(
      `remote:${LINK_DEVICE_ID}:${receiverAgentId}`
    )
    expect(senderThreadAfter?.pact_turn_in_flight_at).toBeNull()
  })

  // -----------------------------------------------------------------------------------------
  // Case C (S10-21b B6c) — RED AT BASE: proposePact/acceptPact/releasePact write their own
  // local ledger row directly and never relay on a federated pact, so the SENDER's `proposePact`
  // below never produces an outbox row at all (`proposeOutboxId` lookup throws). Exercises the
  // real end-to-end propose -> accept -> release across the REAL orchestration.federatedSend
  // handler on BOTH directions (this test is the only one in the file that also stubs
  // `receiverRuntime.callPinnedEnvironment`, for the accept/release relays flowing RECEIVER ->
  // SENDER).
  // -----------------------------------------------------------------------------------------
  it('Case C (S10-21b B6c): propose -> accept -> release relays through the pump, end to end, both directions', async () => {
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
    const senderAgentId = seedAgent(senderDb, 'senderc')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_c' && evidence.paneKey === PANE_A
          ? makeAuthority('term_c', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receiverc', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_c', paneKey: PANE_A }
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

    // The RECEIVER's mapped thread — `resolvePactThread`'s propose branch requires the two
    // hosts to "already share an ordinary mail thread" (pact-federated-inbound-gates.ts): a
    // thread whose own pact_peer_link_device_id/pact_peer_thread_id already name the SENDER's
    // thread. Same construction as Case B's own `seedPeerThread`, pre-dating any propose.
    const { thread: receiverThread } = receiverDb.createThread({
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: receiverAgentId, agentId: receiverAgentId, role: 'member' }]
    })
    raw(receiverDb)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ? WHERE id = ?`
      )
      .run(LINK_DEVICE_ID, senderThread.id, receiverThread.id)
    // enqueueFederatedPactVerb reads the RAW peer_link_bindings table (never the routable
    // wrapper mocked at file scope) — the RECEIVER's own subsequent `accept`/`release` relays
    // need a real row here, same as the SENDER's.
    putPeerLinkBinding(raw(receiverDb), {
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
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })

    // --- PROPOSE: sender -> receiver.
    senderDb.proposePact({
      callerAgentId: senderAgentId,
      callerPaneKey: 'tab:senderc',
      callerHostId: 'local',
      threadId: senderThread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    const proposeOutboxId = (
      raw(senderDb)
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
        )
        .get(senderThread.id) as { id: string }
    ).id
    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const proposeSettled = await pumpSettles(senderDb, proposeOutboxId, [
      'delivered',
      'refused',
      'abandoned'
    ])
    if (proposeSettled?.state !== 'delivered') {
      throw new Error(
        `propose: state=${proposeSettled?.state} code=${proposeSettled?.lastErrorCode} err=${proposeSettled?.lastError}`
      )
    }

    // Receiver applied the propose for real (B8's first-propose mapping) — no raw hand-set.
    const receiverAfterPropose = receiverDb.getThread(receiverThread.id)
    expect(receiverAfterPropose?.pact_state).toBe('proposed')
    expect(receiverAfterPropose?.pact_proposer_agent_id).toBe(
      `remote:${LINK_DEVICE_ID}:${senderAgentId}`
    )
    expect(receiverAfterPropose?.pact_with_agent_id).toBe(receiverAgentId)
    const senderAfterPropose = senderDb.getThread(senderThread.id)
    expect(receiverAfterPropose?.pact_era).toBe(senderAfterPropose?.pact_era)

    // S10-21b B7c (defect 21b-D2, RED at base): the propose's settle now stamps the receiver's
    // thread id onto the sender's OWN `threads.pact_peer_thread_id` for real (no raw hand-set)
    // — so `resolvePactThread`'s ordinary (non-propose) lookup can find this thread for the
    // LATER inbound accept/release this test drives below.
    expect(senderDb.getThread(senderThread.id)?.pact_peer_thread_id).toBe(receiverThread.id)

    // --- ACCEPT: receiver -> sender. The reverse direction needs its own dial stub (every
    // other test in this file dials one way only, sender -> receiver).
    vi.spyOn(receiverRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const fedMethod = method('orchestration.federatedSend')
      const parsed = fedMethod.params!.parse(args.params)
      return fedMethod.handler(parsed, receiverCtx(senderRuntime))
    })
    receiverDb.acceptPact({
      callerAgentId: receiverAgentId,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId: receiverThread.id
    })
    const acceptOutboxId = (
      raw(receiverDb)
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_accept'`
        )
        .get(receiverThread.id) as { id: string }
    ).id
    receiverRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const acceptSettled = await pumpSettles(receiverDb, acceptOutboxId, [
      'delivered',
      'refused',
      'abandoned'
    ])
    if (acceptSettled?.state !== 'delivered') {
      throw new Error(
        `accept: state=${acceptSettled?.state} code=${acceptSettled?.lastErrorCode} err=${acceptSettled?.lastError}`
      )
    }

    // Engaged on BOTH stores, same era, mirrored seqs (each side's own emit is seq 1: sender's
    // propose, receiver's accept; each side's peer_seq reflects the other's single relay).
    const receiverEngaged = receiverDb.getThread(receiverThread.id)
    const senderEngaged = senderDb.getThread(senderThread.id)
    expect(receiverEngaged?.pact_state).toBe('engaged')
    expect(senderEngaged?.pact_state).toBe('engaged')
    expect(receiverEngaged?.pact_era).toBe(senderEngaged?.pact_era)
    expect(receiverEngaged?.pact_local_seq).toBe(1)
    expect(senderEngaged?.pact_local_seq).toBe(1)
    expect(receiverEngaged?.pact_peer_seq).toBe(1)
    expect(senderEngaged?.pact_peer_seq).toBe(1)
    expect(receiverEngaged?.pact_turn_in_flight_at).toBeNull()

    // --- RELEASE: receiver -> sender.
    receiverDb.releasePact({
      callerAgentId: receiverAgentId,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId: receiverThread.id,
      reasonCode: null
    })
    const releaseOutboxId = (
      raw(receiverDb)
        .prepare(
          `SELECT id FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_release'`
        )
        .get(receiverThread.id) as { id: string }
    ).id
    receiverRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const releaseSettled = await pumpSettles(receiverDb, releaseOutboxId, [
      'delivered',
      'refused',
      'abandoned'
    ])
    if (releaseSettled?.state !== 'delivered') {
      throw new Error(
        `release: state=${releaseSettled?.state} code=${releaseSettled?.lastErrorCode} err=${releaseSettled?.lastError}`
      )
    }

    // The sender shows released with pact_peer_release_at set (N9: an inbound PEER release
    // never sets pact_release_at — that stays the local host's own release only).
    const senderReleased = senderDb.getThread(senderThread.id)
    expect(senderReleased?.pact_state).toBe('released')
    expect(senderReleased?.pact_peer_release_at).not.toBeNull()
    expect(senderReleased?.pact_release_at).toBeNull()

    // The receiver's OWN release (the local half) stamps pact_release_at, never
    // pact_peer_release_at.
    const receiverReleased = receiverDb.getThread(receiverThread.id)
    expect(receiverReleased?.pact_state).toBe('released')
    expect(receiverReleased?.pact_release_at).not.toBeNull()
    expect(receiverReleased?.pact_peer_release_at).toBeNull()
  })

  // -----------------------------------------------------------------------------------------
  // Case D (S10-21b B7c, item 2, 21b-Q3) — RED AT BASE: resetAll's reserved release relay is
  // built by hand against a fabricated messageId with no `messages` row behind it, so
  // `local_message_id` on the outbox row dangles. This drives it through the REAL pump: the
  // outbox row's local_message_id must reference an existing messages row and its payload must
  // parse against `orchestration.federatedSend`'s own params, and delivering it must show the
  // PEER (not the resetting host) `pact_peer_release_at`.
  // -----------------------------------------------------------------------------------------
  it('Case D (S10-21b B7c): resetAll relays a real message row for its reserved release, and a pump tick delivers it', async () => {
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
    const senderAgentId = seedAgent(senderDb, 'senderd')

    vi.spyOn(receiverRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence) =>
        evidence?.terminalHandle === 'term_d' && evidence.paneKey === PANE_A
          ? makeAuthority('term_d', PANE_A)
          : null
    )
    const registeredReceiver = (await call(
      'orchestration.agents.register',
      { name: 'receiverd', role: 'test agent' },
      {
        runtime: receiverRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_d', paneKey: PANE_A }
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
      callerPaneKey: `tab:senderd`,
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
    // B6's era-adoption bumps the era at propose — the receiver's mirror must match it.
    const senderEra = (
      raw(senderDb).prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(senderThread.id) as {
        pact_era: number
      }
    ).pact_era

    // Receiver: a mirrored engaged pact, pact_peer_link_device_id/pact_peer_thread_id anchored
    // to the sender's thread — the fields resolvePactThread's inbound release needs to find it.
    const { thread: receiverThread } = receiverDb.createThread({
      subject: 'pact seed',
      createdByAgentId: null,
      origin: 'peer',
      participants: [{ participantKey: receiverAgentId, agentId: receiverAgentId, role: 'member' }]
    })
    raw(receiverDb)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ?,
           pact_peer_agent_id = ?, pact_state = 'engaged', pact_peer_seq = 1, pact_era = ?,
           pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_turn_agent_id = ?
         WHERE id = ?`
      )
      .run(
        LINK_DEVICE_ID,
        senderThread.id,
        senderAgentId,
        senderEra,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        receiverAgentId,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        receiverThread.id
      )
    putPeerLinkBinding(raw(receiverDb), {
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
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })

    // --- The reset under test.
    senderDb.resetAll()

    const outboxRow = raw(senderDb)
      .prepare(
        `SELECT id, local_message_id, payload FROM peer_reply_outbox WHERE local_thread_id = ?`
      )
      .get(senderThread.id) as { id: string; local_message_id: string; payload: string }
    const messageRow = raw(senderDb)
      .prepare(`SELECT id FROM messages WHERE id = ?`)
      .get(outboxRow.local_message_id) as { id: string } | undefined
    expect(messageRow?.id).toBe(outboxRow.local_message_id)
    const fedMethod = method('orchestration.federatedSend')
    expect(() => fedMethod.params!.parse(JSON.parse(outboxRow.payload))).not.toThrow()

    senderRuntime.replyOutbox?.kick(LINK_DEVICE_ID)
    const settled = await pumpSettles(senderDb, outboxRow.id, ['delivered', 'refused', 'abandoned'])
    if (settled?.state !== 'delivered') {
      throw new Error(
        `state=${settled?.state} code=${settled?.lastErrorCode} err=${settled?.lastError}`
      )
    }

    const receiverAfter = receiverDb.getThread(receiverThread.id)
    expect(receiverAfter?.pact_peer_release_at).not.toBeNull()
  })
})
