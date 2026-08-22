import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROCESS_INCARNATION = 'runtime:pty:1'

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

// Why a controlled park: the marker's whole contract is "set for exactly as long as the worker is
// blocked inside the call", which is only observable from inside the wait.
function parkOnDemand(runtime: OrcaRuntimeService) {
  let enteredPark: () => void
  let releasePark: (result: 'notified' | 'timed_out') => void
  const entered = new Promise<void>((resolve) => {
    enteredPark = resolve
  })
  const parked = new Promise<'notified' | 'timed_out'>((resolve) => {
    releasePark = resolve
  })
  const wait = vi.spyOn(runtime, 'waitForMessage').mockImplementation(() => {
    enteredPark()
    return parked as ReturnType<OrcaRuntimeService['waitForMessage']>
  })
  return {
    entered,
    wait,
    release: (result: 'notified' | 'timed_out' = 'timed_out') => releasePark(result)
  }
}

describe('dispatch blocked_since marker', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE_KEY : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? PROCESS_INCARNATION : null
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function call(
    name: string,
    params: Record<string, unknown>,
    ctx?: { capability?: string; signal?: AbortSignal }
  ) {
    const method = findMethod(name)
    return method.handler(method.params!.parse(params), {
      runtime,
      orchestrationCapability: ctx?.capability,
      signal: ctx?.signal
    } as never)
  }

  function startWorker(existing?: { runId: string; taskId: string }) {
    const runId =
      existing?.runId ??
      db.createRun({
        objective: 'Blocked-marker',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      }).id
    const taskId = existing?.taskId ?? db.createTask({ spec: 'park in ask', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatchId: started.dispatch.id, runId, taskId, capability }
  }

  const blockedSince = (dispatchId: string) =>
    db.getDispatchContextById(dispatchId)?.blocked_since ?? null

  it('marks the Dispatch for exactly the check --wait park', async () => {
    const { dispatchId } = startWorker()
    const park = parkOnDemand(runtime)

    const pending = call('orchestration.check', { terminal: 'term_worker', wait: true })
    await park.entered
    expect(blockedSince(dispatchId)).toEqual(expect.any(String))

    park.release()
    await pending
    expect(blockedSince(dispatchId)).toBeNull()
  })

  it('marks the Dispatch for exactly the ask park', async () => {
    const { dispatchId, capability } = startWorker()
    const park = parkOnDemand(runtime)
    const disconnect = new AbortController()

    const pending = call(
      'orchestration.ask',
      { from: 'term_worker', question: 'which branch?', timeoutMs: 600_000 },
      { capability, signal: disconnect.signal }
    )
    await park.entered
    expect(blockedSince(dispatchId)).toEqual(expect.any(String))

    // Why abort rather than answer: the ask loop re-parks until the question settles, and the
    // marker's contract is per-park — this ends the loop without a second reply round trip.
    disconnect.abort()
    park.release()
    await pending
    expect(blockedSince(dispatchId)).toBeNull()
  })

  it('writes nothing for a check from a terminal with no active Dispatch', async () => {
    const { dispatchId } = startWorker()
    const park = parkOnDemand(runtime)

    const pending = call('orchestration.check', { terminal: 'term_stranger', wait: true })
    await park.entered
    expect(blockedSince(dispatchId)).toBeNull()

    park.release()
    await pending
    expect(blockedSince(dispatchId)).toBeNull()
  })

  it('writes nothing for a check parked from a settled Dispatch', async () => {
    const { dispatchId } = startWorker()
    db.completeDispatch(dispatchId)
    const park = parkOnDemand(runtime)

    const pending = call('orchestration.check', { terminal: 'term_worker', wait: true })
    await park.entered
    expect(blockedSince(dispatchId)).toBeNull()

    park.release()
    await pending
    expect(blockedSince(dispatchId)).toBeNull()
  })

  // Why direct: the SQL guard is the only thing standing between a late park and a settled row.
  it('refuses a direct mark on a settled Dispatch', () => {
    const { dispatchId } = startWorker()
    db.completeDispatch(dispatchId)

    db.markDispatchBlocked(dispatchId, new Date().toISOString())

    expect(blockedSince(dispatchId)).toBeNull()
  })

  it('refuses ask from a settled Dispatch without marking anything', async () => {
    const { dispatchId, capability } = startWorker()
    db.completeDispatch(dispatchId)

    await expect(
      call(
        'orchestration.ask',
        { from: 'term_worker', question: 'still there?', timeoutMs: 600_000 },
        { capability }
      )
    ).rejects.toThrow(/active supervised Dispatch/)
    expect(blockedSince(dispatchId)).toBeNull()
  })

  // Why: a straggler park from a failed dispatch must not hand the live retry an exemption.
  it('does not land on the retry row when the parked Dispatch fails and is retried', async () => {
    const first = startWorker()
    const park = parkOnDemand(runtime)

    const pending = call('orchestration.check', { terminal: 'term_worker', wait: true })
    await park.entered
    expect(blockedSince(first.dispatchId)).toEqual(expect.any(String))

    db.failDispatch(first.dispatchId, 'worker terminal died')
    const retry = startWorker({ runId: first.runId, taskId: first.taskId })
    park.release()
    await pending

    expect(retry.dispatchId).not.toBe(first.dispatchId)
    expect(blockedSince(retry.dispatchId)).toBeNull()
  })

  it('writes nothing for --peek and --all reads', async () => {
    const { dispatchId, runId } = startWorker()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'guidance',
      body: 'rebase first',
      type: 'status',
      priority: 'normal',
      runId
    })

    for (const params of [{ peek: true }, { all: true }, {}]) {
      const result = (await call('orchestration.check', {
        terminal: 'term_worker',
        ...params
      })) as { dispatchId: string }
      expect(result.dispatchId).toBe(dispatchId)
      expect(blockedSince(dispatchId)).toBeNull()
    }
  })
})

// Why pinned rather than fixed: `ask` / `check` for a federated worker execute against the PEER,
// which holds no dispatch_contexts row for the home's dispatch id, so the home's marker advances
// only through relayed heartbeats (A1 §14 asymmetry).
describe('federated blocked_since asymmetry', () => {
  let homeDb: OrchestrationDb
  let peerDb: OrchestrationDb
  let peerRuntime: OrcaRuntimeService
  let dispatchId: string
  let capability: string

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    const homeRuntime = new OrcaRuntimeService()
    homeRuntime.setOrchestrationDb(homeDb)
    const run = homeDb.createRun({
      objective: 'Federated asymmetry',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    })
    const task = homeDb.createTask({ spec: 'park on the peer', runId: run.id })
    const started = homeDb.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_worker',
        environmentName: 'worker',
        peerFingerprint: 'worker-peer',
        protocolVersion: 2
      }
    })
    dispatchId = started.dispatch.id
    homeDb.markWorkerDispatchReady(dispatchId)

    peerDb = new OrchestrationDb(':memory:')
    peerRuntime = new OrcaRuntimeService()
    peerRuntime.setOrchestrationDb(peerDb)
    vi.spyOn(peerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE_KEY : null
    )
    vi.spyOn(peerRuntime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? PROCESS_INCARNATION : null
    )
    peerDb.createRemoteDispatchAttachment({
      dispatchId,
      taskId: task.id,
      homePeerFingerprint: 'home-peer',
      protocolVersion: 2,
      runtimeEpoch: peerRuntime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home-peer',
        requestId: 'attach-worker',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach-worker-payload'
      }
    })
    capability = peerDb.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::worker',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    homeDb.close()
    peerDb.close()
  })

  function callOnPeer(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const method = findMethod(name)
    return method.handler(method.params!.parse(params), {
      runtime: peerRuntime,
      orchestrationCapability: capability,
      signal
    } as never)
  }

  it('leaves the home marker untouched for a peer-side check --wait', async () => {
    const park = parkOnDemand(peerRuntime)

    const pending = callOnPeer('orchestration.check', { terminal: 'term_worker', wait: true })
    await park.entered
    expect(homeDb.getDispatchContextById(dispatchId)?.blocked_since ?? null).toBeNull()
    expect(peerDb.getDispatchContextById(dispatchId)).toBeUndefined()

    park.release()
    await pending
    expect(homeDb.getDispatchContextById(dispatchId)?.blocked_since ?? null).toBeNull()
  })

  it('leaves the home marker untouched for a peer-side ask', async () => {
    const park = parkOnDemand(peerRuntime)
    const disconnect = new AbortController()

    const pending = callOnPeer(
      'orchestration.ask',
      { from: 'term_worker', question: 'which branch?', timeoutMs: 600_000 },
      disconnect.signal
    )
    await park.entered
    expect(homeDb.getDispatchContextById(dispatchId)?.blocked_since ?? null).toBeNull()
    expect(peerDb.getDispatchContextById(dispatchId)).toBeUndefined()

    disconnect.abort()
    park.release()
    await pending
    expect(homeDb.getDispatchContextById(dispatchId)?.blocked_since ?? null).toBeNull()
  })
})
