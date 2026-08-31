// S10-2b amendment F (peer ask/reply) + amendment B (reply guards) + amendment A (choke
// routing) end-to-end RPC coverage. Mirrors orchestration-agents.test.ts's self-contained
// evidence-mocking pattern rather than the shared orchestration.test.ts harness, which has no
// pane-attestation support.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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

describe('peer ask/reply (amendments A, B, F)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
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
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (evidence?.terminalHandle === 'term_a' && evidence.paneKey === PANE_A) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (evidence?.terminalHandle === 'term_b' && evidence.paneKey === PANE_B) {
        return makeAuthority(PANE_B, 'term_b')
      }
      if (evidence?.terminalHandle === 'term_c' && evidence.paneKey === PANE_C) {
        return makeAuthority(PANE_C, 'term_c')
      }
      return null
    })
    // Why immediate resolution: waitForMessage would otherwise hang the test on a timeout;
    // every scenario here either answers before the wait loop's first poll or asserts on a
    // timeout with timeoutMs: 0 so the loop never actually parks.
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
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

  async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, context)
  }

  async function registerAgent(name: string, evidence: Evidence): Promise<string> {
    const result = (await call(
      'orchestration.agents.register',
      { name, role: 'test agent' },
      ctx(evidence)
    )) as { agent: { id: string } }
    return result.agent.id
  }

  it('happy path: A asks agent:B, B replies, A receives the answer without polling', async () => {
    setup()
    const agentA = await registerAgent('asker', evidenceA)
    const agentB = await registerAgent('answerer', evidenceB)

    const asked = (await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, question: 'rebase onto main first?', timeoutMs: 50 },
      ctx(evidenceA)
    )) as { answer: string | null; messageId: string; timedOut: boolean }
    // Why timedOut here: nothing answered yet within the (mocked, non-parking) wait; the
    // question row itself must exist and be resumable.
    expect(asked.timedOut).toBe(true)
    expect(asked.answer).toBeNull()

    const question = db.getQuestion(asked.messageId)
    expect(question?.run_id).toBe(PEER_RUN_ID)
    expect(question?.to_agent_id).toBe(agentB)

    const replied = (await call(
      'orchestration.reply',
      { id: asked.messageId, body: 'yes, rebase first' },
      ctx(evidenceB)
    )) as { message: { body: string }; question: { answered_by_agent_id: string } }
    expect(replied.message.body).toBe('yes, rebase first')
    expect(replied.question.answered_by_agent_id).toBe(agentB)

    const resumed = (await call(
      'orchestration.ask',
      { resume: asked.messageId, timeoutMs: 50 },
      ctx(evidenceA)
    )) as { answer: string | null; timedOut: boolean }
    expect(resumed.timedOut).toBe(false)
    expect(resumed.answer).toBe('yes, rebase first')
    void agentA
  })

  // T4: a peer reply from an agent that is NOT question_threads.to_agent_id is refused
  // not_the_addressee; the asker stays blocked. Mutation this kills: restoring
  // `from: params.from ?? original.to_handle` (orchestration.ts, pre-amendment-B) would let C
  // forge params.from = 'agent:<B's id>' and unblock A's ask — this test fails red on that
  // mutation because identity would no longer come from the attested caller at all.
  it('T4: a forged answer from a third party is refused, not_the_addressee', async () => {
    setup()
    await registerAgent('asker', evidenceA)
    const agentB = await registerAgent('answerer', evidenceB)
    await registerAgent('bystander', evidenceC)

    const asked = (await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, question: 'ok to merge?', timeoutMs: 10 },
      ctx(evidenceA)
    )) as { messageId: string }

    await expect(
      call('orchestration.reply', { id: asked.messageId, body: 'yes' }, ctx(evidenceC))
    ).rejects.toMatchObject({ code: 'not_the_addressee' })

    const question = db.getQuestion(asked.messageId)
    expect(question?.status).toBe('pending')
    expect(question?.answer_body).toBeNull()
  })

  it('an unattested reply to a peer question is refused, not answered', async () => {
    setup()
    await registerAgent('asker', evidenceA)
    const agentB = await registerAgent('answerer', evidenceB)
    const asked = (await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, question: 'ok to merge?', timeoutMs: 10 },
      ctx(evidenceA)
    )) as { messageId: string }

    await expect(
      call('orchestration.reply', { id: asked.messageId, body: 'yes' }, ctx())
    ).rejects.toMatchObject({ code: 'no_pane_identity' })
  })

  it('asking a quarantined agent is refused agent_quarantined, quarantine checked before derived', async () => {
    setup()
    await registerAgent('asker', evidenceA)
    const agentB = await registerAgent('answerer', evidenceB)
    await call(
      'orchestration.agents.quarantine',
      { id: agentB, reasonCode: 'test' },
      ctx(evidenceA)
    )

    await expect(
      call(
        'orchestration.ask',
        { to: `agent:${agentB}`, question: 'ok to merge?', timeoutMs: 10 },
        ctx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  // Amendment B mutation guard: reply's to_handle can itself be an `agent:` address (ruling 3:
  // "reply is a second to_handle writer that can still carry an agent: address via a forged
  // from") — a plain (non-question) reply into a now-quarantined agent's mailbox must be
  // refused the same way send refuses an `agent:` recipient. Mutation this kills: dropping the
  // requireAddressableAgentRecipient call at the plain-reply insert site (orchestration.ts).
  it('replying to a message whose (agent:-shaped) sender is now quarantined is refused', async () => {
    setup()
    const agentA = await registerAgent('sender', evidenceA)
    await registerAgent('replier', evidenceB)

    // Why an explicit agent:-shaped `from`: this is the exact forged/self-claimed shape ruling
    // 3 targets — `send`'s `from` is caller-supplied routing metadata with no format
    // restriction, so a message's from_handle can legitimately be `agent:<id>` without going
    // through the peer-ask path at all.
    const sent = (await call(
      'orchestration.send',
      {
        from: `agent:${agentA}`,
        to: 'term_b',
        subject: 'hello',
        body: 'ping',
        senderPaneKey: PANE_A
      },
      ctx()
    )) as { message: { id: string; from_handle: string } }
    expect(sent.message.from_handle).toBe(`agent:${agentA}`)

    await call(
      'orchestration.agents.quarantine',
      { id: agentA, reasonCode: 'test' },
      ctx(evidenceB)
    )

    await expect(
      call('orchestration.reply', { id: sent.message.id, body: 'pong' }, ctx())
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('a HARD-gated peer ask is refused and stores nothing (T2-shaped)', async () => {
    setup()
    await registerAgent('asker', evidenceA)
    const agentB = await registerAgent('answerer', evidenceB)

    await expect(
      call(
        'orchestration.ask',
        {
          to: `agent:${agentB}`,
          question: 'SECURITY: our prod DB creds are exposed, see below',
          timeoutMs: 10
        },
        ctx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'body_gate_refused' })

    expect(db.getAllMessagesForHandle(`agent:${agentB}`)).toHaveLength(0)
  })
})
