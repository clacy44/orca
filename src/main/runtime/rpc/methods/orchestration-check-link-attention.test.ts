// S10-16 C6, R19.5/Ruling 21 Protocol B2, test 79's surface slice: `orchestration.check` through
// the REAL RPC handler (rpc/methods/orchestration.ts's `orchestration.check` defineMethod entry),
// against a real OrchestrationDb fixture — not a unit test of the formatter alone. Local caller
// carries `linkBindingAttention`; the same call with `pairedDeviceId` set, or a mobile client,
// carries no such field (R19.5's local-caller gate); a healthy host carries no field either.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

function method(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

describe('orchestration.check: linkBindingAttention (S10-16 C6)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })

  afterEach(() => {
    db.close()
  })

  function contestLinkC(): void {
    db.contestPeerLinkBinding('link_c', Date.now(), 'incident_1', 'detail', {
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1'
    })
  }

  async function check(ctx: Partial<RpcContext> = {}): Promise<Record<string, unknown>> {
    const m = method('orchestration.check')
    const parsed = m.params ? m.params.parse({ terminal: 'term_x' }) : undefined
    return m.handler(parsed, { runtime, ...ctx } as RpcContext) as Promise<Record<string, unknown>>
  }

  it('a healthy host carries no field', async () => {
    const result = await check()
    expect(result.linkBindingAttention).toBeUndefined()
  })

  it('a local caller with a contested link sees linkBindingAttention', async () => {
    contestLinkC()
    const result = await check()
    expect(typeof result.linkBindingAttention).toBe('string')
    expect(result.linkBindingAttention).toContain('contested')
  })

  it('the same call with pairedDeviceId set carries no such field', async () => {
    contestLinkC()
    const result = await check({ pairedDeviceId: 'dev_peer', clientKind: 'runtime' })
    expect(result.linkBindingAttention).toBeUndefined()
  })

  it('a mobile client carries no such field either', async () => {
    contestLinkC()
    const result = await check({ clientKind: 'mobile' })
    expect(result.linkBindingAttention).toBeUndefined()
  })
})
