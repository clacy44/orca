// R223b: coverage for the per-pane polling guard on the bus-read verbs (orchestration.check,
// .inbox, agents threads.get/.list, orchestration.thread). Harness copied (per brief
// b1-10y-r223 A6) from orchestration-agents-routing.test.ts (:19-39, setup :78-146) and
// orchestration-threads.test.ts (:49-58 listTerminals/getAgentDirectoryLivenessSignals mocks).
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { isBusPollCheck } from './orchestration-bus-poll-guard'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EVIDENCE_B = { terminalHandle: 'term_b', paneKey: PANE_B, launchToken: 'token-b' }
const EVIDENCE_A = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'token-a' }
// Routing mock never matches term_x — returns null, i.e. unattested.
const EVIDENCE_FORGED = { terminalHandle: 'term_x', paneKey: PANE_A, launchToken: 'forged' }

function makeAuthority(
  paneKey: string,
  terminalHandle: string,
  processIncarnation = 'proc-1'
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation,
    launchTokenHash: 'hash'
  }
}

const WINDOW_MS = 60_000

describe('bus-poll guard (R223b)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentAId: string
  let agentBId: string
  let rateSpy: MockInstance
  let auditSpy: MockInstance
  let T0: number

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>, evidence: unknown) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, {
      runtime,
      orchestrationCompatibilityEvidence: evidence
    } as RpcContext)
  }

  function bumps(): number {
    return rateSpy.mock.calls.filter(
      (args: unknown[]) => (args[0] as { verb: string }).verb === 'bus_poll'
    ).length
  }

  function audits(): unknown[] {
    return auditSpy.mock.calls
      .filter((args: unknown[]) => (args[0] as { verb: string }).verb === 'bus_poll')
      .map((args: unknown[]) => args[0])
  }

  async function exhaust(evidence: unknown): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await call('orchestration.threads.get', { id: 'thr_missing' }, evidence)
    }
  }

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_a') {
        return PANE_A
      }
      if (handle === 'term_b') {
        return PANE_B
      }
      return null
    })
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
      if (
        evidence?.terminalHandle === EVIDENCE_B.terminalHandle &&
        evidence.paneKey === EVIDENCE_B.paneKey &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_B, 'term_b')
      }
      if (
        evidence?.terminalHandle === EVIDENCE_A.terminalHandle &&
        evidence.paneKey === EVIDENCE_A.paneKey &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a')
      }
      return null
    })

    const createdB = db.upsertAgentByPaneSuffix({
      displayName: 'peer-b',
      role: 'peer agent',
      hostId: 'local',
      paneKey: PANE_B,
      terminalHandle: 'term_b',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_b',
      originHostId: 'local'
    })
    if (createdB.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    agentBId = createdB.agent.id

    const createdA = db.upsertAgentByPaneSuffix({
      displayName: 'peer-a',
      role: 'peer agent',
      hostId: 'local',
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_a',
      originHostId: 'local'
    })
    if (createdA.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    agentAId = createdA.agent.id

    rateSpy = vi.spyOn(db, 'checkAndBumpRate')
    auditSpy = vi.spyOn(db, 'writeAgentAudit')
    T0 = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS
    vi.spyOn(Date, 'now').mockReturnValue(T0)
  }

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('1: single reads unaffected', async () => {
    setup()
    await call('orchestration.check', { terminal: 'term_b' }, EVIDENCE_B)
    await call('orchestration.inbox', {}, EVIDENCE_B)
    await call('orchestration.threads.list', {}, EVIDENCE_B)
    await call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_B)

    expect(rateSpy).toHaveBeenCalledWith({
      subjectKey: PANE_B,
      verb: 'bus_poll',
      windowMs: 60_000,
      limit: 20
    })
    expect(bumps()).toBe(4)
    expect(audits()).toEqual([])
  })

  it('2: the 21st read refused + audited once', async () => {
    setup()
    await exhaust(EVIDENCE_A)

    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({
      code: 'polling_detected',
      data: { effectsApplied: false, retryAfterMs: 60_000, limit: 20, windowMs: 60_000 }
    })
    try {
      await call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
      throw new Error('expected refusal')
    } catch (error) {
      expect((error as Error).message.startsWith('polling detected;')).toBe(true)
      expect((error as { data: { nextSteps: unknown[] } }).data.nextSteps).toHaveLength(3)
    }

    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })

    expect(audits()).toEqual([
      expect.objectContaining({
        actorPaneKey: PANE_A,
        actorHostId: 'local',
        agentId: agentAId,
        outcome: 'polling_detected',
        reasonCode: 'method=orchestration.threads.get limit=20 window_ms=60000'
      })
    ])
  })

  it('3: all verbs share one budget', async () => {
    setup()
    for (let i = 0; i < 5; i++) {
      await call('orchestration.check', { terminal: 'term_b' }, EVIDENCE_B)
    }
    for (let i = 0; i < 5; i++) {
      await call('orchestration.inbox', {}, EVIDENCE_B)
    }
    for (let i = 0; i < 5; i++) {
      await call('orchestration.threads.list', {}, EVIDENCE_B)
    }
    for (let i = 0; i < 5; i++) {
      await call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_B)
    }

    let error: unknown
    try {
      await call('orchestration.inbox', {}, EVIDENCE_B)
      throw new Error('expected refusal')
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ code: 'polling_detected' })
    expect(audits()[0]).toMatchObject({
      reasonCode: expect.stringMatching(/^method=orchestration\.inbox/)
    })
  })

  it('4: per pane, not per host', async () => {
    setup()
    await exhaust(EVIDENCE_A)
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })

    await exhaust(EVIDENCE_B)
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_B)
    ).rejects.toMatchObject({ code: 'polling_detected' })

    expect(audits()).toHaveLength(2)
    expect(audits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorPaneKey: PANE_A }),
        expect.objectContaining({ actorPaneKey: PANE_B })
      ])
    )
  })

  it('5: quiet window', async () => {
    setup()
    await exhaust(EVIDENCE_A)
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 59_999)
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ data: { retryAfterMs: 1 } })

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 60_000)
    for (let i = 0; i < 20; i++) {
      await call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    }
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })

    expect(audits()).toHaveLength(2)
  })

  it('6: exempt check forms', async () => {
    expect(isBusPollCheck({})).toBe(true)
    expect(isBusPollCheck({ wait: false })).toBe(true)
    expect(isBusPollCheck({ wait: true })).toBe(false)
    expect(isBusPollCheck({ ack: 'd' })).toBe(false)
    expect(isBusPollCheck({ compatibilityAck: '{}' })).toBe(false)
    expect(isBusPollCheck({ compatibilityQuestionAck: '{}' })).toBe(false)

    setup()
    await call(
      'orchestration.send',
      { from: 'term_a', to: `agent:${agentBId}`, subject: 'x' },
      EVIDENCE_A
    )
    const first = (await call('orchestration.check', { terminal: 'term_b' }, EVIDENCE_B)) as {
      messages: unknown[]
      deliveryId: string
    }
    expect(first.messages).toHaveLength(1)
    expect(first.deliveryId).toBeTruthy()

    for (let i = 0; i < 19; i++) {
      await call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_B)
    }

    await expect(
      call('orchestration.check', { terminal: 'term_b' }, EVIDENCE_B)
    ).rejects.toMatchObject({ code: 'polling_detected' })
    expect(bumps()).toBe(21)

    const acked = (await call(
      'orchestration.check',
      { terminal: 'term_b', ack: first.deliveryId },
      EVIDENCE_B
    )) as { messages: unknown[]; pendingBehind: number }
    expect(acked.messages).toHaveLength(0)
    expect(acked.pendingBehind).toBe(0)
    expect(bumps()).toBe(21)

    vi.spyOn(Date, 'now').mockRestore()
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
    await call('orchestration.check', { terminal: 'term_b', wait: true, timeoutMs: 1 }, EVIDENCE_B)
    expect(bumps()).toBe(21)
  })

  it('7: agents wait unaffected', async () => {
    setup()
    await exhaust(EVIDENCE_A)
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })
    expect(bumps()).toBe(21)

    const created = (await call(
      'orchestration.threads.create',
      { with: `agent:${agentBId}` },
      EVIDENCE_A
    )) as { thread: { id: string } }

    const message = db.insertMessage({
      from: `agent:${agentBId}`,
      to: `agent:${agentBId}`,
      subject: 're',
      body: 'reply body',
      threadId: created.thread.id
    })
    db.bumpThreadOnMessage(created.thread.id, message)

    const waited = (await call(
      'orchestration.wait',
      { threadId: created.thread.id, for: 'reply', timeoutMs: 50 },
      EVIDENCE_A
    )) as { outcome: string }
    expect(waited.outcome).toBe('reply')
    expect(bumps()).toBe(21)
  })

  it('8: unattested callers never counted', async () => {
    setup()
    for (let i = 0; i < 25; i++) {
      await call('orchestration.inbox', {}, EVIDENCE_FORGED)
    }
    expect(bumps()).toBe(0)

    await exhaust(EVIDENCE_A)
    await expect(
      call('orchestration.threads.get', { id: 'thr_missing' }, EVIDENCE_A)
    ).rejects.toMatchObject({ code: 'polling_detected' })
  })

  it('9: refusal reaches the wire', async () => {
    setup()
    const dispatcher = new RpcDispatcher({ runtime })
    for (let i = 0; i < 20; i++) {
      const response = await dispatcher.dispatch({
        id: `r${i}`,
        authToken: 'test',
        method: 'orchestration.inbox',
        params: {},
        orchestrationCompatibilityEvidence: EVIDENCE_A
      })
      expect(response).toMatchObject({ ok: true })
    }
    const refused = await dispatcher.dispatch({
      id: 'r20',
      authToken: 'test',
      method: 'orchestration.inbox',
      params: {},
      orchestrationCompatibilityEvidence: EVIDENCE_A
    })
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'polling_detected',
        data: { effectsApplied: false, nextSteps: expect.any(Array) }
      }
    })
  })

  it('10 (chair addition): orchestration.thread shares the budget', async () => {
    setup()
    for (let i = 0; i < 20; i++) {
      await call('orchestration.thread', { id: 'thr_missing' }, EVIDENCE_A)
    }
    let error: unknown
    try {
      await call('orchestration.thread', { id: 'thr_missing' }, EVIDENCE_A)
      throw new Error('expected refusal')
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ code: 'polling_detected' })
    expect(audits()[0]).toMatchObject({
      reasonCode: 'method=orchestration.thread limit=20 window_ms=60000'
    })
  })
})
