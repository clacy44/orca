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
import {
  addEnvironmentFromPairingCode,
  updateEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService, type OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { OrchestrationError } from './orchestration-error'
import {
  REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD,
  REPLY_OUTBOX_MAX_MS,
  REPLY_OUTBOX_MAX_AGE_MS,
  REPLY_OUTBOX_HOLD_MAX_MS
} from './link-binding-constants'
import { replyOutboxIntervalMs } from './reply-outbox-store'
import { PEER_REFUSAL_DISPOSITIONS, classifyPeerRefusalCode } from './reply-outbox-health'
import { classifyReplyRelayError } from './reply-outbox-pump-disposition'
import {
  recordReplyOutboxFailureAndMaybeNotify,
  onReplyOutboxDelivered
} from './reply-outbox-pump-notify'
import { holdOrRetargetReplyOutboxItem } from './reply-outbox-pump-hold'
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
    db as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } } }
  ).db
}

function makeAuthority(
  terminalHandle: string,
  paneKey: string = PANE_A
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

describe('S10-16 C5: reply-outbox-pump (R18)', () => {
  let root: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let registry: DeviceRegistry
  let linkDeviceId: string
  let environmentId: string
  let environmentEndpointId: string
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
    // Ruling 26 Addendum 3(bb)/F1: setOrchestrationDb arms linkBindingProver (S10-16 C4a, R13 —
    // "arm() runs at every DB attach"), which shares this test's mocked `callPinnedEnvironment`
    // with the reply-outbox pump. Left armed, its LINK_BINDING_STARTUP_DELAY_MS-delayed first
    // round fires mid-test-35/78 (a ~45s-budgeted run) and steals one of the scripted mock
    // responses meant for the pump's own retry sequence — the harness defect the exact-once
    // assertion this ruling adds would otherwise intermittently trip on, unrelated to the pump's
    // own correctness. Disarmed here, matching orca-runtime.test.ts's own established pattern.
    runtime.getLinkBindingProver().disarm()
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    const verifyCaller = vi
      .spyOn(runtime, 'verifyOrchestrationCompatibilityCaller')
      .mockImplementation((evidence) =>
        evidence?.terminalHandle === 'term_a' && evidence.paneKey === PANE_A
          ? makeAuthority('term_a')
          : null
      )

    registry = new DeviceRegistry(root)
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
    environmentEndpointId = env.preferredEndpointId

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
      .prepare(`SELECT * FROM agent_audit WHERE outcome = 'notice_surfaced_via_check'`)
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
      listRuntimeScopeDeviceIds: () => [],
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

  it('test 35/78: an outage that exceeds the threshold still delivers, resetting consecutive_failures to 0', async () => {
    let call_ = 0
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async () => {
      call_ += 1
      if (call_ <= REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD) {
        throw new OrchestrationError('runtime_timeout', 'no answer')
      }
      return { accepted: true, messageId: 'msg_peerreceipt01', threadId: null }
    })
    const { outboxId } = await enqueueOneReply()
    // Ruling 26 Addendum 1(w): re-aimed at the ROW's own consecutive_failures, never the mock's
    // call count (a count of mock ENTRIES, not of persisted attempts — the C5b review's answer
    // (i) traced the harness's flakiness to exactly this). The force-write is guarded
    // `AND state = 'queued'` and only issued once the row has actually settled back to 'queued'
    // — never concurrently with an in-flight 'sending' row, which is the race the review found
    // (a force-write landing between the pump's own retryReplyOutboxItem and the next claim).
    for (let i = 0; i < REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD + 3; i++) {
      if (db.getReplyOutboxItem(outboxId)?.state === 'delivered') {
        break
      }
      for (let w = 0; w < 100 && db.getReplyOutboxItem(outboxId)?.state !== 'queued'; w++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      const failuresBefore = db.getReplyOutboxItem(outboxId)?.consecutiveFailures ?? 0
      ;(
        db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
      ).db
        .prepare(
          `UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ? AND state = 'queued'`
        )
        .run(Date.now() - 1, outboxId)
      runtime.replyOutbox?.kick(linkDeviceId)
      for (let w = 0; w < 100; w++) {
        await new Promise((r) => setTimeout(r, 50))
        const row = db.getReplyOutboxItem(outboxId)
        if (row?.state === 'delivered' || (row?.consecutiveFailures ?? 0) > failuresBefore) {
          break
        }
      }
    }
    const settled = db.getReplyOutboxItem(outboxId)
    expect(settled?.state).toBe('delivered')
    expect(settled?.consecutiveFailures).toBe(0)
    expect(call_).toBeGreaterThan(REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD)
    // Ruling 26 Addendum 3(bb): the end-to-end exact-once assertion is mandatory here, not only
    // in the direct-call unit test below — count the unreachable/recovered mailbox rows this
    // exact timer-driven run produced and assert exactly one of each.
    const unreachableCount = (
      raw(db)
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%unreachable%'`
        )
        .get(originalRunId) as { n: number }
    ).n
    const recoveredCount = (
      raw(db)
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%recovered%'`
        )
        .get(originalRunId) as { n: number }
    ).n
    expect(unreachableCount).toBe(1)
    expect(recoveredCount).toBe(1)
  }, 45000)

  it('Ruling 26 Addendum 1(n)/F1: a same-route runtime_environment_changed re-check is not a retarget — bounded hold, never released with a NULL schedule', async () => {
    const { outboxId } = await enqueueOneReply()
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)

    const now = Date.now()
    // The ONLY routable binding for this peer key fingerprint IS the row's own current route
    // (beforeEach set up exactly one peer_link_bindings row) — findBindingCandidateByKeyFingerprint
    // resolves to the SAME route, which used to be treated as a retarget onto itself.
    holdOrRetargetReplyOutboxItem(runtime, claimed!, now)

    const after = db.getReplyOutboxItem(outboxId)
    // Route identity unchanged, and — the F1 defect — NOT released with next_attempt_after=NULL
    // (which would make it immediately re-claimable, the unbounded dial loop). It is a bounded
    // hold: queued, with a real schedule and firstHeldAt started.
    expect(after?.linkDeviceId).toBe(linkDeviceId)
    expect(after?.boundPairingRevision).toBe(claimed!.boundPairingRevision)
    expect(after?.state).toBe('queued')
    // Ruling 26 Addendum 5(mm): the same-route hold carries the peer's ACTUAL disposition
    // (runtime_environment_changed) — never binding_changed, which would be false here (the
    // route genuinely has not changed).
    expect(after?.lastErrorCode).toBe('runtime_environment_changed')
    expect(after?.nextAttemptAfter).not.toBeNull()
    expect(after?.nextAttemptAfter as number).toBeGreaterThan(now)
    expect(after?.firstHeldAt).not.toBeNull()
    expect(after?.consecutiveFailures).toBe(0)

    // A second same-route re-check (the row reclaimed once its hold expires) must stay bounded:
    // it does not advance firstHeldAt (the route_moved clock keeps counting from the FIRST hold,
    // per Ruling 26(c)) and it still schedules a real, non-null next attempt rather than looping.
    const firstHeldAt = after!.firstHeldAt
    const reclaimed = db.claimNextReplyOutboxItem(after!.nextAttemptAfter! + 1)
    expect(reclaimed?.id).toBe(outboxId)
    holdOrRetargetReplyOutboxItem(runtime, reclaimed!, after!.nextAttemptAfter! + 1)
    const afterSecond = db.getReplyOutboxItem(outboxId)
    expect(afterSecond?.firstHeldAt).toBe(firstHeldAt)
    expect(afterSecond?.nextAttemptAfter).not.toBeNull()
    expect(afterSecond?.state).toBe('queued')
  })

  it('Ruling 26 Addendum 3(aa)/F2/F8: reply_relay_stale_pairing is edge-triggered on last_notified_condition (never last_error_code) — fires once across repeated retries AND across an intervening hold, and consecutive_failures still bumps each time', async () => {
    vi.spyOn(runtime, 'callPinnedEnvironment').mockRejectedValue(
      new OrchestrationError('stale_environment_pairing', 'pairing stale')
    )
    const { outboxId } = await enqueueOneReply()
    const countNotices = (): number =>
      (
        raw(db)
          .prepare(
            `SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%fresh pairing%'`
          )
          .get(originalRunId) as { n: number }
      ).n

    // First attempt: crosses INTO stale_environment_pairing from a NULL last_notified_condition
    // — fires once, and (Ruling 26 Addendum 1(u)/F8) bumps consecutive_failures — R18.5 exempts
    // only runtime_environment_changed and the two local-scheduling rows, not this one.
    runtime.replyOutbox?.kick(linkDeviceId)
    let item = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 80 && (item?.consecutiveFailures ?? 0) < 1; i++) {
      await new Promise((r) => setTimeout(r, 50))
      item = db.getReplyOutboxItem(outboxId)
    }
    expect(item?.lastErrorCode).toBe('stale_environment_pairing')
    expect(item?.lastNotifiedCondition).toBe('reply_relay_stale_pairing')
    expect(item?.consecutiveFailures).toBe(1)
    expect(countNotices()).toBe(1)

    // Retry with the SAME disposition: the counter still bumps, but the notice must NOT re-fire
    // — it is edge-triggered on the transition, not level-triggered on every attempt.
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?`)
      .run(Date.now() - 1, outboxId)
    runtime.replyOutbox?.kick(linkDeviceId)
    for (
      let i = 0;
      i < 80 && (db.getReplyOutboxItem(outboxId)?.consecutiveFailures ?? 0) < 2;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50))
    }
    item = db.getReplyOutboxItem(outboxId)
    expect(item?.consecutiveFailures).toBe(2)
    expect(item?.lastErrorCode).toBe('stale_environment_pairing')
    expect(countNotices()).toBe(1)

    // F2's actual defect: an INTERVENING hold rewrites last_error_code (to binding_changed) but
    // must NEVER touch last_notified_condition — the notice choke is its only writer. Simulate
    // the hold directly (same statement holdOrRetargetReplyOutboxItem's fall-through calls), then
    // let one more stale-pairing retry land: the edge must still not re-fire, because
    // last_notified_condition is untouched by the hold.
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?`)
      .run(Date.now() - 1, outboxId)
    const claimedForHold = db.claimNextReplyOutboxItem(Date.now())
    expect(claimedForHold?.id).toBe(outboxId)
    const heldOk = db.holdReplyOutboxItem(
      outboxId,
      Date.now(),
      Date.now() + 1000,
      'binding_changed'
    )
    expect(heldOk).toBe(true)
    const afterHold = db.getReplyOutboxItem(outboxId)
    expect(afterHold?.lastErrorCode).toBe('binding_changed')
    expect(afterHold?.lastNotifiedCondition).toBe('reply_relay_stale_pairing')
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?`)
      .run(Date.now() - 1, outboxId)
    runtime.replyOutbox?.kick(linkDeviceId)
    for (
      let i = 0;
      i < 80 && (db.getReplyOutboxItem(outboxId)?.consecutiveFailures ?? 0) < 3;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50))
    }
    item = db.getReplyOutboxItem(outboxId)
    expect(item?.consecutiveFailures).toBe(3)
    expect(item?.lastErrorCode).toBe('stale_environment_pairing')
    expect(countNotices()).toBe(1)

    // Restart-shaped: the edge decision is a pure function of the row's PERSISTED
    // last_notified_condition — no in-memory Map exists that must survive a restart to skip a
    // re-fire. A fresh classification call, given the item's own current
    // lastNotifiedCondition, reproduces the same non-firing decision deterministically.
    const disposition = classifyReplyRelayError(
      new OrchestrationError('stale_environment_pairing', 'still stale'),
      item!.consecutiveFailures,
      Date.now()
    )
    expect(disposition.kind).toBe('retry')
    expect(
      disposition.kind === 'retry' && disposition.noticeCode
        ? item!.lastNotifiedCondition !== disposition.noticeCode
        : true
    ).toBe(false)
  })

  it('M13/Ruling 26(l): a kick landing while a tick is already running is not dropped — the item still reaches delivered', async () => {
    const gate: { resolve: (() => void) | undefined } = { resolve: undefined }
    let calls = 0
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        // Hold the FIRST dial open so the tick is still `loopRunning` when the second kick's
        // debounced call lands — the exact window M13's rerun flag exists for.
        await new Promise<void>((resolve) => {
          gate.resolve = resolve
        })
      }
      return { accepted: true, messageId: 'msg_peerreceipt02', threadId: null }
    })
    const { outboxId } = await enqueueOneReply()
    runtime.replyOutbox?.kick(linkDeviceId)
    // Wait for the pump to actually enter the held-open first dial.
    for (let i = 0; i < 80 && calls < 1; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(calls).toBe(1)
    // A second kick while the tick is running: without M13's rerun flag this call is either a
    // silent no-op (the guard at the top of runTickLoop returns early) or — if the debounce
    // timer is still armed — later gets cleared by a subsequent kick with no memory that this
    // one ever arrived.
    runtime.replyOutbox?.kick(linkDeviceId)
    await new Promise((r) => setTimeout(r, 50))
    gate.resolve?.()
    let settled = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 80 && settled?.state !== 'delivered'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      settled = db.getReplyOutboxItem(outboxId)
    }
    expect(settled?.state).toBe('delivered')
  })

  // H5/Ruling 26(f): the notice-count assertion the C5 review found removed. Restored here as a
  // DIRECT, deterministic exercise of recordReplyOutboxFailureAndMaybeNotify/onReplyOutboxDelivered
  // against real rows through the real DB/notice-write path — no pump, no timers, no backoff —
  // which is what proves the edge is driven ONLY from the row passed in (never an in-memory Map):
  // two independent calls with the same row shape behave identically regardless of call order or
  // process history, which is exactly what "survives a restart" means for a function with no
  // memory of its own.
  it('Ruling 26(f): reply_relay_unreachable fires exactly once at the crossing and never again while still unreachable; reply_relay_recovered fires exactly once and never for a healthy delivery', async () => {
    const { outboxId } = await enqueueOneReply()
    const baseItem = db.getReplyOutboxItem(outboxId)
    if (!baseItem) {
      throw new Error('test setup: outbox item missing')
    }
    const countBySubject = (needle: string): number =>
      (
        raw(db)
          .prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE ?`)
          .get(originalRunId, `%${needle}%`) as { n: number }
      ).n

    // previous = THRESHOLD - 1, next = THRESHOLD: the crossing. Fires once.
    recordReplyOutboxFailureAndMaybeNotify(
      runtime,
      { ...baseItem, consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD - 1 },
      REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
    )
    expect(countBySubject('unreachable')).toBe(1)

    // previous = THRESHOLD, next = THRESHOLD + 1: still unreachable, already past the crossing —
    // must NOT re-fire (this is exactly the per-item overwrite the old Map-keyed version got
    // wrong when two items shared one link).
    recordReplyOutboxFailureAndMaybeNotify(
      runtime,
      { ...baseItem, consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD },
      REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD + 1
    )
    expect(countBySubject('unreachable')).toBe(1)

    // A delivery whose PRE-SETTLE row was at/above the threshold: recovered fires once.
    onReplyOutboxDelivered(runtime, {
      ...baseItem,
      consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD + 1
    })
    expect(countBySubject('recovered')).toBe(1)

    // A delivery whose pre-settle row was never unreachable: no recovered notice (never a
    // healthy link discovering an outage it never had).
    onReplyOutboxDelivered(runtime, { ...baseItem, consecutiveFailures: 2 })
    expect(countBySubject('recovered')).toBe(1)

    // Ruling 26(f)'s restart claim, made concrete: these two calls carry NO state of their own
    // (no Map argument exists any more) — a brand-new closure (as a restart would produce) calling
    // them with the SAME row values produces the SAME result, which is what "the edge survives a
    // restart" means for a stateless function.
    recordReplyOutboxFailureAndMaybeNotify(
      runtime,
      { ...baseItem, consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD - 1 },
      REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
    )
    expect(countBySubject('unreachable')).toBe(2)
  })

  it('Ruling 26(j)/M10: holdReplyOutboxItemCollision never advances first_held_at and writes the register code, never `""` (direct, no timers)', async () => {
    // Direct exercise of holdReplyOutboxItemCollision (reply-outbox-lifecycle.ts) — the pump's
    // 'busy' branch calls exactly this, and only this, on an in-flight-guard collision. A real
    // end-to-end collision additionally requires two DIFFERENT routes sharing one in-flight-guard
    // key (M10's own fix: keyed per link+environment, not per environment alone) to race inside
    // one tick — a timing shape this harness cannot force deterministically; the state transition
    // this hold performs is exactly what's under test here.
    const { outboxId } = await enqueueOneReply()
    // Put the row into 'sending' the way the pump would (a real claim), then apply the collision
    // hold directly — same call the pump's 'busy' branch makes.
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)
    const now = Date.now()
    // Ruling 26 Addendum 3(dd)/F4: the write's boolean is returned and checked.
    expect(db.holdReplyOutboxItemCollision(outboxId, now + 30_000)).toBe(true)
    const held = db.getReplyOutboxItem(outboxId)
    expect(held?.state).toBe('queued')
    expect(held?.lastErrorCode).toBe('relay_dial_collision')
    expect(held?.firstHeldAt).toBeNull()
    expect(held?.consecutiveFailures).toBe(0)
    expect(held?.holdCount).toBe(1)
    expect(held?.nextAttemptAfter).toBe(now + 30_000)

    // A SECOND collision hold still must not start the clock.
    const reclaimed = db.claimNextReplyOutboxItem(now + 30_001)
    expect(reclaimed?.id).toBe(outboxId)
    db.holdReplyOutboxItemCollision(outboxId, now + 60_000)
    const heldAgain = db.getReplyOutboxItem(outboxId)
    expect(heldAgain?.firstHeldAt).toBeNull()
    expect(heldAgain?.holdCount).toBe(2)
  })

  it('Ruling 26(h)/M7: a reply refused at the outbox capacity leaves NO row — never relay_pending forever', async () => {
    for (let i = 0; i < 256; i++) {
      db.enqueueReplyOutbox({
        localMessageId: `msg_cap_fill_${i.toString().padStart(6, '0')}`,
        linkDeviceId,
        environmentId,
        boundPairingRevision: 1,
        peerCredentialFp: 'fp',
        peerKeyFingerprint: 'kfp',
        inReplyToMessageId: outboundId,
        peerAgentId: 'peer_answerer_agt',
        peerThreadId: null,
        localThreadId: null,
        noticeRunId: null,
        noticePaneKey: null,
        payload: '{}',
        byteCount: 2,
        createdAt: Date.now()
      })
    }
    await expect(enqueueOneReply()).rejects.toMatchObject({ code: 'link_binding_conflict' })
    // No orphaned local message row for the refused reply.
    const rows = raw(db)
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE peer_link_device_id IS NULL AND to_handle LIKE ?`
      )
      .get(`remote:${environmentId}:%`) as { n: number }
    expect(rows.n).toBe(0)
  })

  it('Ruling 26(b)/R18.4(b): a successful retarget re-points and releases in ONE statement — never re-held', async () => {
    const { outboxId } = await enqueueOneReply()
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)
    expect(claimed?.state).toBe('sending')

    // A second, routable binding sharing the SAME peer key fingerprint — the re-pair shape
    // findBindingCandidateByKeyFingerprint matches on. Ruling 26 Addendum 5(nn)/F2: the
    // candidate must pass the FULL routable predicate (getRoutableLinkBinding), not just the
    // raw SQL clauses — so it needs a REAL registered device (registryLinkCredentialFingerprint)
    // and pins that match the environment's actual current endpoint (resolveEnvironmentEndpoint),
    // exactly like the beforeEach's own binding does.
    const retargetedLink = registry.mintPendingDevice('peer-host-2', 'runtime')
    registry.updateLastSeen(retargetedLink.deviceId)
    const retargetedLinkId = retargetedLink.deviceId
    db.putPeerLinkBinding({
      linkDeviceId: retargetedLinkId,
      environmentId,
      boundEndpointId: environmentEndpointId,
      boundPairingRevision: claimed!.boundPairingRevision,
      linkCredentialFp: hashCallerCredential(retargetedLink.token),
      peerCredentialFp: claimed!.peerCredentialFp,
      peerKeyFingerprint: fingerprintOrchestrationPeer('peer_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })

    holdOrRetargetReplyOutboxItem(runtime, claimed!, Date.now())

    const after = db.getReplyOutboxItem(outboxId)
    expect(after?.linkDeviceId).toBe(retargetedLinkId)
    expect(after?.boundPairingRevision).toBe(claimed!.boundPairingRevision)
    expect(after?.state).toBe('queued')
    // Ruling 26(b): released, never re-held — the hold fields all reset, not advanced.
    expect(after?.holdCount).toBe(0)
    expect(after?.firstHeldAt).toBeNull()
    expect(after?.nextAttemptAfter).toBeNull()
  })

  // Ruling 26 Addendum 6(tt)/R18.4(b)/PART 7 Step 2: pairing-revision-bump re-pair — SAME
  // device, NEW pairing revision — retargets from the freshly-read routable row.
  it('a pairing-revision-bump re-pair retargets onto the same device with the new pins', async () => {
    const { outboxId } = await enqueueOneReply()
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)
    expect(claimed?.state).toBe('sending')
    // `orca environment update`: same env/endpoint id, bumped pairingRevision, rotated token —
    // peerKeyFingerprint (the candidate match key) stays put; the rest genuinely differ, unlike
    // the synthetic fixtures F4 flagged.
    const rotatedOffer = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken: 'peer_endpoint_token_v2',
      publicKeyB64: 'peer_own_pubkey_b64'
    })
    const updatedEnv = updateEnvironmentFromPairingCode(root, 'peer-environment', {
      pairingCode: rotatedOffer
    })
    const updatedPairingRevision = updatedEnv.pairingRevision ?? updatedEnv.createdAt
    // Re-pair the SAME device (linkDeviceId unchanged) against the new pins.
    db.putPeerLinkBinding({
      ...db.getPeerLinkBinding(linkDeviceId)!,
      boundEndpointId: updatedEnv.preferredEndpointId,
      boundPairingRevision: updatedPairingRevision,
      peerCredentialFp: hashCallerCredential('peer_endpoint_token_v2')
    })
    holdOrRetargetReplyOutboxItem(runtime, claimed!, Date.now())
    const after = db.getReplyOutboxItem(outboxId)
    // Same device — the retarget re-points onto the SAME linkDeviceId with the NEW pins.
    expect(after?.linkDeviceId).toBe(linkDeviceId)
    expect(after?.boundPairingRevision).toBe(updatedPairingRevision)
    expect(after?.boundPairingRevision).not.toBe(claimed!.boundPairingRevision)
    expect(after?.state).toBe('queued')
    expect(after?.holdCount).toBe(0)
    expect(after?.firstHeldAt).toBeNull()
    expect(after?.nextAttemptAfter).toBeNull()
  })

  it('Ruling 26 Addendum 5(nn)/C5e review F2: a quarantined candidate sharing the peer key fingerprint is never retargeted onto — the row holds with the existing hold code', async () => {
    const { outboxId } = await enqueueOneReply()
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)
    expect(claimed?.state).toBe('sending')

    // A second, `confirmed`/unrevoked binding sharing the SAME peer key fingerprint — passes the
    // raw SQL candidate lookup's two clauses — but under an active quarantine containment row.
    // R15/R16.2: a quarantined link must never become a routing destination in either direction.
    const quarantinedLinkId = 'quarantined-link-device'
    db.putPeerLinkBinding({
      linkDeviceId: quarantinedLinkId,
      environmentId,
      boundEndpointId: 'quarantined-endpoint',
      boundPairingRevision: 999,
      linkCredentialFp: 'quarantined-link-credential-fp',
      peerCredentialFp: 'quarantined-peer-credential-fp',
      peerKeyFingerprint: fingerprintOrchestrationPeer('peer_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    db.putContainment({
      subjectKind: 'link',
      subjectId: quarantinedLinkId,
      action: 'quarantine',
      reasonCode: 'test_quarantine',
      reasonText: null,
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })

    holdOrRetargetReplyOutboxItem(runtime, claimed!, Date.now())

    // Never retargeted: the row still names its ORIGINAL link — no destination record (R16.2)
    // is ever written naming the quarantined link.
    const after = db.getReplyOutboxItem(outboxId)
    expect(after?.linkDeviceId).toBe(linkDeviceId)
    expect(after?.state).toBe('queued')
    // The existing hold code — a quarantined candidate reads as "no routable binding", so this
    // is the ordinary !isSameRoute hold, not the same-route (mm) path.
    expect(after?.lastErrorCode).toBe('binding_changed')
    const retargetAudit = raw(db)
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'replyRelayRetarget' AND outcome LIKE ?`
      )
      .get(`%to:${quarantinedLinkId}%`) as { n: number }
    expect(retargetAudit.n).toBe(0)
  })

  it('Ruling 26(c)/B2: route_moved settles from `sending`, its deadline read from firstHeldAt BEFORE any hold write, and the notice fires only when the settle wrote a row', async () => {
    const { outboxId } = await enqueueOneReply()
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)

    // No routable binding at all for this peer key — findBindingCandidateByKeyFingerprint finds
    // nothing, and localEvidenceUnavailable is false (the registry/environment store both read
    // fine), so the deadline check is reached.
    db.revokePeerLinkBinding(linkDeviceId, Date.now())

    const now = Date.now()
    const pastDeadline = now - REPLY_OUTBOX_HOLD_MAX_MS - 1000
    // B2's own bug reproduced-and-fixed: firstHeldAt is read from the ITEM PASSED IN (as it was
    // at claim time), not re-read after a hold write that would have just reset it to `now`.
    holdOrRetargetReplyOutboxItem(runtime, { ...claimed!, firstHeldAt: pastDeadline }, now)

    const after = db.getReplyOutboxItem(outboxId)
    expect(after?.state).toBe('refused')
    expect(after?.lastErrorCode).toBe('route_moved')
    const notice = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%route%'`)
      .get(originalRunId) as { n: number }
    expect(notice.n).toBe(1)
  })

  it('Ruling 26 Addendum 5(mm): a same-route hold carries the honest runtime_environment_changed code while held, never binding_changed, and settles abandoned at REPLY_OUTBOX_HOLD_MAX_MS — not the 7-day age deadline', async () => {
    const { outboxId } = await enqueueOneReply()
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)

    // The ONLY routable binding for this peer key fingerprint IS the row's own current route
    // (beforeEach's single peer_link_bindings row is untouched) — isSameRoute resolves true,
    // exactly the F1/(n) fall-through shape, not the (c)/B2 "no binding at all" shape above.
    const firstTick = Date.now()
    holdOrRetargetReplyOutboxItem(runtime, claimed!, firstTick)

    // (mm): while held, last_error_code is the peer-returned disposition
    // (runtime_environment_changed) — never binding_changed, which is false when the route has
    // not moved. No counter bump: a peer-chosen disposition is never unreachable evidence.
    const held = db.getReplyOutboxItem(outboxId)
    expect(held?.state).toBe('queued')
    expect(held?.lastErrorCode).toBe('runtime_environment_changed')
    expect(held?.consecutiveFailures).toBe(0)

    // Force the hold's next_attempt_after into the past to re-claim, exactly like every other
    // test here that needs a held row reclaimed sooner than its real schedule — first_held_at
    // (COALESCEd on the first hold write) survives the reclaim untouched (Ruling 26(a)).
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(Date.now() - 1, outboxId)
    const reclaimed = db.claimNextReplyOutboxItem(Date.now())
    expect(reclaimed?.id).toBe(outboxId)
    expect(reclaimed?.firstHeldAt).toBe(firstTick)

    // Re-check again, past REPLY_OUTBOX_HOLD_MAX_MS from first-held-at — same isSameRoute shape.
    const now = firstTick + REPLY_OUTBOX_HOLD_MAX_MS + 1000
    holdOrRetargetReplyOutboxItem(runtime, reclaimed!, now)

    // (mm): settles abandoned with the existing reply_relay_abandoned code/notice — no
    // register change, no binding_changed, no route_moved, no reply_relay_refused — inside the
    // hold window instead of waiting REPLY_OUTBOX_MAX_AGE_MS (7 days).
    const settled = db.getReplyOutboxItem(outboxId)
    expect(settled?.state).toBe('abandoned')
    expect(settled?.lastErrorCode).toBe('runtime_environment_changed')
    expect(settled?.consecutiveFailures).toBe(0)
    const routeMovedNotice = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%route%'`)
      .get(originalRunId) as { n: number }
    expect(routeMovedNotice.n).toBe(0)
    const refusedNotice = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%refused%'`)
      .get(originalRunId) as { n: number }
    expect(refusedNotice.n).toBe(0)
    const abandonedNotice = raw(db)
      .prepare(`SELECT body FROM messages WHERE run_id = ? AND subject LIKE '%abandoned%'`)
      .get(originalRunId) as { body: string } | undefined
    expect(abandonedNotice?.body).toContain('could not be delivered within the retry deadline')
    expect(abandonedNotice?.body).toContain('runtime_environment_changed')
    expect(abandonedNotice?.body).not.toContain('refused')
    expect(abandonedNotice?.body).not.toContain('route moved')
  })

  // Ruling 28(k) AMENDS (jj): the stamp is no longer guarded to queued/sending rows (a terminal
  // disposition now persists it too, so it can gate the SAME per-link interval) — this test's
  // own assertions only ever exercise the retry-path code (fired while the row is still
  // 'queued'), so they are unaffected; the dedicated terminal-notice tests below cover the
  // amended (now-persists-on-terminal-rows) behaviour directly.
  it('Ruling 26 Addendum 4(hh)/(ii)/(jj): the disposition family persists its own per-link interval, never shares it with the R20.2 advisory', async () => {
    const { outboxId } = await enqueueOneReply()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockRejectedValue(
      new OrchestrationError('stale_environment_pairing', 'pairing stale')
    )
    runtime.replyOutbox?.kick(linkDeviceId)
    let item = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 80 && item?.lastNotifiedCondition !== 'reply_relay_stale_pairing'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      item = db.getReplyOutboxItem(outboxId)
    }
    // (ii): the persisted interval, not a Map — both notice columns stamped in the SAME write,
    // and only because the row was still 'queued' when the notice fired (jj).
    expect(item?.lastNotifiedCondition).toBe('reply_relay_stale_pairing')
    expect(item?.lastNotifiedAt).not.toBeNull()
    expect(db.replyOutboxLinkLastDispositionNotifiedAt(linkDeviceId)).toBe(item?.lastNotifiedAt)

    // (hh): a SECOND, DIFFERENT item on the SAME link, delivered cleanly with an
    // authorship-unconfirmed result, still fires the R20.2 advisory notice — the disposition
    // family's just-stamped interval must not silence it. A shared budget (the C5d defect)
    // would suppress this notice for LINK_BINDING_REVERIFY_MS after the stale-pairing fire above.
    db.insertGatedMessage({
      id: 'msg_eeeeeeeeee02',
      from: `remote:${environmentId}:peer_answerer_agt`,
      to: `agent:${askerId}`,
      subject: 'hello 2',
      body: 'hello P 2',
      runId: 'run_peer_local',
      verb: 'federation_import',
      peerLinkDeviceId: linkDeviceId,
      peerAgentId: 'peer_answerer_agt',
      threadId: null
    })
    vi.spyOn(runtime, 'callPinnedEnvironment').mockResolvedValue({
      accepted: true,
      messageId: 'msg_peerreceipt03',
      threadId: null,
      authorshipUnconfirmed: true
    })
    const second = (await call(
      'orchestration.reply',
      { id: 'msg_eeeeeeeeee02', body: 'reply body 2' },
      {
        runtime,
        orchestrationCompatibilityEvidence: { terminalHandle: `agent:${askerId}`, paneKey: PANE_A },
        orchestrationCompatibilityCallerAuthority: makeAuthority(`agent:${askerId}`)
      }
    )) as { relay: { outboxId: string } }
    runtime.replyOutbox?.kick(linkDeviceId)
    let secondItem = db.getReplyOutboxItem(second.relay.outboxId)
    for (let i = 0; i < 80 && secondItem?.state !== 'delivered'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      secondItem = db.getReplyOutboxItem(second.relay.outboxId)
    }
    expect(secondItem?.state).toBe('delivered')
    const advisoryNotice = raw(db)
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND subject LIKE '%could not confirm its addressee%'`
      )
      .get(originalRunId) as { n: number }
    expect(advisoryNotice.n).toBe(1)
    // The disposition family's own column is untouched by the advisory delivery — proving the
    // two families really are on separate columns/budgets, not just separately timed.
    expect(secondItem?.lastNotifiedCondition).toBeNull()

    // (jj): the unreachable/recovered family never touches last_notified_condition either —
    // driven only from the row's own consecutive_failures.
    const baseItem = db.getReplyOutboxItem(outboxId)!
    recordReplyOutboxFailureAndMaybeNotify(
      runtime,
      { ...baseItem, consecutiveFailures: REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD - 1 },
      REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
    )
    expect(db.getReplyOutboxItem(outboxId)?.lastNotifiedCondition).toBe('reply_relay_stale_pairing')
  })

  it('Ruling 26 Addendum 4(jj)/F5: a retarget clears BOTH notice columns — a new route starts a new notice history', async () => {
    vi.spyOn(runtime, 'callPinnedEnvironment').mockRejectedValue(
      new OrchestrationError('stale_environment_pairing', 'pairing stale')
    )
    const { outboxId } = await enqueueOneReply()
    runtime.replyOutbox?.kick(linkDeviceId)
    let item = db.getReplyOutboxItem(outboxId)
    for (let i = 0; i < 80 && item?.lastNotifiedCondition !== 'reply_relay_stale_pairing'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      item = db.getReplyOutboxItem(outboxId)
    }
    expect(item?.lastNotifiedCondition).toBe('reply_relay_stale_pairing')
    expect(item?.lastNotifiedAt).not.toBeNull()

    // The stale-pairing retry left a real backoff on next_attempt_after — force it claimable now.
    ;(db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('UPDATE peer_reply_outbox SET next_attempt_after = ? WHERE id = ?')
      .run(Date.now() - 1, outboxId)
    const claimed = db.claimNextReplyOutboxItem(Date.now())
    expect(claimed?.id).toBe(outboxId)
    // Ruling 26 Addendum 5(nn)/F2: a REAL registered device with pins matching the environment's
    // actual current endpoint, so the candidate passes the full routable predicate.
    const retargetedLink = registry.mintPendingDevice('peer-host-3', 'runtime')
    registry.updateLastSeen(retargetedLink.deviceId)
    const retargetedLinkId = retargetedLink.deviceId
    db.putPeerLinkBinding({
      linkDeviceId: retargetedLinkId,
      environmentId,
      boundEndpointId: environmentEndpointId,
      boundPairingRevision: claimed!.boundPairingRevision,
      linkCredentialFp: hashCallerCredential(retargetedLink.token),
      peerCredentialFp: claimed!.peerCredentialFp,
      peerKeyFingerprint: fingerprintOrchestrationPeer('peer_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    holdOrRetargetReplyOutboxItem(runtime, claimed!, Date.now())
    const after = db.getReplyOutboxItem(outboxId)
    expect(after?.linkDeviceId).toBe(retargetedLinkId)
    expect(after?.lastNotifiedCondition).toBeNull()
    expect(after?.lastNotifiedAt).toBeNull()
  })

  // Design v6 catalogue scenario 28/Ruling 28(j): "Reply, peer down: item queued; restart the
  // process; the pump resumes at DB attach and delivers on the peer's return, with no operator
  // action and no re-issued reply." The load-bearing half this ruling actually fixes is the
  // CRASH-MID-SEND case: a 'sending' row whose lease has not yet expired at "restart" time is
  // invisible to a wake computed from `queued.next_attempt_after` alone (state != 'queued'), so
  // nothing would ever wake the pump when that lease finally expires — the row would sit
  // 'sending' forever without an external kick. `nextReplyOutboxWakeAt` now also considers
  // `sending.lease_expires_at`.
})
