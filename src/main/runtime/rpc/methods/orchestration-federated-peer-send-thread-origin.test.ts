// S10-15/S10-16 C8b: thread-origin and sameOriginHost tests split out of
// orchestration-federated-peer-send.test.ts to stay under max-lines — ML-1 (R28.1(1a) clause
// (ii)'s else-branch, a quarantined sibling never satisfies it) and scenario 68/P8
// (sameOriginHost is routable-only). Same two-runtime harness, same file-level vi.mock wrapper
// around getRoutableLinkBinding (default pass-through; these two tests are the ones that force
// it).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { PeerLinkBindingRow } from '../../orchestration/link-binding-store'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import type * as LinkBindingRoutable from '../../orchestration/link-binding-routable'
import type { RpcContext } from '../core'

// Ruling 26 Addendum 1(w)/F10: this suite never wires a real device registry / environment
// store, so getRoutableLinkBinding's clauseII check has nothing routable to find. Wrapped
// (default pass-through to the real implementation for every other test) so exactly the tests
// below can force a matching (or refusing) route without standing up that machinery.
vi.mock('../../orchestration/link-binding-routable', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkBindingRoutable>()
  return { ...actual, getRoutableLinkBinding: vi.fn(actual.getRoutableLinkBinding) }
})

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

type Evidence = { terminalHandle: string; paneKey: string; launchToken: string }
const evidenceA: Evidence = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'lt-a' }
const evidenceB: Evidence = { terminalHandle: 'term_b', paneKey: PANE_B, launchToken: 'lt-b' }

const LINK_DEVICE_ID = 'dev_home_link_1'
const LINK_FINGERPRINT = 'fp_home_link_1'
const WORKER_SERVER = { environmentId: 'env_worker_1', name: 'windows', peerFingerprint: 'fp_x' }

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
    get: (...args: unknown[]) => unknown
    run: (...args: unknown[]) => unknown
  }
} {
  return (db as unknown as { db: ReturnType<typeof raw> }).db
}

describe('S10-15/S10-16 C8b: thread-origin and sameOriginHost (ML-1, scenario 68/P8)', () => {
  let homeDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerDb: OrchestrationDb
  let workerRuntime: OrcaRuntimeService

  function workerLinkCtx(): RpcContext {
    return {
      runtime: workerRuntime,
      pairedDeviceId: LINK_DEVICE_ID,
      clientKind: 'runtime',
      authenticatedCallerFingerprint: LINK_FINGERPRINT
    }
  }

  let relayCalls: unknown[]

  function setup(): void {
    homeDb = new OrchestrationDb(':memory:')
    homeRuntime = new OrcaRuntimeService()
    homeRuntime.setOrchestrationDb(homeDb)
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    relayCalls = []

    for (const runtime of [homeRuntime, workerRuntime]) {
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
    vi.spyOn(homeRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      verifyEitherPane
    )
    vi.spyOn(workerRuntime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      verifyEitherPane
    )
    vi.spyOn(homeRuntime, 'resolveOrchestrationWorkerServer').mockImplementation((selector) => {
      if (selector !== 'windows') {
        throw new Error('unknown environment')
      }
      return WORKER_SERVER
    })
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, methodName, params) => {
        relayCalls.push(params)
        if (methodName !== 'orchestration.federatedSend') {
          throw new Error(`unexpected relay method ${methodName}`)
        }
        return call(
          'orchestration.federatedSend',
          params as Record<string, unknown>,
          workerLinkCtx()
        )
      }
    )
  }

  afterEach(async () => {
    homeDb?.close()
    workerDb?.close()
    const actual = await vi.importActual<typeof LinkBindingRoutable>(
      '../../orchestration/link-binding-routable'
    )
    vi.mocked(getRoutableLinkBinding).mockReset()
    vi.mocked(getRoutableLinkBinding).mockImplementation(actual.getRoutableLinkBinding)
  })

  async function registerAgent(
    runtime: OrcaRuntimeService,
    name: string,
    evidence: Evidence
  ): Promise<string> {
    const result = (await call(
      'orchestration.agents.register',
      { name, role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: evidence }
    )) as { agent: { id: string } }
    return result.agent.id
  }

  // Scenario 68/P8: `sameOriginHost` is ROUTABLE-only — a stored link and a redelivering link
  // sharing a peer_key_fingerprint is not enough; both must independently clear
  // `getRoutableLinkBinding` right now. contested/revoked_at/quarantined all make a row fail
  // `isRoutableBindingRow` individually (link-binding-liveness.test.ts:89,93 and its quarantine
  // case — not re-derived here); this test proves the COMPOSITION: `sameOriginHost` itself
  // never falls back to comparing stored state directly when the redelivering link is not
  // routable for ANY of those reasons, and DOES treat two independently-routable links sharing a
  // key fingerprint as the same origin.
  it('scenario 68/P8: sameOriginHost is routable-only — a non-routable redelivering link never replays as the same origin; two routable links sharing a key fingerprint do', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    const linkPrime = 'dev_l_prime'
    const linkL = 'dev_l'
    const sharedKeyFingerprint = 'shared_pkf_68'

    // A distinct authenticatedCallerFingerprint PER LINK — federated-sender-identity.ts binds a
    // peer fingerprint to one linkKey on first contact and refuses `cross_link_duplicate` if the
    // SAME fingerprint later shows up under a different pairedDeviceId; L' and L are meant to be
    // two genuinely different peer links here, so they need two different fingerprints too.
    function linkCtx(pairedDeviceId: string): RpcContext {
      return {
        runtime: workerRuntime,
        pairedDeviceId,
        clientKind: 'runtime',
        authenticatedCallerFingerprint: `fp_${pairedDeviceId}`
      }
    }
    function routableRow(linkDeviceId: string): PeerLinkBindingRow {
      return {
        linkDeviceId,
        environmentId: WORKER_SERVER.environmentId,
        boundEndpointId: 'ep_worker_1',
        boundPairingRevision: 1,
        linkCredentialFp: 'link_cred_fp',
        peerCredentialFp: 'peer_cred_fp',
        peerKeyFingerprint: sharedKeyFingerprint,
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'orca.link-binding.v1',
        state: 'confirmed',
        detail: null,
        contestIncidentId: null,
        contestedAt: null,
        revokedAt: null,
        provedAt: Date.now(),
        lastVerifiedAt: Date.now()
      }
    }

    // Store the ORIGINAL message under L' — the store path never calls sameOriginHost (no
    // `existing` row yet), so no mock is needed for this call.
    const storeEnvelope = {
      fromAgent: { id: 'agt_00000000ef01', displayName: 'peer-sender' },
      toAgentId: agentB,
      messageId: 'msg_0000000ef011',
      subject: 'scenario 68',
      body: 'hello',
      type: 'status'
    }
    const stored = (await call(
      'orchestration.federatedSend',
      storeEnvelope,
      linkCtx(linkPrime)
    )) as { accepted: boolean; messageId: string }
    expect(stored.accepted).toBe(true)

    // L is not routable (any of contested/revoked/quarantined collapses to the same
    // getRoutableLinkBinding(L) === null outcome sameOriginHost sees) — never the same origin,
    // even though it shares L''s key fingerprint at the STORAGE layer. A DIFFERENT `fromAgent.id`
    // than the store call — sameOriginHost never looks at the sender identity, only
    // `to_handle`/`type`/the link routability, and reusing the same peer agent id under a
    // DIFFERENT paired link would itself refuse earlier, at identity import
    // (federated-sender-identity.ts: "already bound to a different paired link"), before ever
    // reaching the branch this test targets.
    vi.mocked(getRoutableLinkBinding).mockImplementation((_db, _runtime, linkDeviceId) => {
      if (linkDeviceId === linkPrime) {
        return routableRow(linkPrime)
      }
      return null
    })
    await expect(
      call(
        'orchestration.federatedSend',
        { ...storeEnvelope, fromAgent: { id: 'agt_00000000ef02', displayName: 'peer-sender' } },
        linkCtx(linkL)
      )
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    const messageCount = raw(workerDb)
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?')
      .get(storeEnvelope.messageId) as { n: number }
    expect(messageCount.n).toBe(1)

    // Positive case: TWO live, routable links sharing the key fingerprint -> idempotent replay,
    // the stored receipt, never a new row.
    vi.mocked(getRoutableLinkBinding).mockImplementation((_db, _runtime, linkDeviceId) => {
      if (linkDeviceId === linkPrime || linkDeviceId === linkL) {
        return routableRow(linkDeviceId)
      }
      return null
    })
    const replay = (await call(
      'orchestration.federatedSend',
      { ...storeEnvelope, fromAgent: { id: 'agt_00000000ef03', displayName: 'peer-sender' } },
      linkCtx(linkL)
    )) as { accepted: boolean; messageId: string }
    expect(replay.accepted).toBe(true)
    expect(replay.messageId).toBe(stored.messageId)
    const messageCountAfterReplay = raw(workerDb)
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?')
      .get(storeEnvelope.messageId) as { n: number }
    expect(messageCountAfterReplay.n).toBe(1)
  })

  // ML-1/Ruling 26 Addendum 6(qq)/Ruling 28(n): clause (ii)'s ELSE branch — the caller's own
  // link resolves to a DIFFERENT environment than the mirror row's `to_handle` names, forcing
  // the sibling lookup (findBindingCandidateByKeyFingerprint), and that sibling is quarantined.
  // findBindingCandidateByKeyFingerprint's own predicate (state='confirmed', revoked_at IS NULL)
  // does NOT check quarantine, so it WILL find this row — it must be the sibling's own
  // getRoutableLinkBinding call (the SECOND call to the mocked function this suite's vi.mock
  // wrapper lets fall through to the REAL implementation, per the file-level comment above) that
  // refuses it, never satisfying (ii). No thread reuse, no back-fill.
  it('R28.1(1a) clause (ii) else-branch: a quarantined sibling sharing the caller peerKeyFingerprint never satisfies (ii) — fresh thread, no back-fill', async () => {
    setup()
    const agentA = await registerAgent(workerRuntime, 'agent-a', evidenceA)

    const mirrorId = 'msg_aaaaaaaaaa03'
    workerDb.insertGatedMessage({
      id: mirrorId,
      from: `agent:${agentA}`,
      to: `remote:${WORKER_SERVER.environmentId}:peer_far_agt`,
      subject: 'A to peer, ML-1',
      body: 'hi peer',
      threadId: null,
      verb: 'send'
    })

    const callerPeerKeyFingerprint = 'peer_key_fp_ml1'
    // The FIRST getRoutableLinkBinding call (callerBinding, keyed on the caller's own paired
    // link) resolves to a DIFFERENT environment than the mirror row's `toEnv`
    // (WORKER_SERVER.environmentId) — clause (ii)'s primary `toEnv === callerBinding.environmentId`
    // check is false, forcing the else-branch.
    vi.mocked(getRoutableLinkBinding).mockReturnValueOnce({
      linkDeviceId: LINK_DEVICE_ID,
      environmentId: 'env_worker_OTHER',
      boundEndpointId: 'ep_worker_other_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_cred_fp',
      peerCredentialFp: 'peer_cred_fp',
      peerKeyFingerprint: callerPeerKeyFingerprint,
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      state: 'confirmed',
      detail: null,
      contestIncidentId: null,
      contestedAt: null,
      revokedAt: null,
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    } satisfies PeerLinkBindingRow)

    // A REAL, quarantined sibling binding under the SAME peer key fingerprint, whose environment
    // DOES match toEnv.
    const siblingLinkDeviceId = 'dev_ml1_sibling'
    workerDb.putPeerLinkBinding({
      linkDeviceId: siblingLinkDeviceId,
      environmentId: WORKER_SERVER.environmentId,
      boundEndpointId: 'ep_worker_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_cred_fp_sibling',
      peerCredentialFp: 'peer_cred_fp_sibling',
      peerKeyFingerprint: callerPeerKeyFingerprint,
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    workerDb.putContainment({
      subjectKind: 'link',
      subjectId: siblingLinkDeviceId,
      action: 'quarantine',
      reasonCode: 'test',
      reasonText: 'test',
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })

    const envelope = {
      fromAgent: { id: 'agt_00000000cd03', displayName: 'peer-sender' },
      toAgentId: agentA,
      messageId: 'msg_0000000bcd13',
      subject: 'reply',
      body: 'ml-1 reply',
      inReplyToMessageId: mirrorId
    }
    const result = (await call('orchestration.federatedSend', envelope, workerLinkCtx())) as {
      accepted: true
      messageId: string
      threadId: string | null
      authorshipUnconfirmed?: true
    }

    // Fresh thread, never the mirror's (which stays NULL — no back-fill), and never
    // authorshipUnconfirmed (authorship passed; only the thread-selection clauses failed).
    expect(result.threadId).toBeTruthy()
    expect(result.authorshipUnconfirmed).toBeUndefined()
    const mirrorAfter = raw(workerDb)
      .prepare('SELECT thread_id FROM messages WHERE id = ?')
      .get(mirrorId) as { thread_id: string | null }
    expect(mirrorAfter.thread_id).toBeNull()
    expect(mirrorAfter.thread_id).not.toBe(result.threadId)
  })
})
