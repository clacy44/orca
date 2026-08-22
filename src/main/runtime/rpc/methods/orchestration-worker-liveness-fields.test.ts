import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { summarizeDispatchHeartbeat } from '../../orchestration/dispatch-heartbeat-age'
import { ORCHESTRATION_METHODS } from './orchestration'

type WorkerShowLiveness = {
  lastHeartbeatAt?: string
  heartbeatAgeMs?: number
  dispatchMailbox: { unread: number; deliverable: boolean }
}

type WorkerListLiveness = {
  workers: { dispatchId: string; lastHeartbeatAt?: string; heartbeatAgeMs?: number }[]
}

describe('summarizeDispatchHeartbeat', () => {
  const now = Date.parse('2026-08-21T12:00:00Z')

  it('reads the SQLite space format as UTC', () => {
    expect(summarizeDispatchHeartbeat('2026-08-21 11:45:00', now)).toEqual({
      lastHeartbeatAt: '2026-08-21T11:45:00.000Z',
      heartbeatAgeMs: 15 * 60 * 1000
    })
  })

  it('reads the offset-bearing ISO the send path writes', () => {
    expect(summarizeDispatchHeartbeat('2026-08-21T13:45:00+02:00', now)).toEqual({
      lastHeartbeatAt: '2026-08-21T11:45:00.000Z',
      heartbeatAgeMs: 15 * 60 * 1000
    })
  })

  it('agrees across both formats for the same instant', () => {
    expect(summarizeDispatchHeartbeat('2026-08-21 11:45:00', now)).toEqual(
      summarizeDispatchHeartbeat('2026-08-21T11:45:00.000Z', now)
    )
  })

  it('reports nothing at all rather than an age of zero when there is no heartbeat', () => {
    expect(summarizeDispatchHeartbeat(null, now)).toEqual({})
    expect(summarizeDispatchHeartbeat('not a timestamp', now)).toEqual({})
  })
})

describe('worker-show and worker-list liveness fields', () => {
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

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), { runtime })
  }

  function createReadyWorker() {
    const run = db.createRun({
      objective: 'Liveness',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'report liveness', runId: run.id })
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
    return { run, dispatchId: started.dispatch.id }
  }

  it('omits the liveness fields for a Dispatch that never heartbeated', async () => {
    const { dispatchId } = createReadyWorker()

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(shown).not.toHaveProperty('lastHeartbeatAt')
    expect(shown).not.toHaveProperty('heartbeatAgeMs')
  })

  it('reports an age from a space-format heartbeat', async () => {
    const { dispatchId } = createReadyWorker()
    const at = new Date(Date.now() - 90_000).toISOString()
    db.recordHeartbeat(dispatchId, `${at.slice(0, 19).replace('T', ' ')}`)

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(shown.lastHeartbeatAt).toBe(`${at.slice(0, 19)}.000Z`)
    expect(shown.heartbeatAgeMs).toBeGreaterThanOrEqual(89_000)
    expect(shown.heartbeatAgeMs).toBeLessThan(120_000)
  })

  it('reports an age from an offset-bearing ISO heartbeat', async () => {
    const { dispatchId } = createReadyWorker()
    db.recordHeartbeat(dispatchId, new Date(Date.now() - 90_000).toISOString())

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(shown.heartbeatAgeMs).toBeGreaterThanOrEqual(89_000)
    expect(shown.heartbeatAgeMs).toBeLessThan(120_000)
  })

  it('counts unread dispatch mail as deliverable while the Dispatch is live', async () => {
    const { run, dispatchId } = createReadyWorker()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'follow-up',
      runId: run.id
    })

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(shown.dispatchMailbox).toEqual({ unread: 1, deliverable: true })
  })

  it('reports a settled Dispatch as undeliverable with its unread count intact', async () => {
    const { run, dispatchId } = createReadyWorker()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'stranded',
      runId: run.id
    })
    db.failDispatch(dispatchId, 'worker gave up')

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(shown.dispatchMailbox).toEqual({ unread: 1, deliverable: false })
  })

  it('stays terse for a healthy worker with an empty mailbox', async () => {
    const { dispatchId } = createReadyWorker()

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(shown.dispatchMailbox).toEqual({ unread: 0, deliverable: true })
  })

  it('leaves the unread count intact when the worker only peeks', async () => {
    const { run, dispatchId } = createReadyWorker()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'follow-up',
      runId: run.id
    })

    const peeked = (await call('orchestration.check', {
      terminal: 'term_worker',
      peek: true,
      unread: false
    })) as { count: number }
    const afterPeek = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(peeked.count).toBe(1)
    expect(afterPeek.dispatchMailbox).toEqual({ unread: 1, deliverable: true })

    // Positive control: an ordinary check consumes what the peek deliberately left behind.
    await call('orchestration.check', { terminal: 'term_worker' })
    const afterRead = (await call('orchestration.workerShow', {
      dispatch: dispatchId
    })) as WorkerShowLiveness

    expect(afterRead.dispatchMailbox).toEqual({ unread: 0, deliverable: true })
  })

  it('carries the same age on worker-list rows', async () => {
    const { run, dispatchId } = createReadyWorker()
    db.recordHeartbeat(dispatchId, new Date(Date.now() - 60_000).toISOString())

    const listed = (await call('orchestration.workerList', { run: run.id })) as WorkerListLiveness
    const row = listed.workers.find((worker) => worker.dispatchId === dispatchId)

    expect(row?.heartbeatAgeMs).toBeGreaterThanOrEqual(59_000)
    expect(row?.lastHeartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('omits the age on worker-list rows that never heartbeated', async () => {
    const { run, dispatchId } = createReadyWorker()

    const listed = (await call('orchestration.workerList', { run: run.id })) as WorkerListLiveness
    const row = listed.workers.find((worker) => worker.dispatchId === dispatchId)

    expect(row).not.toHaveProperty('lastHeartbeatAt')
    expect(row).not.toHaveProperty('heartbeatAgeMs')
  })
})

describe('federated worker-show result shape', () => {
  const databases: OrchestrationDb[] = []
  const runtimes: OrcaRuntimeService[] = []

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.stopOrchestrationFederationRelay()
    }
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createFederatedDispatch() {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    runtimes.push(runtime)
    const run = db.createRun({
      objective: 'Federated liveness',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId(),
      federation: {
        environmentId: 'environment_peer',
        environmentName: 'peer',
        peerFingerprint: 'peer_fingerprint',
        protocolVersion: 1
      }
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_peer',
      name: 'peer',
      peerFingerprint: 'peer_fingerprint'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeEpoch: 'peer_epoch',
      attachment: {
        state: 'ready',
        stage: 'input_accepted',
        last_error: null,
        worktree_id: 'repo::remote-worktree',
        terminal_handle: 'term_remote_worker',
        setup_state: 'not_applicable',
        effects: [],
        residualResources: []
      },
      terminal: { handle: 'term_remote_worker', connected: true },
      observation: { status: 'running', exactWorker: true }
    })
    return { db, runtime, dispatchId: started.dispatch.id }
  }

  function workerShow(runtime: OrcaRuntimeService, dispatchId: string) {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.workerShow')
    if (!method) {
      throw new Error('workerShow method is not registered')
    }
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime } as never)
  }

  it('keeps every pre-tranche key and adds the liveness fields only when they exist', async () => {
    const { runtime, dispatchId } = createFederatedDispatch()

    const shown = (await workerShow(runtime, dispatchId)) as Record<string, unknown>

    expect(Object.keys(shown).sort()).toEqual([
      'dispatch',
      'observation',
      'remoteRuntimeEpoch',
      'server',
      'sync',
      'terminal',
      'worker',
      'workerMail'
    ])
    expect(shown).not.toHaveProperty('lastHeartbeatAt')
    expect(shown).not.toHaveProperty('heartbeatAgeMs')
  })

  it('adds only the two liveness keys once the Dispatch has heartbeated', async () => {
    const { db, runtime, dispatchId } = createFederatedDispatch()
    db.recordHeartbeat(dispatchId, new Date(Date.now() - 60_000).toISOString())

    const shown = (await workerShow(runtime, dispatchId)) as Record<string, unknown>

    expect(Object.keys(shown).sort()).toEqual([
      'dispatch',
      'heartbeatAgeMs',
      'lastHeartbeatAt',
      'observation',
      'remoteRuntimeEpoch',
      'server',
      'sync',
      'terminal',
      'worker',
      'workerMail'
    ])
    expect(shown.observation).toEqual({ status: 'running', exactWorker: true })
  })
})
