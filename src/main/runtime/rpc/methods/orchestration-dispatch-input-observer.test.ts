import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  DISPATCH_INPUT_OBSERVATION_DWELL_MS,
  DISPATCH_INPUT_OBSERVER_INTERVAL_MS,
  DISPATCH_INPUT_TERMINAL_EXITED_DWELL_MS
} from '../../orchestration/dispatch-input-observation'
import { syncFederatedDispatch } from '../../orchestration/federation-sync'
import { ORCHESTRATION_METHODS } from './orchestration'

const MINUTE_MS = 60_000
const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROCESS_INCARNATION = 'pty_worker:incarnation-a'
const TASK_SPEC = [
  'Refactor the dispatch mailbox resolver and add tests.',
  'Do not change the wire protocol.'
].join('\n')

// SYNTHESIZED from docs/reference/federation-live-test-findings.md, not captured output — F5 for
// the trust gate and the measured platform difference at :78-91 for the two submit shapes. A1
// section 2 requires both platforms because the submit-gap cause is still open.
const SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ > You are working inside Orca, a multi-agent IDE. You are a  │',
  '│   dispatched worker.                                         │',
  '│                                                              │',
  '│   === TASK ===                                               │',
  '│   Refactor the dispatch mailbox resolver and add tests.      │',
  '│   Do not change the wire protocol.                           │',
  '╰──────────────────────────────────────────────────────────────╯'
].join('\n')

const SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL = [
  '> You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
  '  === TASK ===',
  '  Refactor the dispatch mailbox resolver and add tests.',
  '  Do not change the wire protocol.',
  "⏺ I'll start by reading the dispatch mailbox resolver.",
  '⏺ Read(src/main/runtime/orchestration/dispatch-mailbox-terminal.ts)'
].join('\n')

const SYNTHESIZED_TRUST_GATE_TAIL = [
  '  OpenAI Codex',
  '',
  '  Do you trust the files in this folder?',
  '  > 1. Yes, allow Codex to run in this folder',
  '    2. No, exit'
].join('\n')

// Why every runtime in this file gets it: the observer refuses to say anything about a handle that
// does not name this Dispatch's process, so a runtime with no identity reading observes nothing.
function mockWorkerIdentity(runtime: OrcaRuntimeService) {
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord'
      ? COORDINATOR_PANE_KEY
      : handle === 'term_worker' || handle === 'term_peer_worker'
        ? WORKER_PANE_KEY
        : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === 'term_worker' || handle === 'term_peer_worker' ? PROCESS_INCARNATION : null
  )
}

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

describe('post-ready dispatch input observer', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let notify: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    mockWorkerIdentity(runtime)
    notify = vi.spyOn(runtime, 'notifyMessageArrived')
    runId = db.createRun({
      objective: 'Observe',
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

  function mockProbes(
    options: {
      tailText?: string | null
      agentStatus?: 'working' | 'permission' | 'idle' | null
      blockedAt?: number | null
      processLiveness?: 'live' | 'dead' | 'unknown'
      connected?: boolean
    } = {}
  ) {
    const tailText =
      options.tailText === undefined
        ? SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL
        : options.tailText
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue(
      tailText === null ? null : { tailText, blockedReason: null }
    )
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: options.agentStatus ?? null
    })
    vi.spyOn(runtime, 'getTerminalWaitBlockedAt').mockReturnValue(options.blockedAt ?? null)
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(
      options.processLiveness ?? 'live'
    )
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      connected: options.connected ?? true
    } as never)
  }

  function startWorker(submittedAt = Date.now()) {
    const taskId = db.createTask({ spec: TASK_SPEC, runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, undefined, {
      submittedAt: new Date(submittedAt).toISOString()
    })
    runtime.armDispatchInputObserver(started.dispatch.id)
    return { dispatchId: started.dispatch.id, taskId }
  }

  const runMail = () => db.getRunMailboxHistory(runId, 100)
  const observerMail = () => runMail().filter((message) => message.from_handle === 'runtime')
  const afterDwell = (extraMs = 0) => Date.now() + DISPATCH_INPUT_OBSERVATION_DWELL_MS + extraMs

  it('escalates one runtime notification when the tail still holds the unanswered task', async () => {
    mockProbes()
    const { dispatchId, taskId } = startWorker()

    await runtime.tickDispatchInputObserver(dispatchId, afterDwell())

    const mail = observerMail()
    expect(mail).toHaveLength(1)
    expect(mail[0]).toMatchObject({
      to_handle: `run:${runId}`,
      from_handle: 'runtime',
      type: 'escalation',
      priority: 'high'
    })
    expect(JSON.parse(mail[0].payload as string)).toMatchObject({
      origin: 'runtime',
      kind: 'input_not_consumed',
      dispatchId,
      taskId
    })
    expect(notify).toHaveBeenCalledWith(`run:${runId}`, 'escalation')
  })

  it('reports a gate the agent never got past, once its dwell has elapsed', async () => {
    const blockedAt = Date.now()
    mockProbes({ agentStatus: 'permission', blockedAt, tailText: SYNTHESIZED_TRUST_GATE_TAIL })
    const { dispatchId } = startWorker()

    await runtime.tickDispatchInputObserver(dispatchId, blockedAt + 20_000)
    expect(observerMail()).toHaveLength(0)

    await runtime.tickDispatchInputObserver(
      dispatchId,
      blockedAt + DISPATCH_INPUT_OBSERVATION_DWELL_MS
    )
    expect(JSON.parse(observerMail()[0].payload as string)).toMatchObject({
      kind: 'blocked_on_gate',
      agentStatus: 'permission'
    })
  })

  it('reports a worker whose process is gone before the Dispatch settled', async () => {
    mockProbes({ processLiveness: 'dead', tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL })
    const { dispatchId } = startWorker()

    await runtime.tickDispatchInputObserver(dispatchId, Date.now() + 1_000)

    expect(JSON.parse(observerMail()[0].payload as string)).toMatchObject({
      kind: 'worker_process_gone',
      processLiveness: 'dead'
    })
  })

  it('never fails the Dispatch it reports on', async () => {
    mockProbes()
    const { dispatchId, taskId } = startWorker()

    await runtime.tickDispatchInputObserver(dispatchId, afterDwell())

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      failure_count: 0
    })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('emits exactly one message across many ticks and disarms itself', async () => {
    mockProbes()
    const { dispatchId } = startWorker()

    for (let tick = 1; tick <= 12; tick += 1) {
      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(tick * MINUTE_MS))
    }

    expect(observerMail()).toHaveLength(1)
  })

  it('wakes a parked check --wait --types worker_done,escalation,question', async () => {
    mockProbes()
    const { dispatchId } = startWorker()
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
    await runtime.tickDispatchInputObserver(dispatchId, afterDwell())

    await expect(pending).resolves.toMatchObject({
      count: 1,
      timedOut: false,
      messages: [{ type: 'escalation' }]
    })
  })

  it('re-arms across a runtime restart without re-reporting what it already reported', async () => {
    mockProbes()
    const { dispatchId } = startWorker()
    await runtime.tickDispatchInputObserver(dispatchId, afterDwell())
    expect(observerMail()).toHaveLength(1)

    const restarted = new OrcaRuntimeService()
    mockWorkerIdentity(restarted)
    vi.spyOn(restarted, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL,
      blockedReason: null
    })
    restarted.setOrchestrationDb(db)
    try {
      await restarted.tickDispatchInputObserver(dispatchId, afterDwell(30 * MINUTE_MS))
      expect(observerMail()).toHaveLength(1)
    } finally {
      restarted.stopDispatchInputObservers()
      restarted.stopDispatchLivenessMonitor()
      restarted.stopOrchestrationFederationRelay()
    }
  })

  it('re-arms an unreported Dispatch across a restart and still reports it', async () => {
    mockProbes()
    const { dispatchId } = startWorker()
    runtime.stopDispatchInputObservers()
    const armings = vi.spyOn(globalThis, 'setInterval')
    const restarted = new OrcaRuntimeService()
    mockWorkerIdentity(restarted)
    vi.spyOn(restarted, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL,
      blockedReason: null
    })
    vi.spyOn(restarted, 'getTerminalAgentStatus').mockResolvedValue({
      handle: 'term_worker',
      isRunningAgent: true,
      status: null
    })
    vi.spyOn(restarted, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('live')
    vi.spyOn(restarted, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      connected: true
    } as never)
    restarted.setOrchestrationDb(db)
    try {
      expect(
        armings.mock.calls.some((call) => call[1] === DISPATCH_INPUT_OBSERVER_INTERVAL_MS)
      ).toBe(true)
      expect(db.listDispatchInputObservationTargets(dispatchId)[0]?.spec).toBe(TASK_SPEC)

      await restarted.tickDispatchInputObserver(dispatchId, afterDwell())

      expect(observerMail()).toHaveLength(1)
    } finally {
      restarted.stopDispatchInputObservers()
      restarted.stopDispatchLivenessMonitor()
      restarted.stopOrchestrationFederationRelay()
    }
  })

  describe('negative controls', () => {
    it('says nothing about a spinner-titled worker quiet for thirty minutes', async () => {
      mockProbes({
        agentStatus: 'working',
        tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
      })
      const { dispatchId } = startWorker()

      for (let minute = 1; minute <= 30; minute += 1) {
        await runtime.tickDispatchInputObserver(dispatchId, Date.now() + minute * MINUTE_MS)
      }

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing in the first sixty seconds', async () => {
      mockProbes()
      const { dispatchId } = startWorker()

      await runtime.tickDispatchInputObserver(dispatchId, Date.now() + 59_000)

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing once the worker has sent any heartbeat', async () => {
      mockProbes()
      const { dispatchId } = startWorker()
      db.recordHeartbeat(dispatchId, new Date().toISOString())

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    // Why an assertion about probes and not only about mail: the gate probe can reach
    // getForegroundProcess, and paying an SSH round trip every 45s for a worker that has already
    // proved it consumed its prompt is cost with no reachable verdict behind it.
    it('stops probing the agent gate and the tail once the worker has heartbeated', async () => {
      mockProbes()
      const { dispatchId } = startWorker()
      db.recordHeartbeat(dispatchId, new Date().toISOString())
      const agentStatus = vi.spyOn(runtime, 'getTerminalAgentStatus')
      const tail = vi.spyOn(runtime, 'getTerminalWaitEvidence')

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(agentStatus).not.toHaveBeenCalled()
      expect(tail).not.toHaveBeenCalled()
      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing about a manual-permission agent awaiting approval after a heartbeat', async () => {
      mockProbes({
        agentStatus: 'permission',
        blockedAt: Date.now(),
        tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
      })
      const { dispatchId } = startWorker()
      db.recordHeartbeat(dispatchId, new Date().toISOString())

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(45 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing about the Windows-shaped self-submit at twenty seconds', async () => {
      mockProbes({ tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL })
      const { dispatchId } = startWorker()

      await runtime.tickDispatchInputObserver(dispatchId, Date.now() + 20_000)
      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing after worker_done', async () => {
      mockProbes()
      const { dispatchId, taskId } = startWorker()
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing after worker-stop', async () => {
      mockProbes()
      const { dispatchId } = startWorker()
      db.recordWorkerStage({ dispatchId, stage: 'stopped', state: 'stopped' })
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing after worker-release claimed the terminal', async () => {
      mockProbes()
      const { dispatchId, taskId } = startWorker()
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })
      db.requestWorkerTerminalRelease(dispatchId)
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe(
        'not_requested'
      )
      // Why forced back to ready: without it the settlement alone would disarm the observer, and
      // the release predicate would never be the thing under test.
      db.recordWorkerStage({ dispatchId, stage: 'input_accepted', state: 'ready' })

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    // Why this control: `connected` is `ptyId !== null`, so it goes false for a renderer graph
    // rebuild and for the 30s SSH pane recovery grace the runtime keeps for a re-dialing transport.
    it('says nothing while a disconnected pane is inside its recovery grace', async () => {
      mockProbes({ connected: false, tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL })
      const { dispatchId } = startWorker()
      const disconnectedAt = Date.now()

      await runtime.tickDispatchInputObserver(dispatchId, disconnectedAt)
      await runtime.tickDispatchInputObserver(
        dispatchId,
        disconnectedAt + DISPATCH_INPUT_TERMINAL_EXITED_DWELL_MS - 1_000
      )
      expect(observerMail()).toHaveLength(0)

      // A pane that reconnects inside the grace clears the sighting rather than banking it.
      mockProbes({ connected: true, tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL })
      await runtime.tickDispatchInputObserver(
        dispatchId,
        disconnectedAt + DISPATCH_INPUT_TERMINAL_EXITED_DWELL_MS + 1_000
      )
      expect(observerMail()).toHaveLength(0)
    })

    it('reports a pane that is still disconnected past the recovery grace', async () => {
      mockProbes({ connected: false, tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL })
      const { dispatchId } = startWorker()
      const disconnectedAt = Date.now()

      await runtime.tickDispatchInputObserver(dispatchId, disconnectedAt)
      await runtime.tickDispatchInputObserver(
        dispatchId,
        disconnectedAt + DISPATCH_INPUT_TERMINAL_EXITED_DWELL_MS + 1_000
      )

      expect(JSON.parse(observerMail()[0].payload as string)).toMatchObject({
        kind: 'worker_process_gone',
        terminalStatus: 'exited'
      })
    })

    // Why this control: a re-minted pane answers on the same handle, so without the identity gate a
    // gate belonging to some other agent is reported as this worker's — and the report is
    // once-per-Dispatch, so the false one also consumes the budget for the real one.
    it('says nothing when the handle no longer names this worker', async () => {
      mockProbes({ connected: false })
      const { dispatchId } = startWorker()
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('pty_worker:incarnation-b')

      for (let tick = 1; tick <= 6; tick += 1) {
        await runtime.tickDispatchInputObserver(dispatchId, afterDwell(tick * MINUTE_MS))
      }

      expect(observerMail()).toHaveLength(0)
      expect(db.getWorkerDispatch(dispatchId)?.input_observed_at ?? null).toBeNull()
    })

    it('says nothing on the peer when its pane was re-minted', async () => {
      mockProbes({ connected: false })
      const { dispatchId } = attachRemoteWorker()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
        'tab_worker:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      )

      for (let tick = 1; tick <= 6; tick += 1) {
        await runtime.tickDispatchInputObserver(dispatchId, afterDwell(tick * MINUTE_MS))
      }

      expect(
        db
          .listPendingFederationRelay(dispatchId, 'to_home')
          .filter((item) => item.kind === 'runtime_notification')
      ).toHaveLength(0)
    })

    it('says nothing when the terminal tail could not be read', async () => {
      mockProbes({ tailText: null })
      const { dispatchId } = startWorker()

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    it('says nothing when every probe throws', async () => {
      const { dispatchId } = startWorker()
      vi.spyOn(runtime, 'getTerminalWaitEvidence').mockImplementation(() => {
        throw new Error('terminal_gone')
      })
      vi.spyOn(runtime, 'getTerminalAgentStatus').mockRejectedValue(new Error('terminal_gone'))
      vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockRejectedValue(
        new Error('host unreachable')
      )
      vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('terminal_not_found'))

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(observerMail()).toHaveLength(0)
    })

    // Why status counts: the worker send path enqueues `kind: type` verbatim, so a worker whose
    // only outbound traffic so far is `--type status` has demonstrably run the CLI.
    it('treats a federated worker that sent --type status as having spoken', async () => {
      mockProbes()
      const { dispatchId } = attachRemoteWorker()
      db.enqueueFederationRelay({
        dispatchId,
        direction: 'to_home',
        kind: 'status',
        payload: JSON.stringify({
          from: 'term_peer_worker',
          subject: 'progress',
          body: 'reading the resolver',
          type: 'status'
        })
      })

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(
        db
          .listPendingFederationRelay(dispatchId, 'to_home')
          .filter((item) => item.kind === 'runtime_notification')
      ).toHaveLength(0)
    })

    it('says nothing on the peer once the worker has spoken', async () => {
      mockProbes()
      const { dispatchId } = attachRemoteWorker()
      db.enqueueFederationRelay({
        dispatchId,
        direction: 'to_home',
        kind: 'heartbeat',
        payload: JSON.stringify({
          from: 'term_peer_worker',
          subject: 'alive',
          body: '',
          type: 'heartbeat'
        })
      })

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell(60 * MINUTE_MS))

      expect(
        db
          .listPendingFederationRelay(dispatchId, 'to_home')
          .filter((item) => item.kind === 'runtime_notification')
      ).toHaveLength(0)
    })

    it('never observes a federated Dispatch from the home', async () => {
      mockProbes()
      const taskId = db.createTask({ spec: TASK_SPEC, runId }).id
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
      db.markWorkerDispatchReady(started.dispatch.id, undefined, {
        submittedAt: new Date().toISOString()
      })

      expect(db.listDispatchInputObservationTargets(started.dispatch.id)).toEqual([])
    })
  })

  describe('federated', () => {
    it('crosses to the coordinator on the relay the peer already owns', async () => {
      mockProbes()
      const { dispatchId, taskId } = attachRemoteWorker()

      await runtime.tickDispatchInputObserver(dispatchId, afterDwell())

      const queued = db
        .listPendingFederationRelay(dispatchId, 'to_home')
        .filter((item) => item.kind === 'runtime_notification')
      expect(queued).toHaveLength(1)

      vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
        environmentId: 'environment_peer',
        name: 'peer',
        peerFingerprint: 'peer_fingerprint'
      })
      vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_environmentId, method) =>
          method === 'orchestration.federationPull'
            ? { runtimeEpoch: 'peer_epoch', items: queued }
            : { acknowledgedThrough: queued.at(-1)?.sequence ?? 0 }
      )
      await syncFederatedDispatch(runtime, dispatchId)

      const imported = runMail().filter((message) => message.type === 'escalation')
      expect(imported).toHaveLength(1)
      expect(JSON.parse(imported[0].payload as string)).toMatchObject({
        origin: 'runtime',
        kind: 'input_not_consumed',
        dispatchId,
        taskId
      })
      expect(notify).toHaveBeenCalledWith(`run:${runId}`, 'escalation')
    })
  })

  // Why one helper builds both sides in one database: the home's federated_dispatches row and the
  // peer's remote_dispatch_attachments row are different tables, so a single OrchestrationDb can
  // stand in for both ends of the relay without a second process.
  function attachRemoteWorker() {
    const taskId = db.createTask({ spec: TASK_SPEC, runId }).id
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
    db.createRemoteDispatchAttachment({
      dispatchId: started.dispatch.id,
      taskId,
      homePeerFingerprint: 'home_fingerprint',
      protocolVersion: 1,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_fingerprint',
        requestId: `request_${started.dispatch.id}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: started.dispatch.id,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::peer-worktree',
      terminalHandle: 'term_peer_worker',
      setupState: 'not_applicable',
      effects: []
    })
    db.markRemoteAttachmentReady(started.dispatch.id)
    runtime.armDispatchInputObserver(started.dispatch.id, {
      dispatchId: started.dispatch.id,
      taskId,
      terminalHandle: 'term_peer_worker',
      taskSpec: TASK_SPEC,
      submittedAt: Date.now(),
      processIncarnation: PROCESS_INCARNATION
    })
    return { dispatchId: started.dispatch.id, taskId }
  }
})
