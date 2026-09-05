// S10-21a C11 (design §7/§8 row C11, T19): `sessionLaunchKnown` appears ONLY on the caller's own
// row in orchestration.agents.list/.get, and no launch-session field (session_id,
// launch_generation, seq, evidence) ever leaks through list/get/find JSON.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
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

const NO_LAUNCH_SESSION_FIELDS = ['session_id', 'launch_generation', 'seq', 'evidence'] as const

describe('S10-21a C11 T19: sessionLaunchKnown own-row-only + no launch-session leak', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (evidence?.terminalHandle === 'term_a' && evidence.paneKey === PANE_A) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (evidence?.terminalHandle === 'term_b' && evidence.paneKey === PANE_B) {
        return makeAuthority(PANE_B, 'term_b')
      }
      return null
    })
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

  function assertNoLaunchSessionLeak(value: unknown): void {
    const json = JSON.stringify(value)
    for (const field of NO_LAUNCH_SESSION_FIELDS) {
      expect(json).not.toContain(field)
    }
  }

  it('list: sessionLaunchKnown:true on the caller’s own row (current-generation launch row present), absent on every other row', async () => {
    setup()
    const agentAId = await registerAgent('caller-agent', evidenceA)
    const agentBId = await registerAgent('other-agent', evidenceB)
    db.recordLaunch({
      hostId: 'local',
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: 'sess-a-1',
      launchGeneration: runtime.getLaunchGenerationId(),
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      evidence: 'host_launch'
    })

    const result = (await call('orchestration.agents.list', {}, ctx(evidenceA))) as {
      agents: Record<string, unknown>[]
    }
    const rowA = result.agents.find((a) => a.id === agentAId)!
    const rowB = result.agents.find((a) => a.id === agentBId)!
    expect(rowA.sessionLaunchKnown).toBe(true)
    expect('sessionLaunchKnown' in rowB).toBe(false)
    assertNoLaunchSessionLeak(result)
  })

  it('list: sessionLaunchKnown:false on the caller’s own row when no current-generation launch row exists', async () => {
    setup()
    const agentAId = await registerAgent('caller-agent', evidenceA)
    db.recordLaunch({
      hostId: 'local',
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: 'sess-a-stale',
      launchGeneration: 'a-different-generation',
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      evidence: 'host_launch'
    })

    const result = (await call('orchestration.agents.list', {}, ctx(evidenceA))) as {
      agents: Record<string, unknown>[]
    }
    const rowA = result.agents.find((a) => a.id === agentAId)!
    expect(rowA.sessionLaunchKnown).toBe(false)
  })

  it('list: an unattested caller (no authority) gets sessionLaunchKnown on no row at all', async () => {
    setup()
    await registerAgent('caller-agent', evidenceA)
    const result = (await call('orchestration.agents.list', {}, ctx())) as {
      agents: Record<string, unknown>[]
    }
    for (const row of result.agents) {
      expect('sessionLaunchKnown' in row).toBe(false)
    }
  })

  it('get: sessionLaunchKnown appears only when the request resolves the caller’s own agent, never on someone else’s row', async () => {
    setup()
    const agentAId = await registerAgent('caller-agent', evidenceA)
    const agentBId = await registerAgent('other-agent', evidenceB)
    db.recordLaunch({
      hostId: 'local',
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: 'sess-a-1',
      launchGeneration: runtime.getLaunchGenerationId(),
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      evidence: 'host_launch'
    })

    const own = (await call('orchestration.agents.get', { id: agentAId }, ctx(evidenceA))) as {
      agent: Record<string, unknown>
    }
    expect(own.agent.sessionLaunchKnown).toBe(true)

    const other = (await call('orchestration.agents.get', { id: agentBId }, ctx(evidenceA))) as {
      agent: Record<string, unknown>
    }
    expect('sessionLaunchKnown' in other.agent).toBe(false)
    assertNoLaunchSessionLeak(own)
    assertNoLaunchSessionLeak(other)
  })

  it('find: never carries a launch-session field (no sessionLaunchKnown, no raw launch-row fields)', async () => {
    setup()
    await registerAgent('caller-agent', evidenceA)
    db.recordLaunch({
      hostId: 'local',
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: 'sess-a-1',
      launchGeneration: runtime.getLaunchGenerationId(),
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      evidence: 'host_launch'
    })

    const result = await call(
      'orchestration.agents.find',
      { query: 'caller-agent' },
      ctx(evidenceA)
    )
    const json = JSON.stringify(result)
    expect(json).not.toContain('sessionLaunchKnown')
    assertNoLaunchSessionLeak(result)
  })
})
