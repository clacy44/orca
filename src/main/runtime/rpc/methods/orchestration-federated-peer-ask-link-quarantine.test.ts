// S10-16 C2a F2/R3 (Ruling 23 Addendum 2(n)): split out of orchestration-federated-peer-ask.test.ts
// (max-lines ratchet). Same two-runtime harness (see that file's own header comment for the full
// rationale) — duplicated here rather than shared, matching this codebase's established
// test-split precedent (orchestration-federated-peer-ask-expiry.test.ts).
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

describe('S10-16 C2a F2/R3: link containment before identity on federatedAsk', () => {
  let homeDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerDb: OrchestrationDb
  let workerRuntime: OrcaRuntimeService

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

  // F2/R3 (Ruling 23 Addendum 2(n)): link containment before identity — a quarantined LINK (not
  // agent) must refuse federatedAsk before the identity importer runs, effect-free, reading
  // peer_link_containment only.
  it('R3: a quarantined link refuses federatedAsk before the identity importer runs, effect-free, with an agent_audit row', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    workerDb.putContainment({
      subjectKind: 'link',
      subjectId: HOME_LINK_DEVICE_ID,
      action: 'quarantine',
      reasonCode: 'smoke_test',
      reasonText: null,
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })

    await expect(
      call(
        'orchestration.federatedAsk',
        {
          fromAgent: { id: 'agt_00000000ac99', displayName: 'quarantined-link-asker' },
          toAgentId: agentB,
          question: 'should be refused before identity import',
          timeoutMs: 10
        },
        workerLinkCtx()
      )
    ).rejects.toMatchObject({ code: 'agent_quarantined' })

    // Effect-free: no remote_agents mirror for the asker.
    const remoteAgentRow = workerDb.listRemoteAgents({ includeQuarantined: true })
    expect(remoteAgentRow.some((r) => r.remote_agent_id === 'agt_00000000ac99')).toBe(false)

    const audit = rawDb(workerDb)
      .prepare(
        "SELECT * FROM agent_audit WHERE verb = 'federatedLink' AND outcome = 'link_quarantined'"
      )
      .get()
    expect(audit).toBeTruthy()
  })

  it('R3: an unquarantined link sees unchanged federatedAsk behaviour', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    const result = (await call(
      'orchestration.federatedAsk',
      {
        fromAgent: { id: 'agt_00000000ac98', displayName: 'ordinary-asker' },
        toAgentId: agentB,
        question: 'should proceed normally',
        timeoutMs: 10
      },
      workerLinkCtx()
    )) as { questionId?: string; threadId: string }
    expect(result.threadId).toBeTruthy()
  })
})
