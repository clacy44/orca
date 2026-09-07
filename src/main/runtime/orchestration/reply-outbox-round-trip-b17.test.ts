// S10-21b B17 (D-R138 B-F1) — split out of reply-outbox-round-trip.test.ts (max-lines ratchet)
// once T32 pushed that file over the 800-line test budget. Same two-store (SENDER/RECEIVER)
// pump round-trip harness, duplicated rather than shared via import so each file stays
// independently readable — see that file's own header for the harness's general rationale.
//
// S10-21b B21 (D-D3-A item 7, T6; forced deviation): the D-R140 end-to-end test this file
// used to carry is DELETED — it asserted properties of the relay-owed drain, a mechanism this
// commit removes (21b-E8 REVOKED). Its REPLACEMENT, T6, is NOT added here: adding it in place
// would push this file past the 800-line test budget (_common-rules.md), so it lives in its
// own file, pact-federated-pause-resume-b21-e2e.test.ts, duplicating this same harness for the
// same reason this file duplicates reply-outbox-round-trip.test.ts's.
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
})
