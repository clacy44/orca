// S10-2b thread directory + orchestration.wait RPC coverage.
import { afterEach, describe, expect, it, vi } from 'vitest'
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
// A relaunch, not a moved tab: a brand-new leaf suffix — the S10-11 THE ONE BUG case.
const PANE_A_RELAUNCH = 'tabA9:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
const evidenceARelaunch: Evidence = {
  terminalHandle: 'term_a_relaunched',
  paneKey: PANE_A_RELAUNCH,
  launchToken: 'lt-a'
}

describe('orchestration.threads.* / orchestration.wait', () => {
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
      if (
        evidence?.terminalHandle === 'term_a_relaunched' &&
        evidence.paneKey === PANE_A_RELAUNCH
      ) {
        return makeAuthority(PANE_A_RELAUNCH, 'term_a_relaunched')
      }
      return null
    })
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

  it('threads.create mints a thread with the caller as owner and named agents as members', async () => {
    setup()
    const agentA = await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)

    const created = (await call(
      'orchestration.threads.create',
      { subject: 'merge plan', with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as {
      thread: { id: string; subject: string }
      participants: { participant_key: string; role: string }[]
    }

    expect(created.thread.subject).toBe('merge plan')
    expect(created.participants).toHaveLength(2)
    expect(created.participants.find((p) => p.participant_key === agentA)?.role).toBe('owner')
    expect(created.participants.find((p) => p.participant_key === agentB)?.role).toBe('member')
  })

  it('threads.create refuses an unknown or quarantined --with agent', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    await expect(
      call('orchestration.threads.create', { with: 'agent:nope' }, ctx(evidenceA))
    ).rejects.toMatchObject({ code: 'agent_unknown' })

    const agentB = await registerAgent('agent-b', evidenceB)
    await call('orchestration.agents.quarantine', { id: agentB, reasonCode: 'x' }, ctx(evidenceA))
    await expect(
      call('orchestration.threads.create', { with: `agent:${agentB}` }, ctx(evidenceA))
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('threads.get returns the full replay for a participant and the participant list', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    const message = db.insertMessage({
      from: `agent:${agentB}`,
      to: `agent:${agentB}`,
      subject: 'hi',
      body: 'hi there',
      threadId: created.thread.id
    })
    db.bumpThreadOnMessage(created.thread.id, message)

    const got = (await call(
      'orchestration.threads.get',
      { id: created.thread.id },
      ctx(evidenceA)
    )) as { messages: { body: string }[]; degraded: boolean; participants: unknown[] }
    expect(got.degraded).toBe(false)
    expect(got.messages.map((m) => m.body)).toEqual(['hi there'])
    expect(got.participants).toHaveLength(2)
  })

  it('threads.list only returns threads the caller participates in', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    await registerAgent('agent-c', evidenceC)
    await call(
      'orchestration.threads.create',
      { subject: 'a+b', with: `agent:${agentB}` },
      ctx(evidenceA)
    )

    const listForA = (await call('orchestration.threads.list', {}, ctx(evidenceA))) as {
      threads: { subject: string }[]
    }
    expect(listForA.threads.map((t) => t.subject)).toContain('a+b')

    const listForC = (await call('orchestration.threads.list', {}, ctx(evidenceC))) as {
      threads: unknown[]
    }
    expect(listForC.threads).toEqual([])
  })

  it('threads.leave removes the caller from the participant set', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    await call('orchestration.threads.leave', { id: created.thread.id }, ctx(evidenceA))

    const listForA = (await call('orchestration.threads.list', {}, ctx(evidenceA))) as {
      threads: unknown[]
    }
    expect(listForA.threads).toEqual([])
  })

  describe('S10-11 R1/R2/R3: identity continuity across a pane relaunch', () => {
    it('T1: dead-pane rebind on register restores threads.list, full (non-degraded) replay, and wake-eligible mail resolution', async () => {
      setup()
      const agentA = await registerAgent('agent-a', evidenceA)
      const agentB = await registerAgent('agent-b', evidenceB)
      const created = (await call(
        'orchestration.threads.create',
        { subject: 'merge plan', with: `agent:${agentB}` },
        ctx(evidenceA)
      )) as { thread: { id: string } }
      const message = db.insertMessage({
        from: `agent:${agentB}`,
        to: `agent:${agentB}`,
        subject: 'hi',
        body: 'hi there',
        threadId: created.thread.id
      })
      db.bumpThreadOnMessage(created.thread.id, message)
      db.insertMessage({ from: 'peer', to: `agent:${agentA}`, subject: 'while you were away' })

      // Default liveness mock already reads every pane as dead — agentA's old pane (PANE_A)
      // included. A same-name register from the brand-new relaunch pane should rebind, not
      // refuse: no override needed here for PANE_A to be dead, only the caller check for A.
      const rebind = (await call(
        'orchestration.agents.register',
        { name: 'agent-a', role: 'test agent' },
        ctx(evidenceARelaunch)
      )) as { agent: { id: string; paneKey: string }; created: boolean; reMinted: boolean }
      expect(rebind.created).toBe(false)
      expect(rebind.reMinted).toBe(true)
      expect(rebind.agent.id).toBe(agentA)

      // agents threads lists the old thread again, replay is full history (not degraded).
      const threads = (await call('orchestration.threads.list', {}, ctx(evidenceARelaunch))) as {
        threads: { id: string }[]
      }
      expect(threads.threads.map((t) => t.id)).toContain(created.thread.id)

      const replay = (await call(
        'orchestration.threads.get',
        { id: created.thread.id },
        ctx(evidenceARelaunch)
      )) as { degraded: boolean; messages: { body: string }[] }
      expect(replay.degraded).toBe(false)
      expect(replay.messages.map((m) => m.body)).toEqual(['hi there'])

      // Wake-eligible delivery resolves the recipient: the new pane maps to the SAME durable id.
      expect(db.getAgentByPaneKey('local', PANE_A_RELAUNCH)?.id).toBe(agentA)
      expect(db.getUnreadMessages(`agent:${agentA}`)).toHaveLength(1)
    })

    it("T3: retire then re-register from a fresh pane adopts the predecessor's thread membership", async () => {
      setup()
      const predecessor = await registerAgent('agent-a', evidenceA)
      const agentB = await registerAgent('agent-b', evidenceB)
      const created = (await call(
        'orchestration.threads.create',
        { with: `agent:${agentB}` },
        ctx(evidenceA)
      )) as { thread: { id: string } }

      await call('orchestration.agents.retire', { id: predecessor }, ctx(evidenceB))

      const successor = (await call(
        'orchestration.agents.register',
        { name: 'agent-a', role: 'take two' },
        ctx(evidenceARelaunch)
      )) as { agent: { id: string }; created: boolean; adoptedThreads: number }
      expect(successor.created).toBe(true)
      expect(successor.agent.id).not.toBe(predecessor)
      expect(successor.adoptedThreads).toBe(1)

      // Not degraded, not "no messages yet" — the successor is a full participant again.
      const replay = (await call(
        'orchestration.threads.get',
        { id: created.thread.id },
        ctx(evidenceARelaunch)
      )) as { degraded: boolean }
      expect(replay.degraded).toBe(false)
    })

    it('T4: a true outsider (never a participant, never held the name) still gets the degraded view — no widening', async () => {
      setup()
      await registerAgent('agent-a', evidenceA)
      const agentB = await registerAgent('agent-b', evidenceB)
      const created = (await call(
        'orchestration.threads.create',
        { with: `agent:${agentB}` },
        ctx(evidenceA)
      )) as { thread: { id: string } }

      const outsiderReplay = (await call(
        'orchestration.threads.get',
        { id: created.thread.id },
        ctx(evidenceARelaunch)
      )) as { degraded: boolean }
      expect(outsiderReplay.degraded).toBe(true)
    })
  })

  it('orchestration.wait resolves immediately when a new reply already exists', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    const message = db.insertMessage({
      from: `agent:${agentB}`,
      to: `agent:${agentB}`,
      subject: 're',
      body: 'reply body',
      threadId: created.thread.id
    })
    db.bumpThreadOnMessage(created.thread.id, message)

    const waited = (await call(
      'orchestration.wait',
      { threadId: created.thread.id, for: 'reply', timeoutMs: 50 },
      ctx(evidenceA)
    )) as { outcome: string; messages: { body: string }[] }
    expect(waited.outcome).toBe('reply')
    expect(waited.messages.map((m) => m.body)).toEqual(['reply body'])
  })

  // WAIT §: --for reply never returns on the caller's OWN post.
  it('orchestration.wait --for reply never resolves on the caller’s own post, only times out', async () => {
    setup()
    const agentA = await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    const own = db.insertMessage({
      from: `agent:${agentA}`,
      to: `agent:${agentB}`,
      subject: 'my own post',
      body: 'my own post',
      threadId: created.thread.id
    })
    db.bumpThreadOnMessage(created.thread.id, own)

    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
    const waited = (await call(
      'orchestration.wait',
      { threadId: created.thread.id, for: 'reply', timeoutMs: 10 },
      ctx(evidenceA)
    )) as { outcome: string; messages: unknown[] }
    expect(waited.outcome).toBe('timeout')
    expect(waited.messages).toEqual([])
  })

  it('orchestration.wait --for message DOES resolve on the caller’s own subsequent post', async () => {
    setup()
    const agentA = await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    const own = db.insertMessage({
      from: `agent:${agentA}`,
      to: `agent:${agentB}`,
      subject: 'my own post',
      body: 'my own post',
      threadId: created.thread.id
    })
    db.bumpThreadOnMessage(created.thread.id, own)

    const waited = (await call(
      'orchestration.wait',
      { threadId: created.thread.id, for: 'message', timeoutMs: 50 },
      ctx(evidenceA)
    )) as { outcome: string; messages: { body: string }[] }
    expect(waited.outcome).toBe('message')
    expect(waited.messages.map((m) => m.body)).toEqual(['my own post'])
  })

  it('orchestration.wait resumes from a resumeToken without re-serving a stale message', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    const first = db.insertMessage({
      from: `agent:${agentB}`,
      to: `agent:${agentB}`,
      subject: 'first',
      body: 'first reply',
      threadId: created.thread.id
    })
    db.bumpThreadOnMessage(created.thread.id, first)

    const waited1 = (await call(
      'orchestration.wait',
      { threadId: created.thread.id, for: 'reply', timeoutMs: 50 },
      ctx(evidenceA)
    )) as { outcome: string; resumeToken: string; messages: { body: string }[] }
    expect(waited1.messages.map((m) => m.body)).toEqual(['first reply'])

    // Resuming immediately with the returned token, with no new mail, times out — it must not
    // re-serve `first reply`.
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
    const waited2 = (await call(
      'orchestration.wait',
      {
        threadId: created.thread.id,
        for: 'reply',
        timeoutMs: 10,
        resumeToken: waited1.resumeToken
      },
      ctx(evidenceA)
    )) as { outcome: string; messages: unknown[] }
    expect(waited2.outcome).toBe('timeout')
    expect(waited2.messages).toEqual([])
  })

  it('orchestration.wait refuses a resumeToken minted for a different thread', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    await expect(
      call(
        'orchestration.wait',
        {
          threadId: created.thread.id,
          for: 'reply',
          resumeToken: 'wait_thr_someone_else_5'
        },
        ctx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('orchestration.wait refuses a non-participant', async () => {
    setup()
    await registerAgent('agent-a', evidenceA)
    const agentB = await registerAgent('agent-b', evidenceB)
    await registerAgent('agent-c', evidenceC)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentB}` },
      ctx(evidenceA)
    )) as { thread: { id: string } }

    await expect(
      call('orchestration.wait', { threadId: created.thread.id, for: 'reply' }, ctx(evidenceC))
    ).rejects.toMatchObject({ code: 'not_a_participant' })
  })
})
