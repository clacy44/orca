// S10-21b B17 (D-R137/D-R138 batch-3 fixes) — split out of orchestration-pact.test.ts (max-lines
// ratchet) once this brief's own tests pushed that file over the 800-line test budget. Same RPC
// harness pattern (real ORCHESTRATION_METHODS, not mocked), duplicated rather than shared via
// import so each file stays independently readable.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type Database from '../../../sqlite/sync-database'
import { renderFederatedPartyKey } from '../../orchestration/pact-federated-identity'
import { putPeerLinkBinding, LinkBindingCapError } from '../../orchestration/link-binding-store'
import { PACT_PROPOSAL_BLOCK_MS } from '../../orchestration/link-binding-constants'

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
const ALL_EVIDENCE = [evidenceA, evidenceB]

describe('orchestration.threads.pact / orchestration.wait (pact) — S10-21b B17', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.getTerminalProcessIncarnation = () => 'proc-1'
    runtime.listTerminals = async () => ({ terminals: [], totalCount: 0, truncated: false })
    runtime.getAgentDirectoryLivenessSignals = () => ({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
    })
    runtime.verifyOrchestrationCompatibilityCaller = (evidence) => {
      const found = ALL_EVIDENCE.find(
        (e) => evidence?.terminalHandle === e.terminalHandle && evidence.paneKey === e.paneKey
      )
      return found ? makeAuthority(found.paneKey, found.terminalHandle) : null
    }
  }

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  function ctx(evidence?: Evidence): RpcContext {
    return { runtime, orchestrationCompatibilityEvidence: evidence }
  }

  async function call(
    name: string,
    params: Record<string, unknown>,
    context: RpcContext
  ): Promise<unknown> {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, context)
  }

  async function registerAgent(name: string, evidence: Evidence): Promise<string> {
    const result = (await call(
      'orchestration.agents.register',
      { name, role: 'test agent' },
      ctx(evidence)
    )) as {
      agent: { id: string }
    }
    return result.agent.id
  }

  async function threadWith(owner: Evidence, others: string[]): Promise<string> {
    const created = (await call(
      'orchestration.threads.create',
      { with: others.map((id) => `agent:${id}`).join(',') },
      ctx(owner)
    )) as { thread: { id: string } }
    return created.thread.id
  }

  async function setupFederatedWaitPact(
    env: string,
    remoteAgentId: string,
    remoteState: 'live' | 'idle' | 'gone'
  ): Promise<{ threadId: string; raw: Database.Database; a: string }> {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    db.upsertRemoteAgent({
      environmentId: env,
      environmentName: env,
      linkKind: 'environment',
      remoteAgentId,
      displayName: 'peer (remote)',
      role: null,
      state: remoteState,
      derived: false,
      remoteQuarantined: false
    })
    const raw = (db as unknown as { db: Database.Database }).db
    putPeerLinkBinding(raw, {
      linkDeviceId: env,
      environmentId: env,
      boundEndpointId: `endpoint-${env}`,
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
    const peerKey = renderFederatedPartyKey({ linkDeviceId: env, remoteAgentId })
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    const threadId = thread.id
    db.proposePact({
      callerAgentId: a,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    raw
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(peerKey, threadId)
    return { threadId, raw, a }
  }

  // ---------------------------------------------------------------------------------------
  // F11 (D-R137) below
  // ---------------------------------------------------------------------------------------
  // S10-21b B17 (D-R137 F11) — a read-shaped path (a wait timeout) must never throw because of
  // a write side effect. RED at base: `computePactWaitExpiryFacts` called the write with no
  // try/catch, so a `LinkBindingCapError` from `putScanFact` propagated straight into the RPC
  // response, turning a benign `outcome:'timeout'` into an error.
  it('F11: a wait-expiry scan-fact write failure (LinkBindingCapError) is caught and audited, never thrown through the RPC (RED at base)', async () => {
    const { threadId, a } = await setupFederatedWaitPact('env-f11', 'peer-f11', 'gone')
    const capSpy = vi.spyOn(db, 'putScanFact').mockImplementation(() => {
      throw new LinkBindingCapError('peer_link_scan_facts')
    })
    try {
      const result = (await call(
        'orchestration.wait',
        { threadId, for: 'pact', timeoutMs: 30 },
        ctx(evidenceA)
      )) as { outcome: string }
      expect(result.outcome).toBe('timeout')
    } finally {
      capSpy.mockRestore()
    }
    void a
    const raw = (db as unknown as { db: Database }).db
    const auditRow = raw
      .prepare(
        `SELECT outcome FROM agent_audit WHERE verb = 'pact_wait_expiry_scan_fact_write_failed'`
      )
      .get() as { outcome: string } | undefined
    expect(auditRow?.outcome).toBe('error')
  })

  // ---------------------------------------------------------------------------------------
  // F12 (D-R137) below
  // ---------------------------------------------------------------------------------------
  // S10-21b B17 (D-R137 F12) — the `--acknowledge-gate` refusal on a federated step is a
  // property of the VERB (§7), not just the CLI's own pre-check (a TOCTOU window, and any
  // non-CLI client bypasses it entirely). RED at base: `orchestration.threads.step` had no
  // refusal of its own — a direct RPC call with `acknowledgeGate: true` on a federated pact
  // succeeded.
  it('F12: orchestration.threads.step refuses acknowledgeGate on a federated pact (RPC-level, RED at base)', async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    const env = 'env-f12'
    const remoteAgentId = 'peer-remote-f12'
    db.upsertRemoteAgent({
      environmentId: env,
      environmentName: env,
      linkKind: 'environment',
      remoteAgentId,
      displayName: 'peer (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding((db as unknown as { db: Database.Database }).db, {
      linkDeviceId: env,
      environmentId: env,
      boundEndpointId: 'endpoint-f12',
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
    const peerKey = renderFederatedPartyKey({ linkDeviceId: env, remoteAgentId })
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    const threadId = thread.id
    db.proposePact({
      callerAgentId: a,
      callerPaneKey: PANE_A,
      callerHostId: 'local',
      threadId,
      peerAgentId: peerKey,
      stepsTotal: null
    })
    ;(db as unknown as { db: Database.Database }).db
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, threadId)

    await expect(
      call(
        'orchestration.threads.step',
        { threadId, done: 'trying to acknowledge a hard gate', acknowledgeGate: true },
        ctx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    const stepCount = (
      (db as unknown as { db: Database.Database }).db
        .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'step'`)
        .get(threadId) as { n: number }
    ).n
    expect(stepCount).toBe(0)
  })

  // S10-21b B17 (D-R137 F1/F14, D-R138 F1/F10) — the base `blockingPeers.length > 0` throw
  // refuses `wait` on the mere existence of a still-live per-(peer, local agent) window,
  // independently of whether any proposal is still unanswered. Every test here constructs a
  // FEDERATED incoming proposal (the block only ever applies to a federated peer's
  // `pact_proposer_agent_id`, a rendered `remote:<link>:<id>` key — a purely local propose never
  // touches `agent_rate` here) via `applyInboundPactVerb`, exactly as
  // pact-federated-containment-b14.test.ts's T-NB8 does.
  describe('D-R137 F1/F14, D-R138 F1/F10: the proposal block is the unanswered-proposal check, with a sliding re-arm window', () => {
    const ENV = 'env_propblock'

    function raw(): Database.Database {
      return (db as unknown as { db: Database.Database }).db
    }

    function seedIncomingPeer(remoteAgentId: string, name: string): string {
      db.upsertRemoteAgent({
        environmentId: ENV,
        environmentName: ENV,
        linkKind: 'environment',
        remoteAgentId,
        displayName: name,
        role: null,
        state: 'live',
        derived: false,
        remoteQuarantined: false
      })
      putPeerLinkBinding(raw(), {
        linkDeviceId: ENV,
        environmentId: ENV,
        boundEndpointId: `endpoint_${remoteAgentId}`,
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
      return renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId })
    }

    // A fresh THREAD per incoming proposal — a declined pact's thread cannot host a second
    // proposal, exactly as T-NB8's thread1/thread2 pattern requires.
    function seedIncomingProposal(
      a: string,
      peerKey: string,
      remoteAgentId: string,
      peerThreadId: string
    ): string {
      const { thread } = db.createThread({
        subject: 's',
        createdByAgentId: a,
        participants: [
          { participantKey: a, agentId: a },
          { participantKey: peerKey, agentId: null }
        ]
      })
      raw()
        .prepare(
          `INSERT INTO messages (id, from_handle, to_handle, subject, thread_id, peer_link_device_id, peer_thread_id)
           VALUES (?, ?, 'host', 's', ?, ?, ?)`
        )
        .run(`msg_seed_${thread.id}`, peerKey, thread.id, ENV, peerThreadId)
      db.applyInboundPactVerb({
        pairedDeviceId: ENV,
        senderEnvironmentId: ENV,
        senderAgentId: remoteAgentId,
        toAgentId: a,
        peerThreadId,
        messageId: `msg_${peerThreadId}`,
        body: undefined,
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
      return thread.id
    }

    // A separate, ordinary LOCAL engaged pact to actually park `--for step` on — turn held by
    // `other`, not `a`, so `a`'s park genuinely waits (K24's turn guard) instead of short-
    // circuiting to `your_turn`.
    async function engagedLocalPact(a: string, otherEvidence: Evidence): Promise<string> {
      // `other` proposes (the proposer holds the turn after accept — see the "propose ->
      // accept" happy-path test) so `a` accepts and holds NO turn anywhere, letting `a`'s park
      // actually reach `assertNoIncomingProposalOwed` instead of short-circuiting on K24's
      // turn guard.
      const threadId = await threadWith(otherEvidence, [a])
      await call(
        'orchestration.threads.pact',
        { id: threadId, with: `agent:${a}` },
        ctx(otherEvidence)
      )
      await call('orchestration.threads.pact', { id: threadId, accept: true }, ctx(evidenceA))
      return threadId
    }

    function ageWindow(peerKey: string, a: string, deltaMs: number): void {
      const subjectKey = `${peerKey}::${a}`
      const row = raw()
        .prepare(
          `SELECT window_start FROM agent_rate WHERE subject_key = ? AND verb = 'pact_propose_block'`
        )
        .get(subjectKey) as { window_start: string } | undefined
      if (!row) {
        throw new Error(`ageWindow: no proposal-block row for ${subjectKey}`)
      }
      const shifted = new Date(Date.parse(row.window_start) + deltaMs).toISOString()
      raw()
        .prepare(
          `UPDATE agent_rate SET window_start = ? WHERE subject_key = ? AND verb = 'pact_propose_block'`
        )
        .run(shifted, subjectKey)
    }

    it('(a) peer proposes, local declines, wait --for step on another pact → ALLOWED (RED at base: answer_first)', async () => {
      setup()
      const a = await registerAgent('agent-a', evidenceA)
      await registerAgent('agent-b', evidenceB)
      const peerKey = seedIncomingPeer('r1a', 'peer1a')
      const propThreadId = seedIncomingProposal(a, peerKey, 'r1a', 'thr_00000000001a')
      db.declinePact({
        callerAgentId: a,
        callerPaneKey: PANE_A,
        callerHostId: 'local',
        threadId: propThreadId,
        reasonCode: null
      })

      const otherThreadId = await engagedLocalPact(a, evidenceB)
      await expect(
        call(
          'orchestration.wait',
          { threadId: otherThreadId, for: 'pact', timeoutMs: 30 },
          ctx(evidenceA)
        )
      ).resolves.toMatchObject({ outcome: 'timeout' })
    })

    it('(b) peer proposes, local declines, peer re-proposes inside the window → wait still allowed, new proposal still visible', async () => {
      setup()
      const a = await registerAgent('agent-a', evidenceA)
      await registerAgent('agent-b', evidenceB)
      const peerKey = seedIncomingPeer('r1b', 'peer1b')
      const propThreadId1 = seedIncomingProposal(a, peerKey, 'r1b', 'thr_00000000001b')
      db.declinePact({
        callerAgentId: a,
        callerPaneKey: PANE_A,
        callerHostId: 'local',
        threadId: propThreadId1,
        reasonCode: null
      })
      const propThreadId2 = seedIncomingProposal(a, peerKey, 'r1b', 'thr_00000000002b')

      // The re-propose is unanswered and visible.
      const incoming = db.getIncomingUnansweredProposal(a)
      expect(incoming?.id).toBe(propThreadId2)

      const otherThreadId = await engagedLocalPact(a, evidenceB)
      await expect(
        call(
          'orchestration.wait',
          { threadId: otherThreadId, for: 'pact', timeoutMs: 30 },
          ctx(evidenceA)
        )
      ).resolves.toMatchObject({ outcome: 'timeout' })
    })

    it('(c) peer proposes and it is UNANSWERED → refused answer_first (guard)', async () => {
      setup()
      const a = await registerAgent('agent-a', evidenceA)
      await registerAgent('agent-b', evidenceB)
      const peerKey = seedIncomingPeer('r1c', 'peer1c')
      seedIncomingProposal(a, peerKey, 'r1c', 'thr_00000000001c')

      const otherThreadId = await engagedLocalPact(a, evidenceB)
      await expect(
        call(
          'orchestration.wait',
          { threadId: otherThreadId, for: 'pact', timeoutMs: 30 },
          ctx(evidenceA)
        )
      ).rejects.toThrow(/answer_first|waiting on YOUR answer/)
    })

    it('(d) a proposal at t and a wait at t+W-1 with a re-propose in between → still not re-armed; at t+W+1 → re-armed (RED)', async () => {
      setup()
      const a = await registerAgent('agent-a', evidenceA)
      await registerAgent('agent-b', evidenceB)
      const peerKey = seedIncomingPeer('r1d', 'peer1d')
      const propThreadId1 = seedIncomingProposal(a, peerKey, 'r1d', 'thr_00000000001d')
      db.declinePact({
        callerAgentId: a,
        callerPaneKey: PANE_A,
        callerHostId: 'local',
        threadId: propThreadId1,
        reasonCode: null
      })
      seedIncomingProposal(a, peerKey, 'r1d', 'thr_00000000002d')

      const otherThreadId = await engagedLocalPact(a, evidenceB)

      // Push the window's start back so ~5s of its budget remains (still live; the 5s margin
      // absorbs the real time elapsed by the preceding async setup/RPC calls).
      ageWindow(peerKey, a, -(PACT_PROPOSAL_BLOCK_MS - 5_000))
      await expect(
        call(
          'orchestration.wait',
          { threadId: otherThreadId, for: 'pact', timeoutMs: 30 },
          ctx(evidenceA)
        )
      ).resolves.toMatchObject({ outcome: 'timeout' })

      // Push it back another 10s so the window has clearly elapsed — the still-unanswered
      // re-propose from earlier now re-arms the block.
      ageWindow(peerKey, a, -10_000)
      await expect(
        call(
          'orchestration.wait',
          { threadId: otherThreadId, for: 'pact', timeoutMs: 30 },
          ctx(evidenceA)
        )
      ).rejects.toThrow(/answer_first|waiting on YOUR answer/)
    })
  })
})
