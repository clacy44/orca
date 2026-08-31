// S10-2 threads.invite/.join, landed with S10-3 (A3's sensitive-thread nextStep needed a real
// invite verb to point at).
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

describe('orchestration.threads.invite / .join', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.verifyOrchestrationCompatibilityCaller = (evidence) => {
      if (evidence?.terminalHandle === 'term_a' && evidence.paneKey === PANE_A) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (evidence?.terminalHandle === 'term_b' && evidence.paneKey === PANE_B) {
        return makeAuthority(PANE_B, 'term_b')
      }
      return null
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

  it('invite adds a pending participant; join flips it to accepted', async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${a}` },
      ctx(evidenceA)
    )) as {
      thread: { id: string }
    }

    const invited = (await call(
      'orchestration.threads.invite',
      { threadId: created.thread.id, agentId: b },
      ctx(evidenceA)
    )) as { participant: { invite_state: string; participant_key: string } }
    expect(invited.participant.invite_state).toBe('pending')
    expect(db.isThreadParticipant(created.thread.id, b)).toBe(true)

    const joined = (await call(
      'orchestration.threads.join',
      { threadId: created.thread.id },
      ctx(evidenceB)
    )) as { participant: { invite_state: string } }
    expect(joined.participant.invite_state).toBe('accepted')
  })

  it('invite refuses a non-participant caller', async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    const b = await registerAgent('agent-b', evidenceB)
    // a's thread with itself as the only member besides the owner — b is a non-participant.
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${a}` },
      ctx(evidenceA)
    )) as {
      thread: { id: string }
    }
    await expect(
      call(
        'orchestration.threads.invite',
        { threadId: created.thread.id, agentId: b },
        ctx(evidenceB)
      )
    ).rejects.toThrow(/not a participant/)
  })

  it('join refuses with no pending invite', async () => {
    setup()
    const a = await registerAgent('agent-a', evidenceA)
    await registerAgent('agent-b', evidenceB)
    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${a}` },
      ctx(evidenceA)
    )) as {
      thread: { id: string }
    }
    await expect(
      call('orchestration.threads.join', { threadId: created.thread.id }, ctx(evidenceB))
    ).rejects.toThrow(/no pending invite/)
  })
})
