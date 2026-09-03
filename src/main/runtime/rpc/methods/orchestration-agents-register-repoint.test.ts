// Ruling 32 Addendum 10 (A3): orchestration.agents.register's RPC wiring for the mailbox
// repoint db.upsertAgentByPaneSuffix now performs — the count comes back on the result, and a
// nonzero count wakes the fresh agent:<id> mailbox (`runtime.notifyMessageArrived`).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_AGENT_METHODS } from './orchestration-agents'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeAuthority(): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey: PANE_A,
    terminalHandle: 'term_a',
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_a',
    ptyId: 'pty-a',
    worktreeId: 'wt_1',
    worktreePath: '/repo/alpha',
    branch: 'alpha',
    tabId: 'tabA',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'alpha work',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('orchestration.agents.register: mailbox repoint wiring (Ruling 32 Addendum 10 A3)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
      terminalHandle: 'term_a',
      lastAgentStatus: null,
      observedLive: true
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return makeAuthority()
      }
      return null
    })
  }

  afterEach(() => {
    db?.close()
  })

  function method(name: string) {
    const found = ORCHESTRATION_AGENT_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  const evidence = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'lt-a' }
  let ctx: RpcContext

  it('a fresh register repoints stranded bare-name mail and wakes the new mailbox', async () => {
    setup()
    ctx = { runtime, orchestrationCompatibilityEvidence: evidence }
    db.insertGatedMessage({
      from: 'someone',
      to: 'alpha',
      subject: 'stranded before registration',
      type: 'status',
      priority: 'normal'
    })
    const wake = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    const result = (await call('orchestration.agents.register', { name: 'alpha' })) as {
      agent: { id: string }
      created: boolean
      repointedMessages: number
    }
    expect(result.created).toBe(true)
    expect(result.repointedMessages).toBe(1)
    expect(wake).toHaveBeenCalledWith(`agent:${result.agent.id}`, 'status', null, null)

    const moved = db.getMessageById(
      (
        db
          .getUnreadMessages(`agent:${result.agent.id}`)
          .find((m) => m.subject === 'stranded before registration') ?? { id: '' }
      ).id
    )
    expect(moved?.to_handle).toBe(`agent:${result.agent.id}`)
  })

  it('a register with nothing stranded returns 0 and never wakes the mailbox', async () => {
    setup()
    ctx = { runtime, orchestrationCompatibilityEvidence: evidence }
    const wake = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    const result = (await call('orchestration.agents.register', { name: 'beta' })) as {
      repointedMessages: number
    }
    expect(result.repointedMessages).toBe(0)
    expect(wake).not.toHaveBeenCalled()
  })
})
