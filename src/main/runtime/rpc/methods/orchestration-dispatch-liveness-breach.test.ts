import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  DISPATCH_LIVENESS_SWEEP_INTERVAL_MS,
  sweepDispatchLivenessBreaches
} from '../../orchestration/dispatch-liveness-monitor'
import {
  DISPATCH_FEDERATED_LIVENESS_DEFAULT_WINDOW_MS,
  DISPATCH_LIVENESS_DEFAULT_WINDOW_MS
} from '../../orchestration/dispatch-liveness-window'
import { syncFederatedDispatch } from '../../orchestration/federation-sync'
import { ORCHESTRATION_METHODS } from './orchestration'

const MINUTE_MS = 60_000
const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROCESS_INCARNATION = 'runtime:pty:1'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

describe('per-dispatch liveness window', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let notify: ReturnType<typeof vi.spyOn>

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
      handle === 'term_worker' ? PROCESS_INCARNATION : null
    )
    notify = vi.spyOn(runtime, 'notifyMessageArrived')
    runId = db.createRun({
      objective: 'Liveness',
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

  function startWorker(options: { startOptions?: Record<string, unknown>; spec?: string } = {}) {
    const taskId = db.createTask({ spec: options.spec ?? 'long refactor', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: options.startOptions ?? {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatchId: started.dispatch.id, taskId }
  }

  function startFederatedWorker(options: { startOptions?: Record<string, unknown> } = {}) {
    const taskId = db.createTask({ spec: 'remote refactor', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: options.startOptions ?? {},
      runtimeEpoch: runtime.getRuntimeId(),
      federation: {
        environmentId: 'environment_peer',
        environmentName: 'peer',
        peerFingerprint: 'peer_fingerprint',
        protocolVersion: 1
      }
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatchId: started.dispatch.id, taskId }
  }

  function setDispatchedAt(dispatchId: string, at: string) {
    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
      .run(at, dispatchId)
  }

  function setBlockedSince(dispatchId: string, at: string | null) {
    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET blocked_since = ? WHERE id = ?')
      .run(at, dispatchId)
  }

  function sweep(now: number) {
    return sweepDispatchLivenessBreaches({ db, runtime, now })
  }

  const runMail = () => db.getRunMailboxHistory(runId, 100)
  const breachMail = () => runMail().filter((message) => message.from_handle === 'runtime')
  const minutesFromNow = (minutes: number) => Date.now() + minutes * MINUTE_MS

  it('escalates one high-priority runtime notification into the Run mailbox', () => {
    const { dispatchId, taskId } = startWorker()

    const emitted = sweep(minutesFromNow(31))

    expect(emitted).toHaveLength(1)
    const mail = breachMail()
    expect(mail).toHaveLength(1)
    expect(mail[0]).toMatchObject({
      to_handle: `run:${runId}`,
      from_handle: 'runtime',
      type: 'escalation',
      priority: 'high'
    })
    expect(JSON.parse(mail[0].payload as string)).toEqual({
      origin: 'runtime',
      kind: 'liveness_breach',
      dispatchId,
      taskId,
      lastHeartbeatAt: null,
      windowMs: DISPATCH_LIVENESS_DEFAULT_WINDOW_MS
    })
    expect(notify).toHaveBeenCalledWith(`run:${runId}`, 'escalation', null, 'liveness_breach')
  })

  it('never fails the Dispatch it reports on', () => {
    const { dispatchId, taskId } = startWorker()

    sweep(minutesFromNow(31))

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      failure_count: 0
    })
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('carries the relay health so a coordinator can tell a dead worker from a dead transport', () => {
    const taskId = db.createTask({ spec: 'remote work', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
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
    vi.spyOn(runtime, 'getOrchestrationFederationSyncHealth').mockReturnValue({
      lastSyncAt: '2026-08-22T00:00:00.000Z',
      lastError: 'ECONNREFUSED',
      consecutiveFailures: 9
    })

    sweep(minutesFromNow(41))

    expect(JSON.parse(breachMail()[0].payload as string)).toMatchObject({
      syncHealth: { lastError: 'ECONNREFUSED', consecutiveFailures: 9 }
    })
  })

  it('wakes a parked check --wait --types worker_done,escalation,question', async () => {
    startWorker()
    const realWait = runtime.waitForMessage.bind(runtime)
    let parked: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      parked = resolve
    })
    vi.spyOn(runtime, 'waitForMessage').mockImplementation((handle, options) => {
      const pending = realWait(handle, options)
      parked()
      return pending
    })
    const method = findMethod('orchestration.check')
    const pending = method.handler(
      method.params!.parse({
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 5_000,
        types: 'worker_done,escalation,question'
      }),
      { runtime } as never
    ) as Promise<{ count: number; timedOut: boolean; messages: { type: string }[] }>

    await entered
    sweep(minutesFromNow(31))

    await expect(pending).resolves.toMatchObject({
      count: 1,
      timedOut: false,
      messages: [{ type: 'escalation' }]
    })
  })

  it('fires once per Dispatch across many sweeps', () => {
    startWorker()

    sweep(minutesFromNow(31))
    sweep(minutesFromNow(45))
    sweep(minutesFromNow(120))

    expect(breachMail()).toHaveLength(1)
  })

  it('re-arms across a runtime restart and does not re-report the same silence', () => {
    const { dispatchId } = startWorker()
    setDispatchedAt(dispatchId, new Date(Date.now() - 40 * MINUTE_MS).toISOString())
    runtime.tickDispatchLivenessMonitor()
    expect(breachMail()).toHaveLength(1)

    const armings = vi.spyOn(globalThis, 'setInterval')
    const restarted = new OrcaRuntimeService()
    restarted.setOrchestrationDb(db)
    try {
      expect(
        armings.mock.calls.some((call) => call[1] === DISPATCH_LIVENESS_SWEEP_INTERVAL_MS)
      ).toBe(true)
      restarted.tickDispatchLivenessMonitor()
      expect(breachMail()).toHaveLength(1)
    } finally {
      restarted.stopDispatchLivenessMonitor()
      restarted.stopOrchestrationFederationRelay()
    }
  })

  it('claims the breach exactly once so two sweeps cannot both post it', () => {
    const { dispatchId, taskId } = startWorker()
    const at = new Date().toISOString()

    expect(db.markDispatchLivenessBreached(dispatchId, at)).toBe(true)
    expect(db.markDispatchLivenessBreached(dispatchId, at)).toBe(false)

    db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })
    db.recordHeartbeat(dispatchId, at)
    expect(db.markDispatchLivenessBreached(dispatchId, at)).toBe(false)
  })

  it('re-arms the window once the worker comes back', () => {
    const { dispatchId } = startWorker()
    sweep(minutesFromNow(31))
    expect(breachMail()).toHaveLength(1)

    db.recordHeartbeat(dispatchId, new Date(minutesFromNow(35)).toISOString())
    expect(db.getDispatchContextById(dispatchId)?.liveness_breached_at).toBeNull()
    sweep(minutesFromNow(70))

    expect(breachMail()).toHaveLength(2)
  })

  // Why these two: the fence is claimed before the notice is posted, so a post that throws would
  // otherwise take that Dispatch's breach with it — a silent regression to the "printed into a
  // void" shape A1 §12 exists to remove — and abandon every later candidate in the sweep.
  describe('a failing escalation', () => {
    it('hands the fence back and keeps sweeping the rest', () => {
      const first = startWorker()
      const second = startWorker()
      const insert = vi.spyOn(db, 'insertMessage').mockImplementationOnce(() => {
        throw new Error('database is locked')
      })

      const emitted = sweep(minutesFromNow(31))

      expect(insert).toHaveBeenCalledTimes(2)
      expect(emitted).toHaveLength(1)
      expect(breachMail()).toHaveLength(1)
      const survivor = emitted[0].dispatchId
      const dropped = survivor === first.dispatchId ? second.dispatchId : first.dispatchId
      expect(db.getDispatchContextById(dropped)?.liveness_breached_at).toBeNull()

      insert.mockRestore()
      expect(sweep(minutesFromNow(32)).map((breach) => breach.dispatchId)).toEqual([dropped])
      expect(breachMail()).toHaveLength(2)
    })

    it('keeps a stored notice when only the waiter wake fails', () => {
      const { dispatchId } = startWorker()
      notify.mockImplementation(() => {
        throw new Error('waiter registry is gone')
      })

      expect(sweep(minutesFromNow(31))).toHaveLength(1)
      expect(breachMail()).toHaveLength(1)
      // The row reached the mailbox, so re-reporting it would be a duplicate, not a recovery.
      expect(db.getDispatchContextById(dispatchId)?.liveness_breached_at).toEqual(
        expect.any(String)
      )
      expect(sweep(minutesFromNow(60))).toEqual([])
      expect(breachMail()).toHaveLength(1)
    })
  })

  describe('negative controls', () => {
    it('says nothing about a worker heartbeating on the taught cadence', () => {
      const { dispatchId } = startWorker()

      for (let minute = 5; minute <= 120; minute += 5) {
        db.recordHeartbeat(dispatchId, new Date(minutesFromNow(minute)).toISOString())
        sweep(minutesFromNow(minute) + 1_000)
      }

      expect(breachMail()).toHaveLength(0)
    })

    it('says nothing about a worker blocked in ask for 25 minutes', () => {
      const { dispatchId } = startWorker()
      db.recordHeartbeat(dispatchId, new Date().toISOString())
      setBlockedSince(dispatchId, new Date(minutesFromNow(20)).toISOString())

      expect(sweep(minutesFromNow(45))).toEqual([])
      expect(breachMail()).toHaveLength(0)

      // The same 45 minutes of silence with no park recorded is a breach, so the exemption — not
      // a too-wide window — is what kept the blocked worker quiet.
      setBlockedSince(dispatchId, null)
      expect(sweep(minutesFromNow(45))).toHaveLength(1)
    })

    it('says nothing while a real check --wait park holds the marker', async () => {
      const { dispatchId } = startWorker()
      db.recordHeartbeat(dispatchId, new Date().toISOString())
      let release: (result: 'notified' | 'timed_out') => void = () => {}
      let parked: () => void = () => {}
      const entered = new Promise<void>((resolve) => {
        parked = resolve
      })
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(() => {
        parked()
        return new Promise((resolve) => {
          release = resolve
        }) as ReturnType<OrcaRuntimeService['waitForMessage']>
      })
      const method = findMethod('orchestration.check')
      const pending = method.handler(
        method.params!.parse({ terminal: 'term_worker', wait: true }),
        { runtime } as never
      )

      await entered
      expect(sweep(minutesFromNow(45))).toEqual([])

      release('timed_out')
      await pending
      expect(sweep(minutesFromNow(45))).toHaveLength(1)
    })

    // Why this control and not the local one above: a federated worker's park writes nothing on the
    // home — the peer holds no dispatch_contexts row — so the wider window is the ONLY thing
    // standing between a compliant peer-side `ask` and an escalation about a healthy worker.
    it('says nothing about a federated worker parked in a full-length peer-side ask', () => {
      const federated = startFederatedWorker()
      db.recordHeartbeat(federated.dispatchId, new Date().toISOString())

      // 5 minutes of pre-park cadence gap plus the longest legal `ask`, with no home-side marker.
      expect(sweep(minutesFromNow(35))).toEqual([])
      expect(breachMail()).toHaveLength(0)
      expect(db.getDispatchContextById(federated.dispatchId)?.blocked_since).toBeNull()

      // The same silence on a local Dispatch does breach, so the federated width — not a window
      // wide enough to hide everything — is what kept this one quiet.
      const local = startWorker()
      db.recordHeartbeat(local.dispatchId, new Date().toISOString())
      expect(sweep(minutesFromNow(35))).toHaveLength(1)
    })

    it('says nothing about a federated worker heartbeating on the taught cadence', () => {
      const { dispatchId } = startFederatedWorker()

      for (let minute = 5; minute <= 120; minute += 5) {
        db.recordHeartbeat(dispatchId, new Date(minutesFromNow(minute)).toISOString())
        sweep(minutesFromNow(minute) + 1_000)
      }

      expect(breachMail()).toHaveLength(0)
    })

    it('still reports a federated worker that outlasts the wider window', () => {
      const { dispatchId } = startFederatedWorker()
      db.recordHeartbeat(dispatchId, new Date().toISOString())

      expect(sweep(minutesFromNow(41))).toHaveLength(1)
      expect(JSON.parse(breachMail()[0].payload as string)).toMatchObject({
        dispatchId,
        windowMs: DISPATCH_FEDERATED_LIVENESS_DEFAULT_WINDOW_MS
      })
    })

    it('says nothing about a Dispatch younger than its window', () => {
      startWorker()

      expect(sweep(minutesFromNow(29))).toEqual([])
      expect(breachMail()).toHaveLength(0)
    })

    it('says nothing about a settled Dispatch', () => {
      const { dispatchId, taskId } = startWorker()
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })

      expect(sweep(minutesFromNow(600))).toEqual([])
      expect(breachMail()).toHaveLength(0)
    })

    it('says nothing about a legacy dispatch context with no supervised worker', () => {
      const taskId = db.createTask({ spec: 'legacy DAG task', runId }).id
      const legacy = db.createDispatchContext(taskId, 'term_legacy', 'tab_legacy:leaf_legacy')
      setDispatchedAt(legacy.id, new Date(Date.now() - 600 * MINUTE_MS).toISOString())

      expect(sweep(Date.now())).toEqual([])
      expect(breachMail()).toHaveLength(0)
    })

    it('keeps a late heartbeat from a failed retry off the live Dispatch', () => {
      const { dispatchId: failed, taskId } = startWorker()
      db.recordWorkerStage({ dispatchId: failed, stage: 'failed', state: 'failed' })
      db.failDispatch(failed, 'worker died')
      db.updateTaskStatus(taskId, 'failed', 'worker died')
      const retry = db.createStartingWorkerDispatch({
        taskId,
        retryOf: failed,
        startOptions: {},
        runtimeEpoch: runtime.getRuntimeId()
      })
      db.markWorkerDispatchReady(retry.dispatch.id)
      sweep(minutesFromNow(31))
      expect(breachMail()).toHaveLength(1)

      db.recordHeartbeat(failed, new Date(minutesFromNow(32)).toISOString())

      expect(db.getDispatchContextById(retry.dispatch.id)?.liveness_breached_at).toEqual(
        expect.any(String)
      )
      expect(sweep(minutesFromNow(90))).toEqual([])
      expect(breachMail()).toHaveLength(1)
    })

    it('says nothing when the coordinator disabled the window with 0', () => {
      startWorker({ startOptions: { livenessWindowMs: 0 } })

      expect(sweep(minutesFromNow(60 * 24 * 30))).toEqual([])
      expect(breachMail()).toHaveLength(0)
    })

    it('honors a window the coordinator widened past the default', () => {
      startWorker({ startOptions: { livenessWindowMs: 120 * MINUTE_MS } })

      expect(sweep(minutesFromNow(90))).toEqual([])
      expect(sweep(minutesFromNow(121))).toHaveLength(1)
    })
  })

  describe('worker-start persistence', () => {
    function mockLocalWorkerStart() {
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
    }

    async function startLocalWorker(params: Record<string, unknown>) {
      mockLocalWorkerStart()
      const taskId = db.createTask({ spec: 'supervised work', runId }).id
      const method = findMethod('orchestration.workerStart')
      const result = (await method.handler(
        method.params!.parse({ task: taskId, from: 'term_coord', agent: 'codex', ...params }),
        { runtime } as never
      )) as { state: string; dispatchId: string }
      expect(result.state).toBe('ready')
      return result
    }

    it('persists the requested window into the local start_options', async () => {
      const started = await startLocalWorker({ livenessWindowMs: 0 })

      expect(
        JSON.parse(db.getWorkerDispatch(started.dispatchId)?.start_options ?? '{}')
      ).toMatchObject({
        livenessWindowMs: 0
      })
      expect(sweep(minutesFromNow(60 * 24))).toEqual([])
    })

    it('leaves start_options silent when no window was requested so the default applies', async () => {
      const started = await startLocalWorker({})

      expect(
        JSON.parse(db.getWorkerDispatch(started.dispatchId)?.start_options ?? '{}')
      ).not.toHaveProperty('livenessWindowMs')
      expect(sweep(minutesFromNow(31))).toHaveLength(1)
    })
  })

  // Why this is a control and not a feature: no peer timestamp is compared anywhere, because the
  // relayed payload carries none and the home stamps the heartbeat itself at import. A peer clocked
  // hours away therefore cannot move the window in either direction.
  describe.each([
    ['ahead', 2 * 60 * MINUTE_MS],
    ['behind', -2 * 60 * MINUTE_MS]
  ])('a peer clocked %s by two hours', (_label, skewMs) => {
    it('lands the imported heartbeat on home time', async () => {
      const taskId = db.createTask({ spec: 'remote work', runId }).id
      const started = db.createStartingWorkerDispatch({
        taskId,
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
      const peerNow = new Date(Date.now() + skewMs).toISOString()
      vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_environmentId, method) =>
          method === 'orchestration.federationPull'
            ? {
                runtimeEpoch: 'peer_epoch',
                items: [
                  {
                    dispatch_id: started.dispatch.id,
                    direction: 'to_home',
                    sequence: 1,
                    message_id: 'msg_peer_heartbeat',
                    kind: 'message',
                    created_at: peerNow,
                    payload: JSON.stringify({
                      from: 'term_remote_worker',
                      subject: 'alive',
                      body: '',
                      type: 'heartbeat',
                      createdAt: peerNow
                    })
                  }
                ]
              }
            : { acknowledgedThrough: 1 }
      )

      const importedAt = Date.now()
      await syncFederatedDispatch(runtime, started.dispatch.id)

      const heartbeatAt = Date.parse(
        db.getDispatchContextById(started.dispatch.id)?.last_heartbeat_at as string
      )
      expect(Math.abs(heartbeatAt - importedAt)).toBeLessThan(5_000)
      expect(sweep(importedAt + 39 * MINUTE_MS)).toEqual([])
      expect(sweep(importedAt + 41 * MINUTE_MS)).toHaveLength(1)
    })
  })
})
