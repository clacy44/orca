// S10-19 W-5 (attacker 7): federationPull/Ack/Import were unmetered and federationImport's
// `items` array had no bound — without both, R25/INV-P-006(a) overclaim on the one store §6.6
// designates.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_RELAY_METHODS } from './orchestration-federation-relay'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcContext } from '../core'

function findMethod(name: string) {
  const method = ORCHESTRATION_FEDERATION_RELAY_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`method not found: ${name}`)
  }
  return method
}

const FINGERPRINT = 'fp_relay_caller'

function setup(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('epoch-current')
  db.createRemoteDispatchAttachment({
    dispatchId: 'disp_relay',
    taskId: 'task_relay',
    homePeerFingerprint: FINGERPRINT,
    protocolVersion: 3,
    runtimeEpoch: 'epoch-current',
    mutationReceipt: {
      callerFingerprint: FINGERPRINT,
      requestId: 'req_setup',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'hash'
    }
  })
  return { db, runtime }
}

describe('S10-19 W-5: federationImport items array bound', () => {
  it('the schema rejects a batch over the item cap', () => {
    const method = findMethod('orchestration.federationImport')
    const oversized = Array.from({ length: 201 }, (_, i) => ({
      dispatch_id: 'disp_relay',
      direction: 'to_worker' as const,
      sequence: i + 1,
      message_id: `msg_${i}`,
      kind: 'control_message',
      payload: 'x'
    }))
    expect(() => method.params!.parse({ dispatchId: 'disp_relay', items: oversized })).toThrow()
  })

  it('the schema rejects an oversized payload string', () => {
    const method = findMethod('orchestration.federationImport')
    expect(() =>
      method.params!.parse({
        dispatchId: 'disp_relay',
        items: [
          {
            dispatch_id: 'disp_relay',
            direction: 'to_worker',
            sequence: 1,
            message_id: 'msg_1',
            kind: 'control_message',
            payload: 'x'.repeat(8_001)
          }
        ]
      })
    ).toThrow()
  })
})

describe('S10-19 W-5: federationPull/Ack/Import are metered (attacker 7)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('federationPull refuses rate_limited once PEER_MAILBOX_PER_MINUTE is exceeded', async () => {
    const s = setup()
    db = s.db
    const method = findMethod('orchestration.federationPull')
    const ctx: RpcContext = { runtime: s.runtime, authenticatedCallerFingerprint: FINGERPRINT }
    let lastError: unknown
    for (let i = 0; i < 61; i++) {
      try {
        await method.handler(method.params!.parse({ dispatchId: 'disp_relay' }), ctx)
      } catch (error) {
        lastError = error
      }
    }
    expect(lastError).toMatchObject({ code: 'rate_limited' })
  })
})
