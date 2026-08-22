import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS } from '../../../../shared/runtime-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { parseDispatchInputEvidence } from '../../orchestration/dispatch-input-evidence'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

// SYNTHESIZED from docs/reference/federation-live-test-findings.md F5 ("Is this a project you
// trust?" before the agent gets a turn), not captured console output.
const SYNTHESIZED_TRUST_GATE_TAIL = [
  '  OpenAI Codex',
  '',
  '  Do you trust the files in this folder?',
  '  > 1. Yes, allow Codex to run in this folder'
].join('\n')

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

describe('post-write dispatch input evidence', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? COORDINATOR_PANE_KEY
        : handle === 'term_worker'
          ? WORKER_PANE_KEY
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'pty_worker:incarnation-a' : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    runId = db.createRun({
      objective: 'Evidence',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
  })

  afterEach(() => {
    runtime.stopDispatchInputObservers()
    runtime.stopDispatchLivenessMonitor()
    runtime.stopOrchestrationFederationRelay()
    vi.restoreAllMocks()
    db.close()
  })

  async function startLocalWorker() {
    const taskId = db.createTask({ spec: 'supervised work', runId }).id
    const method = findMethod('orchestration.workerStart')
    return (await method.handler(
      method.params!.parse({ task: taskId, from: 'term_coord', agent: 'codex' }),
      { runtime } as never
    )) as {
      state: string
      stage: string
      dispatchId: string
      inputEvidence?: { submittedAt: string; blockedReason?: string }
    }
  }

  it('names the gate that was already on screen while state stays ready', async () => {
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: SYNTHESIZED_TRUST_GATE_TAIL,
      blockedReason: 'codex-trust-workspace'
    })

    const started = await startLocalWorker()

    expect(started).toMatchObject({ state: 'ready', stage: 'input_accepted' })
    expect(started.inputEvidence?.blockedReason).toBe('codex-trust-workspace')
    expect(Date.parse(started.inputEvidence?.submittedAt as string)).not.toBeNaN()
    expect(JSON.parse(db.getWorkerDispatch(started.dispatchId)?.input_evidence ?? 'null')).toEqual(
      started.inputEvidence
    )
  })

  it('carries the evidence onto the worker-show projection', async () => {
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: SYNTHESIZED_TRUST_GATE_TAIL,
      blockedReason: 'codex-trust-workspace'
    })
    const started = await startLocalWorker()
    const method = findMethod('orchestration.workerShow')

    const shown = (await method.handler(method.params!.parse({ dispatch: started.dispatchId }), {
      runtime
    } as never)) as { worker: { inputEvidence?: unknown } }

    expect(shown.worker.inputEvidence).toEqual(started.inputEvidence)
  })

  describe('negative controls', () => {
    it('records the submit alone when nothing was on screen', async () => {
      vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
        tailText: '  OpenAI Codex\n  model: gpt-5\n  directory: /repo',
        blockedReason: null
      })

      const started = await startLocalWorker()

      expect(started.inputEvidence).not.toHaveProperty('blockedReason')
      expect(started.state).toBe('ready')
    })

    it('records the submit alone when the tail could not be read at all', async () => {
      vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue(null)

      const started = await startLocalWorker()

      expect(started.inputEvidence).not.toHaveProperty('blockedReason')
    })

    it('never fails a start whose evidence read throws', async () => {
      vi.spyOn(runtime, 'getTerminalWaitEvidence').mockImplementation(() => {
        throw new Error('terminal_gone')
      })

      await expect(startLocalWorker()).resolves.toMatchObject({ state: 'ready' })
    })

    it('reads a handle that names nothing as unknown rather than throwing', () => {
      // No mock: the real zero-IO reader must survive a handle with no PTY behind it.
      expect(runtime.getTerminalWaitEvidence('term_does_not_exist')).toBeNull()
    })

    // Why the whole tuple: the persister keeps its own whitelist, so this is what proves it accepts
    // exactly the published vocabulary rather than a copy that drifted from it.
    it('accepts every shipped blockedReason', () => {
      for (const blockedReason of RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS) {
        expect(
          parseDispatchInputEvidence(
            JSON.stringify({ submittedAt: '2026-08-22T12:00:00.000Z', blockedReason })
          )
        ).toEqual({ submittedAt: '2026-08-22T12:00:00.000Z', blockedReason })
      }
    })

    it('drops a blockedReason outside the six shipped values instead of widening the union', () => {
      expect(
        parseDispatchInputEvidence(
          JSON.stringify({
            submittedAt: '2026-08-22T12:00:00.000Z',
            blockedReason: 'claude-folder-trust'
          })
        )
      ).toEqual({ submittedAt: '2026-08-22T12:00:00.000Z' })
    })

    it('reads a malformed or absent column as no evidence at all', () => {
      expect(parseDispatchInputEvidence(null)).toBeNull()
      expect(parseDispatchInputEvidence('not json')).toBeNull()
      expect(
        parseDispatchInputEvidence(JSON.stringify({ blockedReason: 'codex-cwd-prompt' }))
      ).toBeNull()
    })
  })
})

describe('federated post-write dispatch input evidence', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let peerInputEvidence: unknown

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    peerInputEvidence = {
      submittedAt: '2026-08-22T12:00:00.000Z',
      blockedReason: 'codex-trust-workspace'
    }
    const peerRuntime = new OrcaRuntimeService()
    const capabilities = [...(peerRuntime.getStatus().capabilities ?? [])]
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_peer',
        name: 'peer',
        peerFingerprint: 'peer_fingerprint'
      }),
      call: async (_selector, method, params) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: { ...peerRuntime.getStatus(), capabilities },
            _meta: { runtimeId: peerRuntime.getRuntimeId() }
          }
        }
        return {
          id: 'attach',
          ok: true,
          _meta: { runtimeId: peerRuntime.getRuntimeId() },
          result: {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: peerRuntime.getRuntimeId(),
            worktreeId: 'repo::peer-worktree',
            terminalHandle: 'term_peer_worker',
            setup: { state: 'not_applicable' },
            effects: [],
            residualResources: [],
            ...(peerInputEvidence === undefined ? {} : { inputEvidence: peerInputEvidence })
          }
        }
      }
    }
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORDINATOR_PANE_KEY : null
    )
    runId = db.createRun({
      objective: 'Federated evidence',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
  })

  afterEach(() => {
    runtime.stopDispatchInputObservers()
    runtime.stopDispatchLivenessMonitor()
    runtime.stopOrchestrationFederationRelay()
    vi.restoreAllMocks()
    db.close()
  })

  async function start() {
    const taskId = db.createTask({ spec: 'remote audit', runId }).id
    const method = findMethod('orchestration.workerStart')
    return (await method.handler(
      method.params!.parse({
        task: taskId,
        from: 'term_coord',
        on: 'peer',
        worktree: 'new-top-level',
        repo: 'id:peer-repo',
        name: 'peer-audit',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request_peer_worker',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      } as never
    )) as { state: string; dispatchId: string; inputEvidence?: { blockedReason?: string } }
  }

  it("persists the peer's evidence on the home row and receipt", async () => {
    const started = await start()

    expect(started.inputEvidence).toEqual(peerInputEvidence)
    expect(JSON.parse(db.getWorkerDispatch(started.dispatchId)?.input_evidence ?? 'null')).toEqual(
      peerInputEvidence
    )
  })

  it('leaves the field absent when an older peer sends none', async () => {
    peerInputEvidence = undefined

    const started = await start()

    expect(started).not.toHaveProperty('inputEvidence')
    expect(db.getWorkerDispatch(started.dispatchId)?.input_evidence).toBeNull()
  })

  it('drops a finer class a newer peer invented rather than storing it', async () => {
    peerInputEvidence = {
      submittedAt: '2026-08-22T12:00:00.000Z',
      blockedReason: 'peer-invented-auth-gate'
    }

    const started = await start()

    expect(started.inputEvidence).toEqual({ submittedAt: '2026-08-22T12:00:00.000Z' })
  })
})
