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
const PANE_A_MOVED = 'tabA2:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_a',
    ptyId: 'pty-a',
    worktreeId: 'wt_1',
    worktreePath: '/repo/merge-restructure',
    branch: 'merge-restructure',
    tabId: 'tabA',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '✳ fixing the auth bug',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('orchestration.agents.* RPC methods', () => {
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
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (
        evidence?.terminalHandle === 'term_a_moved' &&
        evidence.paneKey === PANE_A_MOVED &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A_MOVED, 'term_a_moved')
      }
      if (
        evidence?.terminalHandle === 'term_b' &&
        evidence.paneKey === PANE_B &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_B, 'term_b')
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

  function ctx(evidence?: {
    terminalHandle: string
    paneKey: string
    launchToken: string
  }): RpcContext {
    return { runtime, orchestrationCompatibilityEvidence: evidence }
  }

  async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, context)
  }

  const evidenceA = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'lt-a' }
  const evidenceAMoved = {
    terminalHandle: 'term_a_moved',
    paneKey: PANE_A_MOVED,
    launchToken: 'lt-a'
  }
  const evidenceB = { terminalHandle: 'term_b', paneKey: PANE_B, launchToken: 'lt-b' }

  it('R1: register with no evidence refuses with no_pane_identity and writes zero rows', async () => {
    setup()
    await expect(
      call('orchestration.agents.register', { name: 'foo-agent' }, ctx())
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining('re-attests this pane automatically'),
          expect.stringContaining('relaunch this agent in a fresh Orca pane')
        ])
      }
    })
    expect(db.listAgents({}).agents).toHaveLength(0)
  })

  it("R2: a caller claiming another pane's terminalHandle is refused, target row untouched", async () => {
    setup()
    await call(
      'orchestration.agents.register',
      { name: 'backend-agent', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )
    const before = db.getAgentByName('local', 'backend-agent')

    // B claims A's terminalHandle in the evidence but signs with its own pane key —
    // the mock's authority function (mirroring the real one) refuses this combination.
    await expect(
      call(
        'orchestration.agents.register',
        { name: 'impersonator' },
        ctx({ terminalHandle: 'term_a', paneKey: PANE_B, launchToken: 'lt-b' })
      )
    ).rejects.toMatchObject({ code: 'no_pane_identity' })

    const after = db.getAgentByName('local', 'backend-agent')
    expect(after).toEqual(before)
  })

  it('R4: register twice from one pane is created then reMinted, same id, new terminal_handle', async () => {
    setup()
    const first = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string }; created: boolean; reMinted: boolean }
    expect(first.created).toBe(true)
    expect(first.reMinted).toBe(false)

    // Simulate a restart: same pane, terminal re-minted under a fresh handle.
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a2' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a2')
      }
      return null
    })
    const second = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx({ terminalHandle: 'term_a2', paneKey: PANE_A, launchToken: 'lt-a' })
    )) as { agent: { id: string; terminalHandle: string }; created: boolean; reMinted: boolean }
    expect(second.created).toBe(false)
    expect(second.reMinted).toBe(true)
    expect(second.agent.id).toBe(first.agent.id)
    expect(second.agent.terminalHandle).toBe('term_a2')
  })

  it('R5: pane moving tabs (tabId changes, leaf stable) still resolves to the same row', async () => {
    setup()
    const first = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string } }

    const second = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceAMoved)
    )) as { agent: { id: string }; reMinted: boolean }
    expect(second.reMinted).toBe(true)
    expect(second.agent.id).toBe(first.agent.id)
  })

  it('list: derived rows are flagged derived and ranked lower than registered rows', async () => {
    setup()
    await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_a',
          tabId: 'tabA',
          leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }),
        terminal({
          handle: 'term_b',
          tabId: 'tabB',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          branch: 'merge-restructure',
          worktreePath: '/repo/merge-restructure-2',
          title: '✳ unrelated task'
        })
      ],
      totalCount: 2,
      truncated: false
    })

    const listing = (await call('orchestration.agents.list', {}, ctx())) as {
      agents: { displayName: string; derived: boolean }[]
      derivedCount: number
    }
    expect(listing.derivedCount).toBe(1)
    const registered = listing.agents.find((a) => a.displayName === 'merge-backend')
    const derived = listing.agents.find((a) => a.derived)
    expect(registered?.derived).toBe(false)
    expect(derived).toBeDefined()
    expect(derived?.displayName.startsWith('merge-restructure-')).toBe(true)
  })

  it('find: resolved / ambiguous / no_match outcomes never auto-address', async () => {
    setup()
    await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )
    const resolved = (await call(
      'orchestration.agents.find',
      { query: 'the merge-restructure backend agent' },
      ctx()
    )) as { outcome: string; candidates: unknown[] }
    expect(resolved.outcome).toBe('resolved')
    expect(resolved.candidates.length).toBeGreaterThan(0)

    await call(
      'orchestration.agents.register',
      { name: 'merge-frontend', role: 'backend for the merge restructure' },
      ctx(evidenceB)
    )
    const ambiguous = (await call(
      'orchestration.agents.find',
      { query: 'the merge-restructure backend agent' },
      ctx()
    )) as { outcome: string; nextSteps: string[] }
    expect(ambiguous.outcome).toBe('ambiguous')
    expect(ambiguous.nextSteps.length).toBeGreaterThan(0)

    const noMatch = (await call(
      'orchestration.agents.find',
      { query: 'something completely unrelated to anything' },
      ctx()
    )) as { outcome: string; nextSteps: string[] }
    expect(noMatch.outcome).toBe('no_match')
    expect(noMatch.nextSteps).toContain('orca agents list')
  })

  it('quarantine: local caller can quarantine another agent; a federated caller cannot', async () => {
    setup()
    const registered = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string } }

    const quarantined = (await call(
      'orchestration.agents.quarantine',
      { id: registered.agent.id, reasonCode: 'suspicious' },
      { runtime, orchestrationCompatibilityEvidence: evidenceB }
    )) as { agent: { quarantined: boolean } }
    expect(quarantined.agent.quarantined).toBe(true)

    await call(
      'orchestration.agents.quarantine',
      { id: registered.agent.id, lift: true },
      { runtime, orchestrationCompatibilityEvidence: evidenceB }
    )

    await expect(
      call(
        'orchestration.agents.quarantine',
        { id: registered.agent.id, reasonCode: 'x' },
        { runtime, orchestrationCompatibilityEvidence: evidenceB, pairedDeviceId: 'device-1' }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a quarantined agent is omitted from find candidates but counted in omitted.quarantined', async () => {
    setup()
    const registered = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )) as { agent: { id: string } }
    await call(
      'orchestration.agents.quarantine',
      { id: registered.agent.id, reasonCode: 'x' },
      ctx(evidenceB)
    )
    const found = (await call(
      'orchestration.agents.find',
      { query: 'the merge-restructure backend agent' },
      ctx()
    )) as { outcome: string; omitted: { quarantined: number } }
    expect(found.outcome).toBe('no_match')
    expect(found.omitted.quarantined).toBe(1)
  })

  describe('orchestration.agents.relink (S10-4 ruling 5)', () => {
    function federatedDispatch(environmentId: string) {
      const run = db.createRun({
        objective: 'cross-host work',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const task = db.createTask({ spec: 'do the thing', runId: run.id })
      const { dispatch } = db.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        federation: {
          environmentId,
          environmentName: 'work-laptop',
          peerFingerprint: 'peer_fingerprint_1',
          protocolVersion: 3
        }
      })
      return dispatch
    }

    it('resets the relay cursors for a local caller', async () => {
      setup()
      const dispatch = federatedDispatch('env_stale')
      db.importFederatedRelayItem({
        dispatchId: dispatch.id,
        sequence: 1,
        relayKind: 'status',
        message: {
          id: 'relay_1',
          runId: dispatch.run_id,
          from: `dispatch:${dispatch.id}`,
          to: `run:${dispatch.run_id}`,
          subject: 'progress',
          body: 'still going',
          type: 'status',
          priority: 'normal'
        },
        lifecycle: { kind: 'none' }
      })
      expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(1)

      const result = (await call(
        'orchestration.agents.relink',
        { environmentId: 'env_stale' },
        ctx()
      )) as { dispatchIds: string[] }
      expect(result.dispatchIds).toEqual([dispatch.id])
      expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(0)
    })

    it('is a no-op for an environment with no active federated dispatch', async () => {
      setup()
      const result = (await call(
        'orchestration.agents.relink',
        { environmentId: 'env_unknown' },
        ctx()
      )) as { dispatchIds: string[] }
      expect(result.dispatchIds).toEqual([])
    })

    it('refuses a federated caller; the local operator can still relink afterward', async () => {
      setup()
      const dispatch = federatedDispatch('env_stale')
      await expect(
        call(
          'orchestration.agents.relink',
          { environmentId: 'env_stale' },
          { runtime, orchestrationCompatibilityEvidence: undefined, pairedDeviceId: 'device-1' }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(0)

      const result = (await call(
        'orchestration.agents.relink',
        { environmentId: 'env_stale' },
        ctx()
      )) as { dispatchIds: string[] }
      expect(result.dispatchIds).toEqual([dispatch.id])
    })
  })
})
