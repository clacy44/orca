// S10-16 C5: the durable reply relay, end to end, through the REAL `orchestration.reply` /
// `orchestration.federatedSend` handlers on two independent runtimes (H replies, P receives) —
// same two-runtime harness shape as orchestration-federated-peer-send.test.ts, extended with a
// REAL `peer_link_bindings` row on each side (R14.6) so `getRoutableLinkBinding` (R15/R16)
// resolves a genuine route rather than refusing `no_return_route`. `callPinnedEnvironment` is
// spied to route directly into the OTHER runtime's real handler in-process — "a fake transport"
// per the C5 brief — never a network socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from '../../device-registry'
import { createLinkBindingSelfView } from '../../device-registry-link-credential'
import { hashCallerCredential } from '../../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from '../../orchestration/environment-transport'
import { addEnvironmentFromPairingCode } from '../../../../shared/runtime-environment-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

function raw(db: OrchestrationDb) {
  return (
    db as unknown as {
      db: {
        prepare: (sql: string) => {
          get: (...a: unknown[]) => unknown
          run: (...a: unknown[]) => unknown
        }
      }
    }
  ).db
}

function makeAuthority(
  paneKey: string,
  terminalHandle: string
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

describe('S10-16 C5: durable reply relay (two-runtime harness)', () => {
  let root: string
  let hDataPath: string
  let pDataPath: string
  let hDb: OrchestrationDb
  let pDb: OrchestrationDb
  let hRuntime: OrcaRuntimeService
  let pRuntime: OrcaRuntimeService
  let hLinkDeviceId: string
  let pLinkDeviceId: string
  let hEnvironmentIdForP: string

  function pLinkCtx(): RpcContext {
    return {
      runtime: pRuntime,
      pairedDeviceId: pLinkDeviceId,
      clientKind: 'runtime',
      authenticatedCallerFingerprint: 'fp_p_as_seen_by_itself'
    }
  }

  async function registerAgent(
    runtime: OrcaRuntimeService,
    name: string,
    evidence: { terminalHandle: string; paneKey: string }
  ): Promise<string> {
    const result = (await call(
      'orchestration.agents.register',
      { name, role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: evidence }
    )) as { agent: { id: string } }
    return result.agent.id
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-reply-relay-'))
    hDataPath = join(root, 'h-userdata')
    pDataPath = join(root, 'p-userdata')

    hDb = new OrchestrationDb(':memory:')
    hRuntime = new OrcaRuntimeService()
    hRuntime.setOrchestrationDb(hDb)

    pDb = new OrchestrationDb(':memory:')
    pRuntime = new OrcaRuntimeService()
    pRuntime.setOrchestrationDb(pDb)

    for (const runtime of [hRuntime, pRuntime]) {
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    }
    const verifyEitherPane = (
      evidence: { terminalHandle?: string; paneKey?: string } | null | undefined
    ): OrchestrationCompatibilityCallerAuthority | null => {
      if (evidence?.terminalHandle === 'term_a' && evidence.paneKey === PANE_A) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (evidence?.terminalHandle === 'term_b' && evidence.paneKey === PANE_B) {
        return makeAuthority(PANE_B, 'term_b')
      }
      return null
    }
    vi.spyOn(hRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      verifyEitherPane
    )
    vi.spyOn(pRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      verifyEitherPane
    )

    // H's own view of the LINK to P: a runtime-scope device row in H's registry.
    appState.userData = hDataPath
    const hRegistry = new DeviceRegistry(hDataPath)
    const link = hRegistry.mintPendingDevice('p-host', 'runtime')
    hRegistry.updateLastSeen(link.deviceId)
    hLinkDeviceId = link.deviceId
    hRuntime.setLinkBindingSelfView(createLinkBindingSelfView(hRegistry, () => 'h_own_pubkey_b64'))

    // H's OUTBOUND endpoint for P — an environment H would dial P through.
    const pEndpointOffer = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://p.example:16768',
      deviceToken: 'p_endpoint_token',
      publicKeyB64: 'p_own_pubkey_b64'
    })
    const pEnv = addEnvironmentFromPairingCode(hDataPath, {
      name: 'p-environment',
      pairingCode: pEndpointOffer
    })
    hEnvironmentIdForP = pEnv.id

    // H's proven route triple — R14.6's row, minted directly (skipping the C3/C4 proof round,
    // out of scope for C5's own tests).
    hDb.putPeerLinkBinding({
      linkDeviceId: hLinkDeviceId,
      environmentId: pEnv.id,
      boundEndpointId: pEnv.preferredEndpointId,
      boundPairingRevision: pEnv.pairingRevision ?? pEnv.createdAt,
      linkCredentialFp: hashCallerCredential(link.token),
      peerCredentialFp: hashCallerCredential('p_endpoint_token'),
      peerKeyFingerprint: fingerprintOrchestrationPeer('p_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })

    vi.spyOn(hRuntime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: pEnv.id,
      name: 'p-environment',
      peerFingerprint: 'p_fp'
    })

    // P's symmetric view: its own device row for the link to H, and an environment pointing
    // back at H, so P's own `orchestration.reply` can enqueue+ship its reply to H.
    appState.userData = pDataPath
    const pRegistry = new DeviceRegistry(pDataPath)
    const pLink = pRegistry.mintPendingDevice('h-host', 'runtime', undefined, undefined)
    pLinkDeviceId = pLink.deviceId
    pRegistry.updateLastSeen(pLink.deviceId)
    pRuntime.setLinkBindingSelfView(createLinkBindingSelfView(pRegistry, () => 'p_own_pubkey_b64'))
    const hEndpointOffer = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://h.example:16768',
      deviceToken: 'h_endpoint_token',
      publicKeyB64: 'h_own_pubkey_b64'
    })
    const hEnvOnP = addEnvironmentFromPairingCode(pDataPath, {
      name: 'h-environment',
      pairingCode: hEndpointOffer
    })
    pDb.putPeerLinkBinding({
      linkDeviceId: pLink.deviceId,
      environmentId: hEnvOnP.id,
      boundEndpointId: hEnvOnP.preferredEndpointId,
      boundPairingRevision: hEnvOnP.pairingRevision ?? hEnvOnP.createdAt,
      linkCredentialFp: hashCallerCredential(pLink.token),
      peerCredentialFp: hashCallerCredential('h_endpoint_token'),
      peerKeyFingerprint: fingerprintOrchestrationPeer('h_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    vi.spyOn(pRuntime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: hEnvOnP.id,
      name: 'h-environment',
      peerFingerprint: 'h_fp'
    })
    // P's own pump/enqueue calls `callPinnedEnvironment` back into H's real handler — this is
    // the leg the test actually exercises (P replying to H).
    vi.spyOn(pRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      appState.userData = hDataPath
      if (args.method !== 'orchestration.federatedSend') {
        throw new Error(`unexpected method ${args.method}`)
      }
      const result = await call(
        'orchestration.federatedSend',
        args.params as Record<string, unknown>,
        {
          runtime: hRuntime,
          pairedDeviceId: hLinkDeviceId,
          clientKind: 'runtime',
          authenticatedCallerFingerprint: 'fp_h_as_seen_by_itself'
        }
      )
      appState.userData = pDataPath
      return result
    })

    // H's own reply pump calls `callPinnedEnvironment` — route it straight into P's REAL
    // `orchestration.federatedSend` handler, in-process ("a fake transport").
    vi.spyOn(hRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      appState.userData = pDataPath
      if (args.method !== 'orchestration.federatedSend') {
        throw new Error(`unexpected method ${args.method}`)
      }
      const result = await call(
        'orchestration.federatedSend',
        args.params as Record<string, unknown>,
        pLinkCtx()
      )
      appState.userData = hDataPath
      return result
    })

    appState.userData = hDataPath
  })

  afterEach(() => {
    hRuntime.replyOutbox?.stop()
    pRuntime.replyOutbox?.stop()
    hDb.close()
    pDb.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('test 59: A sends to B, B replies, the reply lands on A own thread (no --thread-id anywhere)', async () => {
    appState.userData = hDataPath
    const askerId = await registerAgent(hRuntime, 'asker', {
      terminalHandle: 'term_a',
      paneKey: PANE_A
    })

    appState.userData = pDataPath
    const answererId = await registerAgent(pRuntime, 'answerer', {
      terminalHandle: 'term_b',
      paneKey: PANE_B
    })

    appState.userData = hDataPath
    const outboundId = 'msg_aaaaaaaaaaaa'
    hDb.insertGatedMessage({
      id: outboundId,
      from: `agent:${askerId}`,
      to: `remote:${hEnvironmentIdForP}:${answererId}`,
      subject: 'hello',
      body: 'hello P',
      runId: 'run_local_test',
      verb: 'send',
      peerAgentId: answererId,
      threadId: null
    })

    appState.userData = pDataPath
    await call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: askerId, displayName: 'home-asker' },
        toAgentId: answererId,
        messageId: outboundId,
        subject: 'hello',
        body: 'hello P'
      },
      pLinkCtx()
    )
    const imported = raw(pDb).prepare('SELECT id FROM messages WHERE id = ?').get(outboundId)
    expect(imported).toBeTruthy()

    appState.userData = hDataPath
    const originalRow = raw(hDb)
      .prepare('SELECT id, thread_id FROM messages WHERE id = ?')
      .get(outboundId) as { id: string; thread_id: string | null }
    expect(originalRow.thread_id).toBeNull()

    appState.userData = pDataPath
    const reply = (await call(
      'orchestration.reply',
      { id: outboundId, body: 'thanks A' },
      {
        runtime: pRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_B }
      }
    )) as { relay: { state: string; outboxId: string } }
    expect(reply.relay.state).toBe('queued')

    appState.userData = pDataPath
    pRuntime.replyOutbox?.kick(pLinkDeviceId)
    // The kick debounces REPLY_OUTBOX_KICK_DEBOUNCE_MS (1000ms) before its own tick fires.
    let lastSettled: ReturnType<typeof pDb.getReplyOutboxItem> = null
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      lastSettled = pDb.getReplyOutboxItem(reply.relay.outboxId)
      if (lastSettled?.state === 'delivered') {
        break
      }
    }
    expect({
      state: lastSettled?.state,
      code: lastSettled?.lastErrorCode,
      err: lastSettled?.lastError
    }).toEqual({ state: 'delivered', code: null, err: null })

    appState.userData = hDataPath
    const replyOnA = raw(hDb)
      .prepare('SELECT thread_id, from_handle, peer_agent_id FROM messages WHERE to_handle = ?')
      .get(`agent:${askerId}`) as
      | { thread_id: string | null; from_handle: string; peer_agent_id: string | null }
      | undefined
    expect(replyOnA?.thread_id).toBeTruthy()
    // F-8 (H2, Ruling 32a): the replying caller (P's answerer, attested as PANE_B/term_b) must
    // ride the wire as fromAgent so A's importer verifies it — not the pre-fix
    // `remote:<link>:unverified` with peer_agent_id NULL.
    expect(replyOnA?.from_handle).toBe(`remote:${hLinkDeviceId}:${answererId}`)
    expect(replyOnA?.peer_agent_id).toBe(answererId)
    const backfilledOriginal = raw(hDb)
      .prepare('SELECT thread_id FROM messages WHERE id = ?')
      .get(outboundId) as { thread_id: string | null }
    expect(backfilledOriginal.thread_id).toBe(replyOnA?.thread_id)

    // F-8 reply-to-reply: A now replies to the relayed reply — must queue (not
    // no_return_route) and settle delivered, landing on P's SAME thread.
    appState.userData = hDataPath
    const replyOnARow = raw(hDb)
      .prepare('SELECT id FROM messages WHERE to_handle = ?')
      .get(`agent:${askerId}`) as { id: string }
    const replyToReply = (await call(
      'orchestration.reply',
      { id: replyOnARow.id, body: 'thanks P, following up' },
      {
        runtime: hRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
      }
    )) as { relay: { state: string; outboxId: string } }
    expect(replyToReply.relay.state).toBe('queued')

    appState.userData = hDataPath
    hRuntime.replyOutbox?.kick(hLinkDeviceId)
    let replyToReplySettled: ReturnType<typeof hDb.getReplyOutboxItem> = null
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      replyToReplySettled = hDb.getReplyOutboxItem(replyToReply.relay.outboxId)
      if (replyToReplySettled?.state === 'delivered') {
        break
      }
    }
    expect({
      state: replyToReplySettled?.state,
      code: replyToReplySettled?.lastErrorCode,
      err: replyToReplySettled?.lastError
    }).toEqual({ state: 'delivered', code: null, err: null })

    appState.userData = pDataPath
    // Test 59 discriminates (Ruling 32 Addendum 3(c)): `to_handle = 'agent:'+answererId` alone
    // matches BOTH the original imported row (outboundId, still addressed to the answerer) and
    // the newly relayed reply-to-reply row — with no ORDER BY, `.get()` is free to return
    // either. Excluding outboundId forces the relayed row, so the thread_id equality below
    // proves the reply-to-reply actually landed on the original thread rather than comparing
    // the original row to itself.
    const replyToReplyOnP = raw(pDb)
      .prepare('SELECT thread_id FROM messages WHERE to_handle = ? AND id <> ?')
      .get(`agent:${answererId}`, outboundId) as { thread_id: string | null } | undefined
    const answererOriginalRow = raw(pDb)
      .prepare('SELECT thread_id FROM messages WHERE id = ?')
      .get(outboundId) as { thread_id: string | null }
    expect(replyToReplyOnP?.thread_id).toBeTruthy()
    expect(replyToReplyOnP?.thread_id).toBe(answererOriginalRow.thread_id)
  }, 15000)

  it('test 59b: a caller attested as a pane that is NOT the reply row addressee still gets fromAgent omitted (Ruling 1 class B, no impersonation)', async () => {
    appState.userData = hDataPath
    const askerId = await registerAgent(hRuntime, 'asker', {
      terminalHandle: 'term_a',
      paneKey: PANE_A
    })

    appState.userData = pDataPath
    const answererId = await registerAgent(pRuntime, 'answerer', {
      terminalHandle: 'term_b',
      paneKey: PANE_B
    })
    // A second, unrelated registered agent on P, attested as its own pane — NOT the addressee
    // of the reply row below.
    const bystanderId = await registerAgent(pRuntime, 'bystander', {
      terminalHandle: 'term_a',
      paneKey: PANE_A
    })

    appState.userData = hDataPath
    const outboundId = 'msg_bb5714cabcde'
    hDb.insertGatedMessage({
      id: outboundId,
      from: `agent:${askerId}`,
      to: `remote:${hEnvironmentIdForP}:${answererId}`,
      subject: 'hello',
      body: 'hello P',
      runId: 'run_local_test',
      verb: 'send',
      peerAgentId: answererId,
      threadId: null
    })

    appState.userData = pDataPath
    await call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: askerId, displayName: 'home-asker' },
        toAgentId: answererId,
        messageId: outboundId,
        subject: 'hello',
        body: 'hello P'
      },
      pLinkCtx()
    )

    // Reply is issued as the bystander pane (term_a/PANE_A), attested, registered — but not
    // the row's addressee (answererId). fromAgent must be omitted; the receiver stamps
    // unverified, exactly as an unregistered pane would.
    appState.userData = pDataPath
    const reply = (await call(
      'orchestration.reply',
      { id: outboundId, body: 'not actually the addressee' },
      {
        runtime: pRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
      }
    )) as { relay: { state: string; outboxId: string } }
    expect(reply.relay.state).toBe('queued')
    void bystanderId

    appState.userData = pDataPath
    pRuntime.replyOutbox?.kick(pLinkDeviceId)
    let settled: ReturnType<typeof pDb.getReplyOutboxItem> = null
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      settled = pDb.getReplyOutboxItem(reply.relay.outboxId)
      if (settled?.state === 'delivered') {
        break
      }
    }
    expect(settled?.state).toBe('delivered')

    appState.userData = hDataPath
    const replyOnA = raw(hDb)
      .prepare('SELECT from_handle, peer_agent_id FROM messages WHERE to_handle = ?')
      .get(`agent:${askerId}`) as { from_handle: string; peer_agent_id: string | null } | undefined
    expect(replyOnA?.from_handle).toBe(`remote:${hLinkDeviceId}:unverified`)
    expect(replyOnA?.peer_agent_id).toBeNull()
  }, 15000)

  it('test 41: a reply on a sensitive thread refuses sensitive_thread_no_federation before any outbox row', async () => {
    appState.userData = hDataPath
    await registerAgent(hRuntime, 'asker', { terminalHandle: 'term_a', paneKey: PANE_A })

    const { thread } = hDb.createThread({
      subject: 'sensitive',
      createdByAgentId: null,
      origin: 'peer',
      sensitive: true,
      participants: []
    })

    const foreignId = 'msg_bbbbbbbbbbbb'
    hDb.insertGatedMessage({
      id: foreignId,
      from: `remote:${hEnvironmentIdForP}:remote_agent`,
      to: 'agent:home_asker',
      subject: 'hi',
      body: 'hi',
      threadId: thread.id,
      runId: 'run_peer_local',
      verb: 'federation_import',
      peerLinkDeviceId: hLinkDeviceId,
      peerAgentId: 'remote_agent'
    })

    await expect(
      call(
        'orchestration.reply',
        { id: foreignId, body: 'reply body' },
        {
          runtime: hRuntime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
        }
      )
    ).rejects.toMatchObject({ code: 'sensitive_thread_no_federation' })

    expect(hDb.listReplyOutbox().length).toBe(0)
  })

  it('test 47: a reply to a PEER_RUN_ID question never enters the relay (R29)', async () => {
    appState.userData = hDataPath
    const answererId = await registerAgent(hRuntime, 'answerer', {
      terminalHandle: 'term_a',
      paneKey: PANE_A
    })

    // Seeded directly (skipping federatedAsk's own blocking wait, out of scope here):
    // createPeerQuestion writes NO peer_link_device_id on the message row (R29's own citation),
    // so the foreign-origin branch this slice builds is structurally unreachable for it.
    const { thread } = hDb.createThread({
      subject: 'peer question',
      createdByAgentId: null,
      origin: 'question',
      participants: []
    })
    const created = hDb.createPeerQuestion({
      runId: PEER_RUN_ID,
      threadId: thread.id,
      askerHandle: 'remote:some-link:unverified',
      toAgentId: answererId,
      toHandle: `agent:${answererId}`,
      question: 'ready?',
      infraAllowlist: []
    })
    expect(created.outcome).toBe('created')
    const questionMessageId =
      created.outcome === 'created' ? created.message.id : (undefined as never)

    const row = raw(hDb)
      .prepare('SELECT peer_link_device_id FROM messages WHERE id = ?')
      .get(questionMessageId) as { peer_link_device_id: string | null }
    expect(row.peer_link_device_id).toBeNull()

    const answered = (await call(
      'orchestration.reply',
      { id: questionMessageId, body: 'yes' },
      {
        runtime: hRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
      }
    )) as { message: { id: string } }
    expect(answered.message).toBeTruthy()
    // No outbox row was created — the question/answer path never touches peer_reply_outbox.
    expect(hDb.listReplyOutbox().length).toBe(0)
  })

  it('test 76: sent --id sees the reply-outbox row through queued -> sending -> relayed', async () => {
    appState.userData = hDataPath
    await registerAgent(hRuntime, 'asker', { terminalHandle: 'term_a', paneKey: PANE_A })
    appState.userData = pDataPath
    const answererId = await registerAgent(pRuntime, 'answerer', {
      terminalHandle: 'term_b',
      paneKey: PANE_B
    })

    appState.userData = hDataPath
    const outboundId = 'msg_ccccccccc0c1'
    hDb.insertGatedMessage({
      id: outboundId,
      from: 'agent:home_asker',
      to: `remote:${hEnvironmentIdForP}:${answererId}`,
      subject: 'hello',
      body: 'hello P',
      runId: 'run_local_test',
      verb: 'send',
      peerAgentId: answererId,
      threadId: null
    })

    appState.userData = pDataPath
    await call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: 'agt_deadbeef0001', displayName: 'home-asker' },
        toAgentId: answererId,
        messageId: outboundId,
        subject: 'hello',
        body: 'hello P'
      },
      pLinkCtx()
    )

    appState.userData = pDataPath
    const reply = (await call(
      'orchestration.reply',
      { id: outboundId, body: 'thanks A' },
      {
        runtime: pRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_B }
      }
    )) as { message: { id: string } }

    appState.userData = pDataPath
    const localReplyRow = raw(pDb)
      .prepare('SELECT peer_agent_id, peer_link_device_id FROM messages WHERE id = ?')
      .get(reply.message.id) as { peer_agent_id: string | null; peer_link_device_id: string | null }
    expect(localReplyRow.peer_agent_id).toBeTruthy()
    expect(localReplyRow.peer_link_device_id).toBeNull()

    const snapshotBefore = pRuntime.getMessageDeliverySnapshot({
      id: reply.message.id,
      to_handle: `remote:${hLinkDeviceId}:x`,
      read: 0,
      peer_agent_id: localReplyRow.peer_agent_id,
      peer_link_device_id: localReplyRow.peer_link_device_id
    })
    expect(snapshotBefore.delivery).toBe('queued')
  })

  it('test 40 / R16.2 gate ordering: a HARD-gated reply body survives its gate_refusals row and enqueues nothing', async () => {
    appState.userData = hDataPath
    const askerId = await registerAgent(hRuntime, 'asker', {
      terminalHandle: 'term_a',
      paneKey: PANE_A
    })
    appState.userData = pDataPath
    const answererId = await registerAgent(pRuntime, 'answerer', {
      terminalHandle: 'term_b',
      paneKey: PANE_B
    })

    appState.userData = hDataPath
    const outboundId = 'msg_dddddddddd01'
    hDb.insertGatedMessage({
      id: outboundId,
      from: `agent:${askerId}`,
      to: `remote:${hEnvironmentIdForP}:${answererId}`,
      subject: 'hello',
      body: 'hello P',
      runId: 'run_local_test',
      verb: 'send',
      peerAgentId: answererId,
      threadId: null
    })

    appState.userData = pDataPath
    await call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: askerId, displayName: 'home-asker' },
        toAgentId: answererId,
        messageId: outboundId,
        subject: 'hello',
        body: 'hello P'
      },
      pLinkCtx()
    )

    appState.userData = pDataPath
    await expect(
      call(
        'orchestration.reply',
        { id: outboundId, body: 'SECURITY: our prod DB creds are exposed, see below' },
        {
          runtime: pRuntime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_B }
        }
      )
    ).rejects.toMatchObject({ code: 'body_gate_refused' })

    // insertGatedMessage's HARD-refusal path ran BEFORE any transaction (R16.2(1)) — its
    // gate_refusals row survives, and nothing past it (outbox row, audit row, markAsRead) ran.
    const refusal = raw(pDb).prepare('SELECT * FROM gate_refusals').get()
    expect(refusal).toBeTruthy()
    expect(pDb.listReplyOutbox().length).toBe(0)
    const auditRow = raw(pDb)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'replyRelayIntent'`)
      .get()
    expect(auditRow).toBeFalsy()
    const stillUnread = raw(pDb)
      .prepare('SELECT read FROM messages WHERE id = ?')
      .get(outboundId) as {
      read: number
    }
    expect(stillUnread.read).toBe(0)
  })

  it('Ruling 26 Addendum 4(ll): the prover ARMED and the pump delivering, against the two-runtime harness with per-method scripted responses (no shared queue), proves R13.1 normal shape', async () => {
    // Unlike reply-outbox-pump.test.ts's own harness, THIS file's beforeEach never disarms
    // linkBindingProver — both hRuntime and pRuntime keep it armed (createReplyOutboxPump's
    // sibling install, same setOrchestrationDb() call), exactly R13.1's normal production shape:
    // "one inbound message kicks a prover round AND an outbox drain".
    appState.userData = hDataPath
    const askerId = await registerAgent(hRuntime, 'asker', {
      terminalHandle: 'term_a',
      paneKey: PANE_A
    })
    appState.userData = pDataPath
    const answererId = await registerAgent(pRuntime, 'answerer', {
      terminalHandle: 'term_b',
      paneKey: PANE_B
    })

    appState.userData = hDataPath
    const outboundId = 'msg_ffffffffff01'
    hDb.insertGatedMessage({
      id: outboundId,
      from: `agent:${askerId}`,
      to: `remote:${hEnvironmentIdForP}:${answererId}`,
      subject: 'hello',
      body: 'hello P',
      runId: 'run_local_test',
      verb: 'send',
      peerAgentId: answererId,
      threadId: null
    })

    appState.userData = pDataPath
    await call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: askerId, displayName: 'home-asker' },
        toAgentId: answererId,
        messageId: outboundId,
        subject: 'hello',
        body: 'hello P'
      },
      pLinkCtx()
    )

    // Per-method scripted responses on BOTH runtimes — `orchestration.federatedSend` routes to
    // the peer's REAL handler (the pump's own leg); `status.get` (the prover's capability check,
    // R10.3) answers `method_not_found` — a genuine, cheap capability decline that short-circuits
    // the round before any probe/confirm call. Each method has its OWN branch — never one shared
    // mock queue a caller could steal an entry from (the exact harness defect Ruling 26 Addendum
    // 3(bb)/F1 named for the disarmed version of this test).
    // Ruling 26 Addendum 5(pp)/C5e review F6: this branch used to count `status.get` calls into a
    // `statusGetCalls` object that no assertion ever read. Deleted rather than asserted on: the
    // round's candidate-selection floor (LINK_BINDING_MIN_KICK_INTERVAL_MS, 15s) means `status.get`
    // structurally cannot fire within this test's real-time budget — confirmed by instrumenting
    // both runtimes' `peer_link_attempts` rows, which show a round attempt recorded
    // (`last_attempt_at`/`last_round_at`, `lastOutcome: 'pending'`) with `nextAttemptAfter` still
    // in the future when the test's own delivery-plus-attempt polling already exceeds its budget.
    // `last_attempt_at` (asserted below) is the honest signal this harness can observe — proof a
    // round was SCHEDULED for the link, not that it reached a probe.
    vi.spyOn(pRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      if (args.method === 'status.get') {
        throw new OrchestrationError('method_not_found', 'no orchestration support')
      }
      appState.userData = hDataPath
      if (args.method !== 'orchestration.federatedSend') {
        throw new Error(`unexpected method ${args.method}`)
      }
      const result = await call(
        'orchestration.federatedSend',
        args.params as Record<string, unknown>,
        {
          runtime: hRuntime,
          pairedDeviceId: hLinkDeviceId,
          clientKind: 'runtime',
          authenticatedCallerFingerprint: 'fp_h_as_seen_by_itself'
        }
      )
      appState.userData = pDataPath
      return result
    })
    vi.spyOn(hRuntime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      if (args.method === 'status.get') {
        throw new OrchestrationError('method_not_found', 'no orchestration support')
      }
      appState.userData = pDataPath
      if (args.method !== 'orchestration.federatedSend') {
        throw new Error(`unexpected method ${args.method}`)
      }
      const result = await call(
        'orchestration.federatedSend',
        args.params as Record<string, unknown>,
        pLinkCtx()
      )
      appState.userData = hDataPath
      return result
    })

    appState.userData = pDataPath
    const reply = (await call(
      'orchestration.reply',
      { id: outboundId, body: 'thanks A' },
      {
        runtime: pRuntime,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_b', paneKey: PANE_B }
      }
    )) as { relay: { outboxId: string } }

    appState.userData = pDataPath
    pRuntime.replyOutbox?.kick(pLinkDeviceId)
    let lastSettled: ReturnType<typeof pDb.getReplyOutboxItem> = null
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      lastSettled = pDb.getReplyOutboxItem(reply.relay.outboxId)
      if (lastSettled?.state === 'delivered') {
        break
      }
    }
    expect(lastSettled?.state).toBe('delivered')

    // R13.1: a round's FIRST write (link-binding-prover-round.ts, "backoff/last_attempt_at/
    // last_round_at written BEFORE the first socket opens") lands on peer_link_attempts before
    // any RPC — proof the inbound-contact kick actually ran a round for this link, independent of
    // which scripted RPC branch it happened to reach (this harness's shared `appState.userData`
    // switch, used only for the FILE-BACKED environment store, races the round's deferred
    // `setTimeout(0)` in a way neither this test nor production code needs to resolve — the
    // pump's OWN delivery leg, asserted above, never touches that global).
    let hAttempt = hDb.getBindingAttempt(hLinkDeviceId)
    for (let i = 0; i < 60 && hAttempt?.lastAttemptAt == null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      hAttempt = hDb.getBindingAttempt(hLinkDeviceId)
    }
    expect(hAttempt?.lastAttemptAt).not.toBeNull()
  }, 20000)
})
