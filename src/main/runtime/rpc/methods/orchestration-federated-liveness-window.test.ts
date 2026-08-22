import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

// Why its own file rather than the federation suite: the claim under test is that the window never
// leaves the home, so it has to observe the exact params handed to the peer.
describe('federated worker liveness window', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let forwarded: Record<string, unknown>[]

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    forwarded = []
    const peerRuntime = new OrcaRuntimeService()
    const capabilities = [...(peerRuntime.getStatus().capabilities ?? [])]
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
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
        forwarded.push({ method, params: params as Record<string, unknown> })
        return {
          id: 'attach',
          ok: true,
          _meta: { runtimeId: peerRuntime.getRuntimeId() },
          result: {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: peerRuntime.getRuntimeId(),
            worktreeId: 'repo::windows-worktree',
            terminalHandle: 'term_windows_worker',
            setup: { state: 'not_applicable' },
            effects: [],
            residualResources: []
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
      objective: 'Federated liveness',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
  })

  afterEach(() => {
    runtime.stopDispatchLivenessMonitor()
    runtime.stopOrchestrationFederationRelay()
    vi.restoreAllMocks()
    db.close()
  })

  async function startFederatedWorker(overrides: Record<string, unknown>) {
    const taskId = db.createTask({ spec: 'remote audit', runId }).id
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const result = (await method.handler(
      method.params!.parse({
        task: taskId,
        from: 'term_coord',
        on: 'windows',
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: 'windows-audit',
        agent: 'codex',
        ...overrides
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request_windows_worker',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      } as never
    )) as { state: string; dispatchId: string }
    expect(result.state).toBe('ready')
    return result
  }

  it('records the window at home and keeps it out of the peer attach', async () => {
    const started = await startFederatedWorker({ livenessWindowMs: 45 * 60_000 })

    expect(
      JSON.parse(db.getWorkerDispatch(started.dispatchId)?.start_options ?? '{}')
    ).toMatchObject({ livenessWindowMs: 45 * 60_000 })
    const attach = forwarded.filter(
      (entry) => entry.method === 'orchestration.federationAttachStart'
    )
    expect(attach).toHaveLength(1)
    expect(attach[0].params).not.toHaveProperty('livenessWindowMs')
  })

  it('sends nothing about the window when the coordinator did not ask for one', async () => {
    const started = await startFederatedWorker({})

    expect(
      JSON.parse(db.getWorkerDispatch(started.dispatchId)?.start_options ?? '{}')
    ).not.toHaveProperty('livenessWindowMs')
    expect(
      forwarded.every((entry) => !JSON.stringify(entry.params).includes('livenessWindowMs'))
    ).toBe(true)
  })
})
