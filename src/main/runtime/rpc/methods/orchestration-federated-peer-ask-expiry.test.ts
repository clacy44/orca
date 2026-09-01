// S10-15 review F3: split out of orchestration-federated-peer-ask.test.ts (max-lines ratchet).
// Same two-runtime harness (see that file's own header comment for the full rationale) —
// duplicated here rather than shared, matching this codebase's established test-split
// precedent (e.g. the CLI orchestration-send-relay-disposition.test.ts split).
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

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown
    run: (...args: unknown[]) => unknown
  }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

function findPendingPeerQuestion(db: OrchestrationDb): { message_id: string } {
  const row = rawDb(db)
    .prepare(
      `SELECT message_id FROM question_threads WHERE run_id = '${PEER_RUN_ID}' AND status = 'pending' ORDER BY rowid DESC LIMIT 1`
    )
    .get() as { message_id: string } | undefined
  if (!row) {
    throw new Error('no pending peer question found')
  }
  return row
}

describe('S10-15 F3: per-ask question expiry sweep', () => {
  let homeDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerDb: OrchestrationDb
  let workerRuntime: OrcaRuntimeService

  function homeCtx(evidence?: Evidence): RpcContext {
    return { runtime: homeRuntime, orchestrationCompatibilityEvidence: evidence }
  }

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
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('timed_out'), 5))
      )
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
        throw new Error(`Unknown environment: ${selector}`)
      }
      return { environmentId: 'env_windows_1', name: 'windows', peerFingerprint: 'fp_windows_1' }
    })
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

  // PER-ASK bound (timeoutMs+grace), not the 40-min coarse fallback. created_at is backdated
  // only 12min (inside the old 40min window); expires_at is backdated to -1min — proves the
  // sweep reads expires_at, not the coarse rule.
  it('closed after ITS OWN timeoutMs + RESUME_GRACE_MS, not the 40-minute fallback', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    const asked = (await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, host: 'windows', question: 'anyone home?', timeoutMs: 10 },
      homeCtx(evidenceA)
    )) as { timedOut: boolean }
    expect(asked.timedOut).toBe(true)
    const staleRow = findPendingPeerQuestion(workerDb)

    const beforeRow = rawDb(workerDb)
      .prepare(`SELECT expires_at FROM question_threads WHERE message_id = ?`)
      .get(staleRow.message_id) as { expires_at: string | null }
    expect(beforeRow.expires_at).not.toBeNull()

    rawDb(workerDb)
      .prepare(
        `UPDATE question_threads
         SET created_at = datetime('now', '-12 minutes'), expires_at = datetime('now', '-1 minute')
         WHERE message_id = ?`
      )
      .run(staleRow.message_id)

    await call(
      'orchestration.federatedAsk',
      {
        fromAgent: { id: 'agt_00000000ee11', displayName: 'sweep-trigger' },
        toAgentId: agentB,
        question: 'triggers the sweep',
        timeoutMs: 10
      },
      workerLinkCtx()
    )

    await expect(
      call(
        'orchestration.reply',
        { id: staleRow.message_id, body: 'sorry, saw this way too late' },
        workerLocalCtx(evidenceB)
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })

  // NULL expires_at (pre-column row) falls back to the coarse rule, never un-closeable.
  it('a pre-column row (expires_at NULL) still expires via the old coarse fallback', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    const asked = (await call(
      'orchestration.ask',
      { to: `agent:${agentB}`, host: 'windows', question: 'anyone home?', timeoutMs: 10 },
      homeCtx(evidenceA)
    )) as { timedOut: boolean }
    expect(asked.timedOut).toBe(true)
    const staleRow = findPendingPeerQuestion(workerDb)

    rawDb(workerDb)
      .prepare(
        `UPDATE question_threads SET created_at = datetime('now', '-50 minutes'), expires_at = NULL WHERE message_id = ?`
      )
      .run(staleRow.message_id)

    await call(
      'orchestration.federatedAsk',
      {
        fromAgent: { id: 'agt_00000000ee12', displayName: 'sweep-trigger-2' },
        toAgentId: agentB,
        question: 'triggers the sweep',
        timeoutMs: 10
      },
      workerLinkCtx()
    )

    await expect(
      call(
        'orchestration.reply',
        { id: staleRow.message_id, body: 'sorry, saw this way too late' },
        workerLocalCtx(evidenceB)
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })
})
