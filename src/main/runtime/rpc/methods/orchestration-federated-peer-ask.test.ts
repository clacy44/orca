// S10-8 R7: the two-runtime reproduction harness the chair rulings require. Two independent
// OrchestrationDb + OrcaRuntimeService pairs stand in for two real Orca hosts ("home" = the
// asker's runtime, "worker" = the answerer's runtime); `homeRuntime.callOrchestrationWorkerServer`
// is stubbed to invoke the WORKER's real `orchestration.federatedAsk` handler directly — the same
// seam orchestration-federation.test.ts and orchestration-peer-ask-reply.test.ts already use for
// "real handler, fake socket" coverage, never a mocked business outcome. `orchestration.ask` and
// `orchestration.reply` are the exact production handlers (ORCHESTRATION_METHODS), reached the
// same way the RPC dispatcher reaches them — this file just skips the JSON-RPC envelope, matching
// orchestration-peer-ask-reply.test.ts's own established convention for this feature area.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext, RpcRequest } from '../core'
import {
  getOrchestrationMutationExecutor,
  type DurableMutationInvocation
} from '../orchestration-mutation-executor'
import { isOrchestrationMutation } from '../../../../shared/orchestration-rpc-contract'

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

const HOME_LINK_DEVICE_ID = 'dev_home_link_1'
const HOME_LINK_FINGERPRINT = 'fp_home_link_1'

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

describe('S10-8 cross-host ask/reply relay (R1-R7)', () => {
  let homeDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerDb: OrchestrationDb
  let workerRuntime: OrcaRuntimeService

  function homeCtx(evidence?: Evidence): RpcContext {
    return { runtime: homeRuntime, orchestrationCompatibilityEvidence: evidence }
  }

  // The paired-runtime ctx a genuine relay call from "home" arrives with on "worker" — never a
  // local pane's orchestrationCompatibilityEvidence (R2: the link authenticates, not a pane).
  function workerLinkCtx(): RpcContext {
    return {
      runtime: workerRuntime,
      pairedDeviceId: HOME_LINK_DEVICE_ID,
      clientKind: 'runtime',
      authenticatedCallerFingerprint: HOME_LINK_FINGERPRINT
    }
  }

  function workerLocalCtx(evidence?: Evidence): RpcContext {
    return { runtime: workerRuntime, orchestrationCompatibilityEvidence: evidence }
  }

  function setup(): void {
    homeDb = new OrchestrationDb(':memory:')
    homeRuntime = new OrcaRuntimeService()
    homeRuntime.setOrchestrationDb(homeDb)
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)

    for (const runtime of [homeRuntime, workerRuntime]) {
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
      vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
        terminals: [],
        totalCount: 0,
        truncated: false
      })
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
        terminalHandle: null,
        lastAgentStatus: null,
        observedLive: false
      })
      // Why a short REAL timer, not an instantly-resolved mock: the happy-path test below needs
      // to answer a question WHILE its asker is genuinely still parked in the wait loop, using
      // real macrotask scheduling for deterministic interleaving instead of racing microtasks
      // against a resolved-Promise busy loop. 5ms keeps every test here fast (a handful of polls
      // at most) while a `timeoutMs` in the tens of ms still resolves as a real timeout.
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('timed_out'), 5))
      )
    }
    // Why both A's and B's pane evidence accepted on EACH runtime: a couple of scenarios below
    // register two local agents on the SAME host (e.g. proving a `host`-less ask never relays),
    // and panes are host-scoped so reusing the same two evidence fixtures on either side is fine
    // — they're separate DBs regardless.
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
    // R2: home relays over `callOrchestrationWorkerServer` — stubbed here to call the WORKER's
    // real `orchestration.federatedAsk` handler with a genuine paired-link ctx, the same seam
    // orchestration-federation.test.ts stubs `orchestrationEnvironmentTransport` at, one layer up.
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, methodName, params) => {
        if (methodName !== 'orchestration.federatedAsk') {
          throw new Error(`unexpected relay method ${methodName}`)
        }
        return call(
          'orchestration.federatedAsk',
          params as Record<string, unknown>,
          workerLinkCtx()
        )
      }
    )
  }

  afterEach(() => {
    homeDb?.close()
    workerDb?.close()
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

  it('R1/R2/R3/R4 F6-style happy path: A asks agent:B@windows, B replies while A is parked, A gets the answer in one round trip', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    const askPromise = call(
      'orchestration.ask',
      { to: `agent:${agentB}`, host: 'windows', question: 'db.ts landed yet?', timeoutMs: 5_000 },
      homeCtx(evidenceA)
    ) as Promise<{
      answer: string | null
      messageId: string
      threadId: string
      timedOut: boolean
    }>

    // The relay call reaches the worker and mints its question synchronously, before B's own
    // reply below — real macrotask delay so B answers while A is genuinely still parked, not via
    // a resumed ask (cross-host resume is out of scope, R6).
    await new Promise((resolve) => setTimeout(resolve, 15))

    // B answers the relayed question through the ORDINARY, unmodified local peer-reply path —
    // R4's "same guards" symmetry falls out for free because B never knows this thread is
    // foreign-origin; it is just another local peer question to B.
    const workerQuestionRow = findPendingPeerQuestion(workerDb)
    const replied = (await call(
      'orchestration.reply',
      { id: workerQuestionRow.message_id, body: 'yes, landed an hour ago' },
      workerLocalCtx(evidenceB)
    )) as { message: { body: string } }
    expect(replied.message.body).toBe('yes, landed an hour ago')

    const asked = await askPromise
    expect(asked.timedOut).toBe(false)
    expect(asked.answer).toBe('yes, landed an hour ago')

    // R3: provenance was stamped on the RECEIVING host before the question was even created.
    const remoteRows = workerDb.listRemoteAgents({ includeQuarantined: true })
    expect(remoteRows).toHaveLength(1)
    expect(remoteRows[0]).toMatchObject({
      environment_id: HOME_LINK_DEVICE_ID,
      display_name: 'asker',
      local_quarantined: 0
    })
  })

  it('R7 F-hard: a HARD-gated question body is refused on the target host with a durable audit row, and the link is not wedged', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    await expect(
      call(
        'orchestration.ask',
        {
          to: `agent:${agentB}`,
          host: 'windows',
          question: 'MERGE-GATE AUDIT: CVE-2025-1234 unresolved',
          timeoutMs: 50
        },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({
      code: 'body_gate_refused',
      data: expect.objectContaining({ refusalId: expect.any(Number) })
    })

    // Nothing was stored or delivered, and a clean ask right after still works — the refusal
    // disposition never wedges the link (R2's standing rule, no cursor to desync here since
    // every cross-host ask mints its own independent question).
    expect(findPendingPeerQuestion(workerDb, { allowNone: true })).toBeUndefined()
    const asked = (await call(
      'orchestration.ask',
      {
        to: `agent:${agentB}`,
        host: 'windows',
        question: 'clean follow-up question',
        timeoutMs: 50
      },
      homeCtx(evidenceA)
    )) as { timedOut: boolean }
    expect(asked.timedOut).toBe(true) // nobody answered it, but it was accepted — proves not wedged.
  })

  it('R7 quarantine: once this host has locally quarantined the remote asker, a further relayed ask is refused agent_quarantined', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    // First contact stamps the remote_agents row (provenance-first, same as production).
    await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, host: 'windows', question: 'first contact', timeoutMs: 10 },
      homeCtx(evidenceA)
    )
    const [remoteRow] = workerDb.listRemoteAgents({ includeQuarantined: true })
    workerDb.setLocalRemoteAgentQuarantine({
      environmentId: remoteRow.environment_id,
      remoteAgentId: remoteRow.remote_agent_id,
      quarantined: true,
      reasonCode: 'operator_quarantine'
    })

    await expect(
      call(
        'orchestration.ask',
        { to: `agent:${agentB}`, host: 'windows', question: 'second try', timeoutMs: 10 },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('R7 link down: an unreachable environment surfaces a typed error to the asker, nothing silently dropped', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValue(
      new Error('Environment "windows" is unreachable (no response within 10000ms).')
    )
    await expect(
      call(
        'orchestration.ask',
        {
          to: 'agent:agt_deadbeef0000',
          host: 'windows',
          question: 'are you there?',
          timeoutMs: 10
        },
        homeCtx(evidenceA)
      )
    ).rejects.toThrow(/unreachable/)
  })

  it('R2 unauthenticated_lane: federatedAsk refuses a caller with no paired-link identity', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000001', displayName: 'ghost' },
          toAgentId: agentB,
          question: 'hi',
          timeoutMs: 10
        },
        { runtime: workerRuntime }
      )
    ).rejects.toMatchObject({ code: 'unauthenticated_lane' })
  })

  it('R1: orchestration.ask with `to` but no `host` never relays — stays local-only (backward compatible)', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const relaySpy = vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer')
    const agentLocal = await registerAgent(homeRuntime, 'local-answerer', evidenceB)
    await call(
      'orchestration.ask',
      { to: `agent:${agentLocal}`, question: 'local question', timeoutMs: 10 },
      homeCtx(evidenceA)
    )
    expect(relaySpy).not.toHaveBeenCalled()
  })

  it('R5: an old CLI hitting orchestration.ask directly over a paired link (no local pane) gets an upgrade hint; a plain local unattested caller does not', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    // Simulates a pre-S10-8 CLI that still opened a remote client and called `orchestration.ask`
    // directly on B — B sees a paired-runtime caller with no attested local pane.
    await expect(
      call(
        'orchestration.ask',
        { to: `agent:${agentB}`, question: 'hi', timeoutMs: 10 },
        {
          runtime: workerRuntime,
          pairedDeviceId: HOME_LINK_DEVICE_ID,
          clientKind: 'runtime'
        }
      )
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: expect.objectContaining({
        nextSteps: expect.arrayContaining([expect.stringContaining('update Orca')])
      })
    })

    // A plain unattested LOCAL caller (no paired link at all) gets the ordinary sentence only.
    const plainRejection = await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, question: 'hi', timeoutMs: 10 },
      { runtime: workerRuntime }
    ).catch((error: unknown) => error)
    expect(plainRejection).toMatchObject({ code: 'no_pane_identity' })
    const nextSteps = (plainRejection as { data?: { nextSteps?: string[] } }).data?.nextSteps ?? []
    expect(nextSteps.some((step) => step.includes('update Orca'))).toBe(false)
  })

  it('S10-8 review fix (blocker): a caller quarantined on the ASKING host is refused before the relay reaches the peer', async () => {
    setup()
    const agentA = await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    await call('orchestration.agents.quarantine', { id: agentA }, homeCtx(evidenceA))
    const relaySpy = vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer')

    await expect(
      call(
        'orchestration.ask',
        { to: `agent:${agentB}`, host: 'windows', question: 'hi', timeoutMs: 10 },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'agent_quarantined' })

    expect(relaySpy).not.toHaveBeenCalled()
    expect(findPendingPeerQuestion(workerDb, { allowNone: true })).toBeUndefined()
  })

  it("S10-8 review fix (blocker): the origin host's quarantine assertion (fromAgent.quarantined) is honored independently on the receiving host", async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000001', displayName: 'ghost', quarantined: true },
          toAgentId: agentB,
          question: 'hi',
          timeoutMs: 10
        },
        workerLinkCtx()
      )
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
    const [row] = workerDb.listRemoteAgents({ includeQuarantined: true })
    expect(row).toMatchObject({ remote_quarantined: 1 })
  })

  it('S10-8 review fix (major): a relayed sender id colliding with a LOCAL agent on the receiving host is refused, never stamped into remote_agents', async () => {
    setup()
    const localAgentOnWorker = await registerAgent(workerRuntime, 'trusted-lead', evidenceB)
    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: localAgentOnWorker, displayName: 'trusted-lead' },
          toAgentId: localAgentOnWorker,
          question: 'hi',
          timeoutMs: 10
        },
        workerLinkCtx()
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(workerDb.listRemoteAgents({ includeQuarantined: true })).toHaveLength(0)
  })

  it('S10-8 review fix (major): a peer-asserted host label of exactly the local sentinel is never stored verbatim', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    await call(
      'orchestration.federatedAsk',
      {
        fromAgent: { id: 'agt_000000000002', displayName: 'sneaky', host: 'local' },
        toAgentId: agentB,
        question: 'hi',
        timeoutMs: 5
      },
      workerLinkCtx()
    )
    const [row] = workerDb.listRemoteAgents({ includeQuarantined: true })
    expect(row.environment_name).not.toBe('local')
    expect(row.environment_name).toBe(HOME_LINK_DEVICE_ID)
  })

  it('S10-8 review fix (blocker): every relayed refusal writes an agent_audit row and carries nextSteps', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    const before = countFederatedAskAudits(workerDb)

    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000001', displayName: 'ghost' },
          toAgentId: agentB,
          question: 'hi',
          timeoutMs: 10
        },
        { runtime: workerRuntime }
      )
    ).rejects.toMatchObject({
      code: 'unauthenticated_lane',
      data: expect.objectContaining({ nextSteps: expect.arrayContaining([expect.any(String)]) })
    })

    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'not-a-real-id', displayName: 'ghost' },
          toAgentId: agentB,
          question: 'hi',
          timeoutMs: 10
        },
        workerLinkCtx()
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: expect.objectContaining({ nextSteps: expect.arrayContaining([expect.any(String)]) })
    })

    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000003', displayName: '_' },
          toAgentId: agentB,
          question: 'hi',
          timeoutMs: 10
        },
        workerLinkCtx()
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: expect.objectContaining({ nextSteps: expect.arrayContaining([expect.any(String)]) })
    })

    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000004', displayName: 'ok-name' },
          toAgentId: 'agt_deadbeef0000',
          question: 'hi',
          timeoutMs: 10
        },
        workerLinkCtx()
      )
    ).rejects.toMatchObject({ code: 'agent_unknown' })

    expect(countFederatedAskAudits(workerDb)).toBe(before + 4)
  })

  it('S10-8 review fix (major, R4): a timed-out cross-host question is closed, so a late reply is refused instead of vanishing silently', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    const asked = (await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, host: 'windows', question: 'anyone home?', timeoutMs: 10 },
      homeCtx(evidenceA)
    )) as { timedOut: boolean }
    expect(asked.timedOut).toBe(true)

    // The question is CLOSED now, not left pending forever.
    expect(findPendingPeerQuestion(workerDb, { allowNone: true })).toBeUndefined()
    const closedId = findLatestPeerQuestion(workerDb).message_id

    await expect(
      call(
        'orchestration.reply',
        { id: closedId, body: 'sorry, saw this late' },
        workerLocalCtx(evidenceB)
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })

  it('S10-8 review fix (blocker: dedup): orchestration.federatedAsk is a registered mutation, and a retried relay coalesces instead of minting a duplicate question', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    expect(isOrchestrationMutation('orchestration.federatedAsk', {})).toBe(true)

    const executor = getOrchestrationMutationExecutor(workerRuntime)
    const request = {
      id: 'relay-req-1',
      authToken: 'link-token',
      method: 'orchestration.federatedAsk',
      orchestrationRequestId: 'relay_ask_fixed_1'
    } as RpcRequest
    const params = {
      fromAgent: { id: 'agt_000000000005', displayName: 'retrying-asker' },
      toAgentId: agentB,
      question: 'are you there?',
      timeoutMs: 15
    }
    const invoke = (mutation?: DurableMutationInvocation) =>
      call('orchestration.federatedAsk', params, {
        ...workerLinkCtx(),
        orchestrationMutation: mutation?.identity,
        recordMutationReceipt: mutation?.recordReceipt
      })

    const first = (await executor.run(request, params, invoke)) as {
      messageId: string
      timedOut: boolean
      mutation?: { replayed: boolean }
    }
    expect(first.timedOut).toBe(true)

    // A retry with the SAME orchestrationRequestId — the whole point of the fix — must not
    // re-run the handler (no second real wait, no second question).
    const second = (await executor.run(request, params, invoke)) as {
      messageId: string
      timedOut: boolean
      mutation?: { replayed: boolean }
    }
    expect(second.messageId).toBe(first.messageId)
    expect(second.mutation?.replayed).toBe(true)

    expect(countPeerQuestions(workerDb)).toBe(1)
  })

  // S10-15 ruling 2 (finding 4): new coverage, not a modification of any test above.
  it('S10-15 ruling 2: a link that previously spoke with one fingerprint is refused when it asserts a different one', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    // First contact binds HOME_LINK_FINGERPRINT to HOME_LINK_DEVICE_ID.
    await call(
      'orchestration.federatedAsk',
      {
        fromAgent: { id: 'agt_000000000006', displayName: 'first-contact' },
        toAgentId: agentB,
        question: 'first',
        timeoutMs: 10
      },
      workerLinkCtx()
    )
    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000007', displayName: 'second-contact' },
          toAgentId: agentB,
          question: 'second',
          timeoutMs: 10
        },
        {
          runtime: workerRuntime,
          pairedDeviceId: HOME_LINK_DEVICE_ID,
          clientKind: 'runtime',
          authenticatedCallerFingerprint: 'fp_rotated_impostor'
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(workerDb.hasRemoteAgent(HOME_LINK_DEVICE_ID, 'agt_000000000007')).toBe(false)
  })

  it('S10-15 ruling 2: a fingerprint already bound to a different link is refused on the second link (cross-link duplicate)', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    await call(
      'orchestration.federatedAsk',
      {
        fromAgent: { id: 'agt_000000000008', displayName: 'link-one-peer' },
        toAgentId: agentB,
        question: 'from link one',
        timeoutMs: 10
      },
      workerLinkCtx()
    )
    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_000000000009', displayName: 'link-two-peer' },
          toAgentId: agentB,
          question: 'from link two',
          timeoutMs: 10
        },
        {
          runtime: workerRuntime,
          pairedDeviceId: 'dev_home_link_2',
          clientKind: 'runtime',
          authenticatedCallerFingerprint: HOME_LINK_FINGERPRINT
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(workerDb.hasRemoteAgent('dev_home_link_2', 'agt_000000000009')).toBe(false)
  })
})

function findPendingPeerQuestion(
  db: OrchestrationDb,
  options?: { allowNone: true }
): { message_id: string } {
  const row = (
    db as unknown as {
      db: { prepare: (sql: string) => { get: () => { message_id: string } | undefined } }
    }
  ).db
    .prepare(
      `SELECT message_id FROM question_threads WHERE run_id = '${PEER_RUN_ID}' AND status = 'pending' ORDER BY rowid DESC LIMIT 1`
    )
    .get()
  if (!row) {
    if (options?.allowNone) {
      return undefined as unknown as { message_id: string }
    }
    throw new Error('no pending peer question found')
  }
  return row
}

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown }
} {
  return (
    db as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }
  ).db
}

function findLatestPeerQuestion(db: OrchestrationDb): { message_id: string } {
  const row = rawDb(db)
    .prepare(
      `SELECT message_id FROM question_threads WHERE run_id = '${PEER_RUN_ID}' ORDER BY rowid DESC LIMIT 1`
    )
    .get() as { message_id: string } | undefined
  if (!row) {
    throw new Error('no peer question found')
  }
  return row
}

function countPeerQuestions(db: OrchestrationDb): number {
  const row = rawDb(db)
    .prepare(`SELECT COUNT(*) AS n FROM question_threads WHERE run_id = '${PEER_RUN_ID}'`)
    .get() as { n: number }
  return row.n
}

function countFederatedAskAudits(db: OrchestrationDb): number {
  const row = rawDb(db)
    .prepare(`SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'federatedAsk'`)
    .get() as { n: number }
  return row.n
}
