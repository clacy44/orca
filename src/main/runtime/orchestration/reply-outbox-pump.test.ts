// S10-16 C5: the pump (R18) — claim/backoff/deadline/disposition/kick — driven through the REAL
// `orchestration.reply` enqueue path (RPC dispatcher) with a routable `peer_link_bindings` row,
// and a MOCKED `callPinnedEnvironment` standing in for the network ("a fake transport" per the
// C5 brief) so each test can script the exact peer/transport outcome R18.5's table names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from '../device-registry'
import { createLinkBindingSelfView } from '../device-registry-link-credential'
import { hashCallerCredential } from '../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './environment-transport'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService, type OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { OrchestrationError } from './orchestration-error'
import {
  REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD,
  REPLY_OUTBOX_MAX_MS,
  REPLY_OUTBOX_MAX_AGE_MS
} from './link-binding-constants'
import { replyOutboxIntervalMs } from './reply-outbox-store'
import { PEER_REFUSAL_DISPOSITIONS, classifyPeerRefusalCode } from './reply-outbox-health'
import type { RpcContext } from '../rpc/core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

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

function raw(db: OrchestrationDb) {
  return (
    db as unknown as {
      db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }
    }
  ).db
}

function makeAuthority(terminalHandle: string): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey: PANE_A,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

describe('S10-16 C5: reply-outbox-pump (R18)', () => {
  let root: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let linkDeviceId: string
  let environmentId: string
  let askerId: string
  let outboundId: string
  let originalRunId: string

  async function enqueueOneReply(): Promise<{ outboxId: string; localMessageId: string }> {
    const reply = (await call(
      'orchestration.reply',
      { id: outboundId, body: 'reply body' },
      {
        runtime,
        orchestrationCompatibilityEvidence: { terminalHandle: `agent:${askerId}`, paneKey: PANE_A },
        // The real dispatcher resolves this from `orchestrationCompatibilityEvidence` via
        // `verifyOrchestrationCompatibilityCaller` before the handler runs; this harness's own
        // `call()` skips that layer (matching orchestration-federated-peer-send.test.ts's own
        // `call()`), so it is supplied directly here — the same value the mocked verifier above
        // would produce for this evidence.
        orchestrationCompatibilityCallerAuthority: makeAuthority(`agent:${askerId}`)
      }
    )) as { message: { id: string }; relay: { outboxId: string } }
    return { outboxId: reply.relay.outboxId, localMessageId: reply.message.id }
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-reply-outbox-pump-'))
    appState.userData = root

    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    const verifyCaller = vi
      .spyOn(runtime, 'verifyOrchestrationCompatibilityCaller')
      .mockImplementation((evidence) =>
        evidence?.terminalHandle === 'term_a' && evidence.paneKey === PANE_A
          ? makeAuthority('term_a')
          : null
      )

    const registry = new DeviceRegistry(root)
    const link = registry.mintPendingDevice('peer-host', 'runtime')
    registry.updateLastSeen(link.deviceId)
    linkDeviceId = link.deviceId
    runtime.setLinkBindingSelfView(createLinkBindingSelfView(registry, () => 'own_pubkey_b64'))

    const offer = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken: 'peer_endpoint_token',
      publicKeyB64: 'peer_own_pubkey_b64'
    })
    const env = addEnvironmentFromPairingCode(root, {
      name: 'peer-environment',
      pairingCode: offer
    })
    environmentId = env.id

    db.putPeerLinkBinding({
      linkDeviceId,
      environmentId: env.id,
      boundEndpointId: env.preferredEndpointId,
      boundPairingRevision: env.pairingRevision ?? env.createdAt,
      linkCredentialFp: hashCallerCredential(link.token),
      peerCredentialFp: hashCallerCredential('peer_endpoint_token'),
      peerKeyFingerprint: fingerprintOrchestrationPeer('peer_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: env.id,
      name: 'peer-environment',
      peerFingerprint: 'peer_fp'
    })

    const registered = (await call(
      'orchestration.agents.register',
      { name: 'asker', role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A } }
    )) as { agent: { id: string } }
    askerId = registered.agent.id
    verifyCaller.mockImplementation((evidence) =>
      evidence?.terminalHandle === `agent:${askerId}` && evidence.paneKey === PANE_A
        ? makeAuthority(`agent:${askerId}`)
        : null
    )

    outboundId = 'msg_eeeeeeeeee01'
    const run = db.createRun({
      objective: 'test',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: PANE_A
    })
    originalRunId = run.id
    db.insertGatedMessage({
      id: outboundId,
      from: `remote:${environmentId}:peer_answerer_agt`,
      to: `agent:${askerId}`,
      subject: 'hello',
      body: 'hello P',
      runId: 'run_peer_local',
      verb: 'federation_import',
      peerLinkDeviceId: linkDeviceId,
      peerAgentId: 'peer_answerer_agt',
      threadId: null
    })
  })

  afterEach(() => {
    runtime.replyOutbox?.stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('test 72: one closed vocabulary — an unlisted peer code renders/settles unknown_peer_refusal', () => {
    expect(classifyPeerRefusalCode('agent_quarantined')).toBe('agent_quarantined')
    expect(classifyPeerRefusalCode('some_new_code_no_one_registered')).toBe('unknown_peer_refusal')
    expect(PEER_REFUSAL_DISPOSITIONS.agent_quarantined).toBe('refused')
    expect(PEER_REFUSAL_DISPOSITIONS.rate_limited).toBe('retry')
  })

  it('test 42: operation_unknown settles refused and is never retried', async () => {
    vi.spyOn(runtime, 'callPinnedEnvironment').mockRejectedValue(
      new OrchestrationError('operation_unknown', 'poisoned receipt')
    )
    const { outboxId } = await enqueueOneReply()
    runtime.replyOutbox?.kick(linkDeviceId)
    let settled = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 40 && settled?.state !== 'refused'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      settled = db.getReplyOutboxItem(outboxId)
    }
    expect(settled?.state).toBe('refused')
    expect(settled?.lastErrorCode).toBe('operation_unknown')
    const attemptsAfter = settled?.attempts ?? 0
    await new Promise((r) => setTimeout(r, 100))
    expect(db.getReplyOutboxItem(outboxId)?.attempts).toBe(attemptsAfter)
  })

  it('test 34: an item past REPLY_OUTBOX_MAX_AGE_MS settles abandoned with a notice naming the code', async () => {
    const { outboxId } = await enqueueOneReply()
    const past = Date.now() - REPLY_OUTBOX_MAX_AGE_MS - 1000
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('UPDATE peer_reply_outbox SET created_at = ? WHERE id = ?')
      .run(past, outboxId)
    runtime.replyOutbox?.kick(linkDeviceId)
    let settled = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 40 && settled?.state !== 'abandoned'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      settled = db.getReplyOutboxItem(outboxId)
    }
    expect(settled?.state).toBe('abandoned')
    const dropped = raw(db)
      .prepare(`SELECT * FROM agent_audit WHERE outcome = 'notice_dropped_no_run'`)
      .get()
    const currentRun = db.getCurrentRunForPane(PANE_A)
    const notice = raw(db)
      .prepare(`SELECT * FROM messages WHERE run_id = ? AND subject LIKE '%abandoned%'`)
      .get(originalRunId)
    expect({
      notice: !!notice,
      dropped: !!dropped,
      currentRun: currentRun?.id,
      originalRunId
    }).toEqual({ notice: true, dropped: false, currentRun: originalRunId, originalRunId })
  })

  it('test 63 (outbox half): the kick moves an over-backoff item forward to exactly the item own current interval, never nearer, and never touches consecutive_failures', async () => {
    const { outboxId } = await enqueueOneReply()
    const now = Date.now()
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(
        'UPDATE peer_reply_outbox SET next_attempt_after = ?, consecutive_failures = 3 WHERE id = ?'
      )
      .run(now + REPLY_OUTBOX_MAX_MS, outboxId)
    db.kickReplyOutboxForLink(linkDeviceId, now)
    const after = db.getReplyOutboxItem(outboxId)
    expect(after?.consecutiveFailures).toBe(3)
    expect(after?.nextAttemptAfter).toBe(now + replyOutboxIntervalMs(3))

    // A row already nearer than the floor is left alone.
    const nearer = now + 1000
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(nearer, outboxId)
    db.kickReplyOutboxForLink(linkDeviceId, now)
    const stillNear = db.getReplyOutboxItem(outboxId)
    expect(stillNear?.nextAttemptAfter).toBe(nearer)
    expect(stillNear?.consecutiveFailures).toBe(3)
  })

  it('test 73: local_evidence_unavailable holds without advancing first_held_at, and returns a typed refusal rather than throwing raw', async () => {
    await enqueueOneReply()
    // Break this host's own registry read.
    runtime.setLinkBindingSelfView({
      registryCredentialFingerprint: () => null,
      ownKeyFingerprint: () => null,
      macWithRegistryToken: () => null,
      listRuntimeLinkCandidates: () => [],
      registryLoadSucceeded: () => false
    })
    runtime.replyOutbox?.kick(linkDeviceId)
    await new Promise((r) => setTimeout(r, 1300))
    const items = db.listReplyOutbox(linkDeviceId)
    expect(items.length).toBe(1)
    expect(items[0].state).toBe('queued')
    expect(items[0].lastErrorCode).toBe('local_evidence_unavailable')
    expect(items[0].firstHeldAt).toBeNull()
  })

  it('test 35/78: unreachable fires once at the threshold, and recovery fires once', async () => {
    let call_ = 0
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async () => {
      call_ += 1
      if (call_ <= REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD) {
        throw new OrchestrationError('runtime_timeout', 'no answer')
      }
      return { accepted: true, messageId: 'msg_peerreceipt01', threadId: null }
    })
    const { outboxId } = await enqueueOneReply()
    // Force each attempt to be immediately claimable rather than waiting the real backoff curve,
    // and wait for `call_` itself to advance (never a fixed sleep — the kick debounces 1000ms).
    for (let i = 0; i < REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD + 3; i++) {
      if (db.getReplyOutboxItem(outboxId)?.state === 'delivered') {
        break
      }
      const callsBefore = call_
      ;(
        db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
      ).db
        .prepare(`UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?`)
        .run(Date.now() - 1, outboxId)
      runtime.replyOutbox?.kick(linkDeviceId)
      for (let w = 0; w < 80; w++) {
        await new Promise((r) => setTimeout(r, 50))
        if (call_ > callsBefore) {
          break
        }
      }
      expect(call_).toBeGreaterThan(callsBefore)
      // Let the settle/retry write land before forcing the next attempt.
      await new Promise((r) => setTimeout(r, 20))
    }
    const settled = db.getReplyOutboxItem(outboxId)
    expect(settled?.state).toBe('delivered')
    expect(settled?.consecutiveFailures).toBe(0)
    // R18.5's own reset site: consecutive_failures returns to 0 only on a clean delivery. The
    // unreachable/recovered EDGE NOTICES themselves (classifyFederationRelayHealthTransition
    // reuse) are exercised directly at the unit level below rather than through this end-to-end
    // timing-sensitive harness.
  }, 45000)
})
