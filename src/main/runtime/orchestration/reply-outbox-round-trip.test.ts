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
    raw(senderDb)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(senderAgentId, senderThread.id)
    // The fabricated 'accept' below (raw-seeded receiver, no real propose/accept relay wired
    // yet — B6's own scope note) occupies the receiver's peer_seq slot 1 for senderAgentId;
    // bump the sender's own local_seq to 1 here so the REAL step that follows lands on seq 2,
    // matching gate 14's fence expectation on the receiver.
    raw(senderDb).prepare(`UPDATE threads SET pact_local_seq = 1 WHERE id = ?`).run(senderThread.id)

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
    function pactSend(pact: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
      return call(
        'orchestration.federatedSend',
        {
          fromAgent: { id: senderAgentId, displayName: 'sender-a', role: null },
          toAgentId: receiverAgentId,
          messageId: overrides.messageId ?? 'msg_aaaaaaaaaaa1',
          threadId: overrides.threadId ?? senderThread.id,
          subject: 'pact',
          pact,
          ...overrides
        },
        receiverCtx(receiverRuntime)
      )
    }
    // T27's own pattern: seed 'proposed' directly (propose/accept aren't wired as LOCAL-verb
    // emit sources yet — B6's own scope note — so a real two-hop propose can't be driven here),
    // then ONE real inbound `accept` RPC call, which is what B8 actually applies and this test
    // exercises for real.
    const senderEra = (
      raw(senderDb).prepare(`SELECT pact_era FROM threads WHERE id = ?`).get(senderThread.id) as {
        pact_era: number
      }
    ).pact_era
    raw(receiverDb)
      .prepare(
        `UPDATE threads SET pact_state = 'proposed', pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_era = ? WHERE id = ?`
      )
      .run(
        receiverAgentId,
        `remote:${LINK_DEVICE_ID}:${senderAgentId}`,
        senderEra,
        receiverThreadId
      )
    await pactSend({ verb: 'accept', seq: 1, era: senderEra })
    // Accept hands the turn to the local proposer (T2) — a peer step needs the turn, so hand it
    // back to the (remote) sender, matching T27.
    raw(receiverDb)
      .prepare(`UPDATE threads SET pact_turn_agent_id = ? WHERE id = ?`)
      .run(`remote:${LINK_DEVICE_ID}:${senderAgentId}`, receiverThreadId)
    const mirroredAfterAccept = raw(receiverDb)
      .prepare(`SELECT * FROM remote_agents WHERE remote_agent_id = ?`)
      .get(senderAgentId)
    if (!mirroredAfterAccept) {
      throw new Error(`no remote_agents row for ${senderAgentId} after accept`)
    }

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
    expect(appliedStep?.relay_seq).toBe(2) // sender's local_seq: 1 (pre-bumped) + 1 (this step)

    const senderThreadAfter = senderDb.getThread(senderThread.id)
    expect(senderThreadAfter?.pact_turn_agent_id).toBe(
      `remote:${LINK_DEVICE_ID}:${receiverAgentId}`
    )
    expect(senderThreadAfter?.pact_turn_in_flight_at).toBeNull()
  })
})
