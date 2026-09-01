// S10-15 F1 (chair ruling 7): two-runtime harness for `orchestration.send --host` relay and its
// far-side `orchestration.federatedSend` import — same shape as orchestration-federated-peer-
// ask.test.ts, minus the R8/R9 reply-route pieces (cut by ruling 7).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
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

const LINK_DEVICE_ID = 'dev_home_link_1'
const LINK_FINGERPRINT = 'fp_home_link_1'
const WORKER_SERVER = { environmentId: 'env_worker_1', name: 'windows', peerFingerprint: 'fp_x' }

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

function raw(db: OrchestrationDb): {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown
    run: (...args: unknown[]) => unknown
  }
} {
  return (db as unknown as { db: ReturnType<typeof raw> }).db
}

describe('S10-15 F1 cross-host send relay (R1-R7, ruling 7)', () => {
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
      pairedDeviceId: LINK_DEVICE_ID,
      clientKind: 'runtime',
      authenticatedCallerFingerprint: LINK_FINGERPRINT
    }
  }

  let relayCalls: unknown[]

  function setup(): void {
    homeDb = new OrchestrationDb(':memory:')
    homeRuntime = new OrcaRuntimeService()
    homeRuntime.setOrchestrationDb(homeDb)
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    relayCalls = []

    for (const runtime of [homeRuntime, workerRuntime]) {
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
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
        throw new Error('unknown environment')
      }
      return WORKER_SERVER
    })
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, methodName, params) => {
        relayCalls.push(params)
        if (methodName !== 'orchestration.federatedSend') {
          throw new Error(`unexpected relay method ${methodName}`)
        }
        return call(
          'orchestration.federatedSend',
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

  it('send with host reaches the far handler and stores a row addressed agent:<Y> on the far host', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)

    const result = (await call(
      'orchestration.send',
      { to: `agent:${agentB}`, host: 'windows', subject: 'hi', body: 'hello from home' },
      homeCtx(evidenceA)
    )) as { message: { id: string }; relay: { accepted: boolean; environment: string } }

    expect(result.relay.accepted).toBe(true)
    expect(result.relay.environment).toBe('windows')

    const farRow = raw(workerDb)
      .prepare('SELECT * FROM messages WHERE to_handle = ?')
      .get(`agent:${agentB}`) as { body: string; peer_link_device_id: string } | undefined
    expect(farRow?.body).toBe('hello from home')
    expect(farRow?.peer_link_device_id).toBe(LINK_DEVICE_ID)
  })

  it('a same-id retry with matching type is an idempotent replay; a same-id collision with a DIFFERENT type refuses request_mismatch (m-1)', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    const envelope = {
      fromAgent: { id: 'agt_00000000ab01', displayName: 'peer-sender' },
      toAgentId: agentB,
      messageId: 'msg_0000000abc11',
      subject: 'hi',
      body: 'hello',
      type: 'status'
    }

    const first = (await call('orchestration.federatedSend', envelope, workerLinkCtx())) as {
      accepted: boolean
      messageId: string
    }
    expect(first.accepted).toBe(true)

    // Genuine idempotent retry: identical shape, including type -> accepted, no new row.
    const replay = (await call('orchestration.federatedSend', envelope, workerLinkCtx())) as {
      accepted: boolean
      messageId: string
    }
    expect(replay.accepted).toBe(true)
    expect(replay.messageId).toBe(first.messageId)

    // Same id, DIFFERENT type -> refused, not silently swallowed as accepted.
    await expect(
      call('orchestration.federatedSend', { ...envelope, type: 'question' }, workerLinkCtx())
    ).rejects.toMatchObject({ code: 'request_mismatch' })
  })

  it('unknown host -> remote_mailbox_unpaired, no local row written', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    const before = raw(homeDb).prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }

    await expect(
      call(
        'orchestration.send',
        { to: 'agent:agt_000000000000', host: 'nowhere', subject: 'hi' },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'remote_mailbox_unpaired' })

    const after = raw(homeDb).prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  // S10-15 finding 16 / R3: three distinct failure modes must map to three distinct codes, not
  // all collapse into remote_mailbox_unpaired.
  it('no transport at all -> server_required passthrough (not remote_mailbox_unpaired)', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    vi.spyOn(homeRuntime, 'resolveOrchestrationWorkerServer').mockImplementation(() => {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    })
    await expect(
      call(
        'orchestration.send',
        { to: 'agent:agt_000000000000', host: 'windows', subject: 'hi' },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'server_required' })
  })

  it('an ambiguous environment name -> invalid_argument passthrough (not remote_mailbox_unpaired)', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    vi.spyOn(homeRuntime, 'resolveOrchestrationWorkerServer').mockImplementation(() => {
      throw new Error('Environment name "windows" is ambiguous; use the environment id.')
    })
    await expect(
      call(
        'orchestration.send',
        { to: 'agent:agt_000000000000', host: 'windows', subject: 'hi' },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('ambiguous')
    })
  })

  it('quarantined caller -> agent_quarantined before any transport call, with an agent_audit row', async () => {
    setup()
    const callerId = await registerAgent(homeRuntime, 'asker', evidenceA)
    raw(homeDb).prepare('UPDATE agents SET quarantined = 1 WHERE id = ?').run(callerId)

    await expect(
      call(
        'orchestration.send',
        { to: 'agent:agt_000000000000', host: 'windows', subject: 'hi' },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'agent_quarantined' })

    expect(relayCalls.length).toBe(0)
    const audit = raw(homeDb)
      .prepare(
        "SELECT * FROM agent_audit WHERE verb = 'federatedSend' AND outcome = 'agent_quarantined'"
      )
      .get()
    expect(audit).toBeTruthy()
  })

  it('--to agent:<id> --host x --type worker_done -> invalid_argument', async () => {
    setup()
    await registerAgent(homeRuntime, 'asker', evidenceA)
    await expect(
      call(
        'orchestration.send',
        {
          to: 'agent:agt_000000000000',
          host: 'windows',
          subject: 'hi',
          type: 'worker_done',
          payload: JSON.stringify({ outcome: 'succeeded' })
        },
        homeCtx(evidenceA)
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('a paired-link caller cannot reach the relay branch (finding 14)', async () => {
    setup()
    await registerAgent(workerRuntime, 'answerer', evidenceB)
    await expect(
      call(
        'orchestration.send',
        { to: 'agent:agt_000000000000', host: 'windows', subject: 'hi' },
        {
          runtime: homeRuntime,
          pairedDeviceId: 'dev_x',
          clientKind: 'runtime',
          authenticatedCallerFingerprint: 'fp_x'
        }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a reply to a foreign-origin message refuses with no_return_route, never throwing an unstructured error', async () => {
    setup()
    const agentB = await registerAgent(workerRuntime, 'answerer', evidenceB)
    await call(
      'orchestration.federatedSend',
      {
        fromAgent: { id: 'agt_aaaaaaaaaaaa', displayName: 'remote-asker' },
        toAgentId: agentB,
        messageId: 'msg_aaaaaaaaaaaa',
        subject: 'hi',
        body: 'hello'
      },
      workerLinkCtx()
    )
    const imported = raw(workerDb)
      .prepare('SELECT id FROM messages WHERE id = ?')
      .get('msg_aaaaaaaaaaaa') as { id: string }

    await expect(
      call(
        'orchestration.reply',
        { id: imported.id, body: 'thanks' },
        { runtime: workerRuntime, orchestrationCompatibilityEvidence: evidenceB }
      )
    ).rejects.toMatchObject({ code: 'no_return_route' })

    // S10-15 review M-1: a refused reply must not first mark the original read — that is a
    // mutation implying acceptance ahead of a refusal that sends nothing.
    const row = raw(workerDb)
      .prepare('SELECT read FROM messages WHERE id = ?')
      .get(imported.id) as {
      read: number
    }
    expect(row.read).toBe(0)
  })
})
