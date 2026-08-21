import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('worker-show agent gate observation', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
  })

  afterEach(() => db.close())

  async function workerShow(dispatchId: string) {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerShow'
    )
    if (!method) {
      throw new Error('orchestration.workerShow is not registered')
    }
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime }) as Promise<{
      worker: { state: string }
      observation: {
        status: string
        exactWorker: boolean
        agentStatus?: string
        blockedSince?: string
      }
    }>
  }

  function createReadyWorker() {
    const run = db.createRun({
      objective: 'Gate',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'observe the gate', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch
  }

  it('reports permission with blockedSince while the worker still reads ready', async () => {
    const dispatch = createReadyWorker()
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'permission'
    })
    vi.spyOn(runtime, 'getTerminalWaitBlockedAt').mockReturnValue(
      Date.parse('2026-08-21T09:15:00Z')
    )

    await expect(workerShow(dispatch.id)).resolves.toMatchObject({
      worker: { state: 'ready' },
      observation: {
        status: 'running',
        exactWorker: true,
        agentStatus: 'permission',
        blockedSince: '2026-08-21T09:15:00.000Z'
      }
    })
  })

  it('reports working without blockedSince for a mid-task worker', async () => {
    const dispatch = createReadyWorker()
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'working'
    })
    const blockedAt = vi.spyOn(runtime, 'getTerminalWaitBlockedAt')

    const result = await workerShow(dispatch.id)

    expect(result.observation.agentStatus).toBe('working')
    expect(result.observation).not.toHaveProperty('blockedSince')
    expect(blockedAt).not.toHaveBeenCalled()
  })

  it('omits blockedSince rather than reporting zero when the gate has no stamp', async () => {
    const dispatch = createReadyWorker()
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'permission'
    })
    vi.spyOn(runtime, 'getTerminalWaitBlockedAt').mockReturnValue(0)

    const result = await workerShow(dispatch.id)

    expect(result.observation.agentStatus).toBe('permission')
    expect(result.observation).not.toHaveProperty('blockedSince')
  })

  it('renders unknown rather than a status when the runtime has no verdict', async () => {
    const dispatch = createReadyWorker()
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: false,
      status: null
    })

    const result = await workerShow(dispatch.id)

    expect(result.observation).not.toHaveProperty('agentStatus')
    expect(result.observation).not.toHaveProperty('blockedSince')
  })

  it('keeps the exited terminal path green when the status probe throws', async () => {
    const dispatch = createReadyWorker()
    vi.mocked(runtime.showTerminal).mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: false,
      status: 'exited'
    } as never)
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockRejectedValue(new Error('terminal_exited'))

    const result = await workerShow(dispatch.id)

    expect(result.observation.status).toBe('exited')
    expect(result.observation).not.toHaveProperty('agentStatus')
  })

  it('does not probe a stale handle whose process incarnation changed', async () => {
    const dispatch = createReadyWorker()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime:pty:2')
    const agentStatus = vi.spyOn(runtime, 'getTerminalAgentStatus')

    const result = await workerShow(dispatch.id)

    expect(result.observation.status).toBe('identity_changed')
    expect(result.observation).not.toHaveProperty('agentStatus')
    expect(agentStatus).not.toHaveBeenCalled()
  })

  it('never writes to the observed terminal', async () => {
    const dispatch = createReadyWorker()
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: 'permission'
    })
    vi.spyOn(runtime, 'getTerminalWaitBlockedAt').mockReturnValue(
      Date.parse('2026-08-21T09:15:00Z')
    )
    const send = vi.spyOn(runtime, 'sendTerminal')

    await workerShow(dispatch.id)

    expect(send).not.toHaveBeenCalled()
  })
})
