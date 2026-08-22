import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { sweepDispatchLivenessBreaches } from '../../orchestration/dispatch-liveness-monitor'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import {
  FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD,
  federationRelayFailuresToOutlast
} from '../../orchestration/federation-sync-health'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PEER_FINGERPRINT = 'peer_fingerprint'
const DIRECT_TCP_REFUSAL = {
  code: 'runtime_unreachable',
  message: 'connect ECONNREFUSED 10.0.0.4:7777'
}
// Why an SSH-shaped refusal is a distinct fixture: the tunnel is below the transport interface, so
// the claim worth pinning is that a peer reached over SSH walks the identical escalation path and
// only the error text differs (AGENTS.md's SSH use case).
const SSH_TUNNEL_REFUSAL = {
  code: 'runtime_unreachable',
  message: 'connect ECONNREFUSED 127.0.0.1:17654 (ssh tunnel closed)'
}

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

describe('federation relay unreachable escalation', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let notify: ReturnType<typeof vi.spyOn>
  let peerFailure: { code: string; message: string } | null
  let transport: OrchestrationEnvironmentTransport

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    peerFailure = null
    transport = {
      resolve: () => ({
        environmentId: 'environment_peer',
        name: 'peer',
        peerFingerprint: PEER_FINGERPRINT
      }),
      call: async () =>
        (peerFailure
          ? { id: 'call', ok: false, error: { ...peerFailure }, _meta: { runtimeId: 'peer' } }
          : {
              id: 'call',
              ok: true,
              result: { runtimeEpoch: 'peer_epoch', items: [] },
              _meta: { runtimeId: 'peer' }
            }) as RuntimeRpcResponse<unknown>
    }
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORDINATOR_PANE_KEY : null
    )
    notify = vi.spyOn(runtime, 'notifyMessageArrived')
    runId = db.createRun({
      objective: 'Federated supervision',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
  })

  afterEach(() => {
    runtime.stopOrchestrationFederationRelay()
    runtime.stopDispatchLivenessMonitor()
    vi.restoreAllMocks()
    db.close()
  })

  function startFederatedWorker(): { dispatchId: string; taskId: string } {
    const taskId = db.createTask({ spec: 'remote audit', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId(),
      federation: {
        environmentId: 'environment_peer',
        environmentName: 'peer',
        peerFingerprint: PEER_FINGERPRINT,
        protocolVersion: 1
      }
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatchId: started.dispatch.id, taskId }
  }

  function startLocalWorker(): { dispatchId: string; taskId: string } {
    const taskId = db.createTask({ spec: 'local refactor', runId }).id
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatchId: started.dispatch.id, taskId }
  }

  async function sync(dispatchId: string, times = 1, target = runtime): Promise<void> {
    for (let attempt = 0; attempt < times; attempt += 1) {
      await target.syncOrchestrationFederatedDispatch(dispatchId).catch(() => undefined)
    }
  }

  // Why reversed: getRunMailboxHistory answers newest-first, and these assertions read the outage
  // and its recovery in the order a coordinator would process them.
  const runtimeMail = () =>
    db
      .getRunMailboxHistory(runId, 100)
      .filter((message) => message.from_handle === 'runtime')
      .toReversed()
      .map((message) => ({
        message,
        payload: JSON.parse(String(message.payload)) as Record<string, unknown>
      }))
  const relayMail = () =>
    runtimeMail().filter((entry) => String(entry.payload.kind).startsWith('relay_'))

  it('escalates once when the relay has stopped reaching the peer', async () => {
    const { dispatchId, taskId } = startFederatedWorker()
    peerFailure = null
    await sync(dispatchId)
    peerFailure = DIRECT_TCP_REFUSAL

    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)

    const mail = relayMail()
    expect(mail).toHaveLength(1)
    expect(mail[0].message).toMatchObject({
      to_handle: `run:${runId}`,
      from_handle: 'runtime',
      type: 'escalation',
      priority: 'high'
    })
    expect(mail[0].payload).toMatchObject({
      origin: 'runtime',
      kind: 'relay_unreachable',
      dispatchId,
      taskId,
      environmentName: 'peer',
      lastError: `runtime_unreachable: ${DIRECT_TCP_REFUSAL.message}`,
      consecutiveFailures: FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD
    })
    expect(mail[0].payload.lastSyncAt).toEqual(expect.any(String))
    expect(notify).toHaveBeenCalledWith(`run:${runId}`, 'escalation')
  })

  it('stays silent for the rest of the outage and speaks once on recovery', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = DIRECT_TCP_REFUSAL

    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD + 8)
    expect(relayMail()).toHaveLength(1)

    peerFailure = null
    await sync(dispatchId, 3)

    const mail = relayMail()
    expect(mail).toHaveLength(2)
    expect(mail[1].payload).toMatchObject({
      origin: 'runtime',
      kind: 'relay_recovered',
      dispatchId,
      consecutiveFailures: 0,
      lastError: null
    })
  })

  it('reports a second outage after the link recovered in between', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = DIRECT_TCP_REFUSAL
    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)
    peerFailure = null
    await sync(dispatchId)

    peerFailure = DIRECT_TCP_REFUSAL
    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)

    expect(relayMail().map((entry) => entry.payload.kind)).toEqual([
      'relay_unreachable',
      'relay_recovered',
      'relay_unreachable'
    ])
  })

  it('wakes a parked check --wait --types worker_done,escalation,question', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = DIRECT_TCP_REFUSAL
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
    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)

    await expect(pending).resolves.toMatchObject({
      count: 1,
      timedOut: false,
      messages: [{ type: 'escalation' }]
    })
  })

  it('reports an SSH-transported peer through the same path as direct TCP', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = SSH_TUNNEL_REFUSAL

    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)

    const mail = relayMail()
    expect(mail).toHaveLength(1)
    expect(mail[0].payload).toMatchObject({
      kind: 'relay_unreachable',
      lastError: `runtime_unreachable: ${SSH_TUNNEL_REFUSAL.message}`,
      consecutiveFailures: FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD
    })
  })

  it('tells a liveness breach whether the worker went silent or the transport did', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = DIRECT_TCP_REFUSAL
    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)

    sweepDispatchLivenessBreaches({ db, runtime, now: Date.now() + 41 * 60_000 })

    const breach = runtimeMail().find((entry) => entry.payload.kind === 'liveness_breach')
    expect(breach?.payload.syncHealth).toMatchObject({
      consecutiveFailures: FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD,
      lastError: `runtime_unreachable: ${DIRECT_TCP_REFUSAL.message}`
    })
  })

  it('restores the outage and its discriminator from the row after a restart', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = DIRECT_TCP_REFUSAL
    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)
    const persisted = db.getFederatedDispatchSyncHealth(dispatchId)

    // Why a runtime with no transport: it arms no relay, so what it answers can only have come from
    // the row — which is the whole point of persisting it.
    const restarted = new OrcaRuntimeService()
    try {
      restarted.setOrchestrationDb(db)
      expect(restarted.getOrchestrationFederationSyncHealth(dispatchId)).toEqual(persisted)

      sweepDispatchLivenessBreaches({ db, runtime: restarted, now: Date.now() + 41 * 60_000 })
      const breach = runtimeMail().find((entry) => entry.payload.kind === 'liveness_breach')
      expect(breach?.payload.syncHealth).toEqual(persisted)
    } finally {
      restarted.stopDispatchLivenessMonitor()
      restarted.stopOrchestrationFederationRelay()
    }
  })

  it('does not re-announce an outage a previous process already reported', async () => {
    const { dispatchId } = startFederatedWorker()
    peerFailure = DIRECT_TCP_REFUSAL
    await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)
    expect(relayMail()).toHaveLength(1)

    const restarted = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    try {
      restarted.setOrchestrationDb(db)
      restarted.stopOrchestrationFederationRelay()
      await sync(dispatchId, 3, restarted)

      expect(relayMail()).toHaveLength(1)
      expect(
        restarted.getOrchestrationFederationSyncHealth(dispatchId)?.consecutiveFailures
      ).toBeGreaterThan(FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)
    } finally {
      restarted.stopDispatchLivenessMonitor()
      restarted.stopOrchestrationFederationRelay()
    }
  })

  describe('negative controls', () => {
    it('says nothing about a single transient failure that succeeds on retry', async () => {
      const { dispatchId } = startFederatedWorker()
      peerFailure = DIRECT_TCP_REFUSAL
      await sync(dispatchId)
      peerFailure = null

      await sync(dispatchId, 3)

      expect(relayMail()).toEqual([])
      expect(db.getFederatedDispatchSyncHealth(dispatchId)).toMatchObject({
        consecutiveFailures: 0,
        lastError: null
      })
    })

    // Why 45 seconds specifically: a peer runtime restart or a tunnel re-dial takes about that
    // long, and the count alone used to escalate it — waking every parked `check --wait` over an
    // event that had already ended.
    it('says nothing about a peer that refuses for forty-five seconds and then answers', async () => {
      const { dispatchId } = startFederatedWorker()
      peerFailure = DIRECT_TCP_REFUSAL

      await sync(dispatchId, federationRelayFailuresToOutlast(45_000) - 1)
      expect(relayMail()).toEqual([])

      peerFailure = null
      await sync(dispatchId, 2)

      expect(relayMail()).toEqual([])
      expect(db.getFederatedDispatchSyncHealth(dispatchId)).toMatchObject({
        consecutiveFailures: 0
      })
    })

    it('says nothing about a Dispatch that settled during the outage', async () => {
      const { dispatchId, taskId } = startFederatedWorker()
      peerFailure = DIRECT_TCP_REFUSAL
      await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD - 2)
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })

      await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD + 5)

      expect(relayMail()).toEqual([])
    })

    it('says nothing about a purely local Dispatch', async () => {
      const { dispatchId } = startLocalWorker()
      peerFailure = DIRECT_TCP_REFUSAL

      await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD + 3)

      expect(relayMail()).toEqual([])
      expect(db.getFederatedRelayNoticeTarget(dispatchId)).toBeUndefined()
    })

    it('never touches the Dispatch it reports on', async () => {
      const { dispatchId, taskId } = startFederatedWorker()
      peerFailure = DIRECT_TCP_REFUSAL

      await sync(dispatchId, FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD)

      expect(db.getDispatchContextById(dispatchId)).toMatchObject({
        status: 'dispatched',
        failure_count: 0
      })
      expect(db.getTask(taskId)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    })
  })
})
