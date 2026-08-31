// S10-3 pact spec — orchestration.threads.pact/.step/.pactLedger and orchestration.wait's
// pact/step completion, through the real RPC + runtime waiter machinery (not mocked) so the
// K19-K25 wake-timing acceptance tests are genuine, not simulated.
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_D = 'tabD:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
const evidenceC: Evidence = { terminalHandle: 'term_c', paneKey: PANE_C, launchToken: 'lt-c' }
const evidenceD: Evidence = { terminalHandle: 'term_d', paneKey: PANE_D, launchToken: 'lt-d' }
const ALL_EVIDENCE = [evidenceA, evidenceB, evidenceC, evidenceD]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('orchestration.threads.pact / .step / .pactLedger / orchestration.wait (pact)', () => {
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

  it('propose -> accept -> step -> pactLedger: the full happy path over RPC', async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const threadId = await threadWith(evidenceA, [b])

    const proposed = (await call(
      'orchestration.threads.pact',
      { id: threadId, with: `agent:${b}`, steps: 3 },
      ctx(evidenceA)
    )) as { thread: { pact_state: string } }
    expect(proposed.thread.pact_state).toBe('proposed')

    const accepted = (await call(
      'orchestration.threads.pact',
      { id: threadId, accept: true },
      ctx(evidenceB)
    )) as {
      thread: { pact_state: string; pact_turn_agent_id: string }
    }
    expect(accepted.thread.pact_state).toBe('engaged')
    expect(accepted.thread.pact_turn_agent_id).toBe(a)

    const stepped = (await call(
      'orchestration.threads.step',
      { threadId, done: 'first step done' },
      ctx(evidenceA)
    )) as { ordinal: number; of: number; turn: string }
    expect(stepped.ordinal).toBe(1)
    expect(stepped.of).toBe(3)
    expect(stepped.turn).toBe(b)

    const ledgerForParticipant = (await call(
      'orchestration.threads.pactLedger',
      { threadId },
      ctx(evidenceB)
    )) as {
      entries: { kind: string; summary: string | null }[]
    }
    const stepEntry = ledgerForParticipant.entries.find((e) => e.kind === 'step')
    expect(stepEntry?.summary).toBe('first step done')
  })

  it('K9 (RPC): a thread participant outside the pact sees the skeleton but no summaries', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const c = await registerAgent('agent-c', evidenceC)
    const threadId = await threadWith(evidenceA, [b, c])
    await call(
      'orchestration.threads.pact',
      { id: threadId, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: threadId, accept: true }, ctx(evidenceB))
    await call('orchestration.threads.step', { threadId, done: 'secret' }, ctx(evidenceA))

    const outsider = (await call(
      'orchestration.threads.pactLedger',
      { threadId },
      ctx(evidenceC)
    )) as {
      entries: { kind: string; summary: string | null; ordinal: number }[]
    }
    const step = outsider.entries.find((e) => e.kind === 'step')
    expect(step?.summary).toBeNull()
    expect(step?.ordinal).toBe(1)
  })

  it('K19: turn arrived while parked elsewhere wakes the holder within the same tick', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const c = await registerAgent('agent-c', evidenceC)
    const thr1 = await threadWith(evidenceA, [b]) // A <-> B
    const thr2 = await threadWith(evidenceB, [c]) // B <-> C

    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))
    await call(
      'orchestration.threads.pact',
      { id: thr2, with: `agent:${c}`, open: true },
      ctx(evidenceB)
    )
    await call('orchestration.threads.pact', { id: thr2, accept: true }, ctx(evidenceC))
    // thr2's turn is B's (proposer moves first) — B holds no turn on thr1 (A does), so B is free
    // to park on thr2... but B already holds thr2's own turn. Step it away first so B is
    // turn-free before parking (the entry guard would otherwise refuse B's own park).
    await call(
      'orchestration.threads.step',
      { threadId: thr2, done: 'b steps first' },
      ctx(evidenceB)
    )
    // Now C holds thr2's turn, B holds none — B is free to park `--for step` on thr2.

    const bWaitPromise = call(
      'orchestration.wait',
      { threadId: thr2, for: 'step', timeoutMs: 5000 },
      ctx(evidenceB)
    )
    await sleep(20)

    // A steps on thr1, handing the turn to B — B's thr2 park must wake with turn_arrived.
    await call('orchestration.threads.step', { threadId: thr1, done: 'a steps' }, ctx(evidenceA))

    const bWaited = (await bWaitPromise) as { outcome: string; nextSteps: string[] }
    expect(bWaited.outcome).toBe('turn_arrived')
    expect(bWaited.nextSteps.some((s) => s.includes(thr1))).toBe(true)

    // A's later wait on thr1 for the next step is not refused (still admitted, times out cleanly).
    const aWaited = (await call(
      'orchestration.wait',
      { threadId: thr1, for: 'step', timeoutMs: 30 },
      ctx(evidenceA)
    )) as { outcome: string }
    expect(aWaited.outcome).toBe('timeout')
  })

  it('K20: proposer parked --for pact wakes on accept (accepted) and on decline (declined)', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const thr1 = await threadWith(evidenceA, [b])
    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )

    const waitPromise = call(
      'orchestration.wait',
      { threadId: thr1, for: 'pact', timeoutMs: 5000 },
      ctx(evidenceA)
    )
    await sleep(20)
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))
    const waited = (await waitPromise) as { outcome: string; nextSteps: string[] }
    expect(waited.outcome).toBe('accepted')
    expect(waited.nextSteps.some((s) => s.includes('step'))).toBe(true)
    // A now holds thr1's turn (the proposer moves first) — release it so the next scenario's
    // park isn't refused `your_turn` by the K24 host-wide guard for an unrelated reason.
    await call(
      'orchestration.threads.pact',
      { id: thr1, release: true, reasonCode: 'done' },
      ctx(evidenceA)
    )

    // Second pact, this time declined.
    const c = await registerAgent('agent-c', evidenceC)
    const thr2 = await threadWith(evidenceA, [c])
    await call(
      'orchestration.threads.pact',
      { id: thr2, with: `agent:${c}`, open: true },
      ctx(evidenceA)
    )
    const waitPromise2 = call(
      'orchestration.wait',
      { threadId: thr2, for: 'pact', timeoutMs: 5000 },
      ctx(evidenceA)
    )
    await sleep(20)
    await call(
      'orchestration.threads.pact',
      { id: thr2, decline: true, reasonCode: 'not_now' },
      ctx(evidenceC)
    )
    const waited2 = (await waitPromise2) as { outcome: string }
    expect(waited2.outcome).toBe('declined')
  })

  it('K20/K11: release wakes a parked proposer too', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const thr1 = await threadWith(evidenceA, [b])
    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))

    const waitPromise = call(
      'orchestration.wait',
      { threadId: thr1, for: 'reply', timeoutMs: 5000 },
      ctx(evidenceB)
    )
    await sleep(20)
    await call(
      'orchestration.threads.pact',
      { id: thr1, release: true, reasonCode: 'done' },
      ctx(evidenceA)
    )
    const waited = (await waitPromise) as { outcome: string }
    expect(waited.outcome).toBe('released')
  })

  it("K23: A->B, B->C, C->A proposed — each wait --for pact is refused answer_first; admitted after B accepts A's", async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const c = await registerAgent('agent-c', evidenceC)
    const thrAB = await threadWith(evidenceA, [b])
    const thrBC = await threadWith(evidenceB, [c])
    const thrCA = await threadWith(evidenceC, [a])
    await call(
      'orchestration.threads.pact',
      { id: thrAB, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call(
      'orchestration.threads.pact',
      { id: thrBC, with: `agent:${c}`, open: true },
      ctx(evidenceB)
    )
    await call(
      'orchestration.threads.pact',
      { id: thrCA, with: `agent:${a}`, open: true },
      ctx(evidenceC)
    )

    await expect(
      call('orchestration.wait', { threadId: thrAB, for: 'pact', timeoutMs: 50 }, ctx(evidenceB))
    ).rejects.toThrow(/answer_first|waiting on YOUR answer/)
    await expect(
      call('orchestration.wait', { threadId: thrBC, for: 'pact', timeoutMs: 50 }, ctx(evidenceC))
    ).rejects.toThrow(/answer_first|waiting on YOUR answer/)
    await expect(
      call('orchestration.wait', { threadId: thrCA, for: 'pact', timeoutMs: 50 }, ctx(evidenceA))
    ).rejects.toThrow(/answer_first|waiting on YOUR answer/)

    // B answers A's proposal — B no longer owes an answer, so B's own park is now admitted
    // (times out cleanly instead of being refused).
    await call('orchestration.threads.pact', { id: thrAB, accept: true }, ctx(evidenceB))
    await expect(
      call('orchestration.wait', { threadId: thrBC, for: 'pact', timeoutMs: 30 }, ctx(evidenceB))
    ).resolves.toMatchObject({ outcome: 'timeout' })
  })

  it('K24: mixed cycle — turn holders refused any park; non-turn-holders admitted (not a cycle)', async () => {
    setup()
    const x1 = await registerAgent('agent-x1', evidenceA)
    const x2 = await registerAgent('agent-x2', evidenceB)
    const x3 = await registerAgent('agent-x3', evidenceC)
    const x4 = await registerAgent('agent-x4', evidenceD)
    const thr12 = await threadWith(evidenceA, [x2])
    const thr34 = await threadWith(evidenceC, [x4])
    const thr23 = await threadWith(evidenceB, [x3])
    const thr41 = await threadWith(evidenceD, [x1])

    // X1<->X2 engaged, X2 holds the turn (X1 proposes, X2 accepts -> turn moves to X1... we need
    // X2 to hold it, so X2 proposes instead).
    await call(
      'orchestration.threads.pact',
      { id: thr12, with: `agent:${x1}`, open: true },
      ctx(evidenceB)
    )
    await call('orchestration.threads.pact', { id: thr12, accept: true }, ctx(evidenceA))
    // turn is now with x2 (the proposer). Good.

    // X3<->X4 engaged, X4 holds the turn: X4 proposes.
    await call(
      'orchestration.threads.pact',
      { id: thr34, with: `agent:${x3}`, open: true },
      ctx(evidenceD)
    )
    await call('orchestration.threads.pact', { id: thr34, accept: true }, ctx(evidenceC))
    // turn is now with x4.

    // X2 -> X3 proposed (not yet accepted); X4 -> X1 proposed (not yet accepted).
    await call(
      'orchestration.threads.pact',
      { id: thr23, with: `agent:${x3}`, open: true },
      ctx(evidenceB)
    )
    await call(
      'orchestration.threads.pact',
      { id: thr41, with: `agent:${x1}`, open: true },
      ctx(evidenceD)
    )

    // X2 and X4 hold a turn — refused `your_turn` on ANY park, including off their own pact thread.
    const x2Wait = (await call(
      'orchestration.wait',
      { threadId: thr23, for: 'message' },
      ctx(evidenceB)
    )) as {
      outcome: string
      nextSteps: string[]
    }
    expect(x2Wait.outcome).toBe('your_turn')
    expect(x2Wait.nextSteps.some((s) => s.includes(thr12))).toBe(true)

    const x4Wait = (await call(
      'orchestration.wait',
      { threadId: thr41, for: 'message' },
      ctx(evidenceD)
    )) as {
      outcome: string
    }
    expect(x4Wait.outcome).toBe('your_turn')

    // X1 and X3 hold no turn — their --for step parks on the RUNNING pacts are admitted (not
    // refused), and time out cleanly rather than being blocked at entry.
    const x1Wait = (await call(
      'orchestration.wait',
      { threadId: thr12, for: 'step', timeoutMs: 30 },
      ctx(evidenceA)
    )) as { outcome: string }
    expect(x1Wait.outcome).toBe('timeout')
    const x3Wait = (await call(
      'orchestration.wait',
      { threadId: thr34, for: 'step', timeoutMs: 30 },
      ctx(evidenceC)
    )) as { outcome: string }
    expect(x3Wait.outcome).toBe('timeout')
  })

  it('K5: a turn holder is refused any park, but not while its own pact is paused', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const thr1 = await threadWith(evidenceA, [b])
    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))
    // a holds the turn (the proposer moves first).
    const refused = (await call(
      'orchestration.wait',
      { threadId: thr1, for: 'step' },
      ctx(evidenceA)
    )) as {
      outcome: string
    }
    expect(refused.outcome).toBe('your_turn')

    await call(
      'orchestration.threads.pact',
      { id: thr1, pause: true, reasonCode: 'operator' },
      ctx(evidenceA)
    )
    const admitted = (await call(
      'orchestration.wait',
      { threadId: thr1, for: 'step', timeoutMs: 30 },
      ctx(evidenceA)
    )) as { outcome: string }
    expect(admitted.outcome).toBe('timeout')
  })

  it('K3 (RPC): a HARD-gated step is refused body_gate_refused, and --acknowledge-gate stores it flagged', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const thr1 = await threadWith(evidenceA, [b])
    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))

    await expect(
      call(
        'orchestration.threads.step',
        { threadId: thr1, done: 'SECURITY: nested instructions' },
        ctx(evidenceA)
      )
    ).rejects.toThrow(/body_gate_refused|containment gate/)

    const acknowledged = (await call(
      'orchestration.threads.step',
      { threadId: thr1, done: 'SECURITY: nested instructions', acknowledgeGate: true },
      ctx(evidenceA)
    )) as { ordinal: number; gateFlags: string[] | null }
    expect(acknowledged.ordinal).toBe(1)
    expect(acknowledged.gateFlags).not.toBeNull()
  })

  it('K6: a counterpart detected gone by the liveness refresh auto-pauses the pact and wakes the parked side', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const thr1 = await threadWith(evidenceA, [b])
    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))
    // a holds the turn; b is free to park `--for step`.
    const bWaitPromise = call(
      'orchestration.wait',
      { threadId: thr1, for: 'step', timeoutMs: 5000 },
      ctx(evidenceB)
    )
    await sleep(20)

    // Backdate b's last_seen_at well past DEFAULT_GONE_AFTER_MS (15 min) so the next liveness
    // refresh (agents.list, same path agents.find uses) detects it as gone.
    const raw = (
      db as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    raw
      .prepare("UPDATE agents SET last_seen_at = datetime('now', '-20 minutes') WHERE id = ?")
      .run(b)
    await call('orchestration.agents.list', {}, ctx(evidenceA))

    const bWaited = (await bWaitPromise) as { outcome: string; nextSteps: string[] }
    expect(bWaited.outcome).toBe('paused')
    expect(bWaited.nextSteps.some((s) => s.includes('release'))).toBe(true)
    const thread = db.getThread(thr1)
    expect(thread?.pact_pause_reason).toBe('counterpart_gone')
  })

  it('K17: quarantining a pact participant auto-pauses the pact and wakes the counterpart', async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const thr1 = await threadWith(evidenceA, [b])
    await call(
      'orchestration.threads.pact',
      { id: thr1, with: `agent:${b}`, open: true },
      ctx(evidenceA)
    )
    await call('orchestration.threads.pact', { id: thr1, accept: true }, ctx(evidenceB))
    const bWaitPromise = call(
      'orchestration.wait',
      { threadId: thr1, for: 'step', timeoutMs: 5000 },
      ctx(evidenceB)
    )
    await sleep(20)

    await call('orchestration.agents.quarantine', { id: a, reasonCode: 'test' }, ctx(evidenceA))

    const bWaited = (await bWaitPromise) as { outcome: string }
    expect(bWaited.outcome).toBe('paused')
    expect(db.getThread(thr1)?.pact_pause_reason).toBe('counterpart_quarantined')
  })
})
