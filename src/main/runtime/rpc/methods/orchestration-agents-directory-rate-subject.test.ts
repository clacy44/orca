// S10-19 W-5 (ops m13): agents.list's rate subject must never be params.host — an unattested
// local caller could otherwise choose its own bucket by passing --host, and a paired caller's
// bucket must key on its OWN link identity, never a claimed host.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_AGENTS_DIRECTORY_METHODS } from './orchestration-agents-directory'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcContext } from '../core'

function findMethod(name: string) {
  const method = ORCHESTRATION_AGENTS_DIRECTORY_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`method not found: ${name}`)
  }
  return method
}

describe('S10-19 W-5: orchestration.agents.list rate subject', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('a paired caller is metered on link:<pairedDeviceId>, never params.host', async () => {
    setup()
    const method = findMethod('orchestration.agents.list')
    const rateSpy = vi.spyOn(db, 'checkAndBumpRate')
    const ctx: RpcContext = { runtime, pairedDeviceId: 'dev_peer_1', clientKind: 'runtime' }
    await method.handler(method.params!.parse({ host: 'attacker-chosen-bucket' }), ctx)

    expect(rateSpy).toHaveBeenCalledWith(expect.objectContaining({ subjectKey: 'link:dev_peer_1' }))
  })

  it("an unattested local caller is metered on this runtime's own id, never params.host", async () => {
    setup()
    const method = findMethod('orchestration.agents.list')
    const rateSpy = vi.spyOn(db, 'checkAndBumpRate')
    const ctx: RpcContext = { runtime }
    await method.handler(method.params!.parse({ host: 'attacker-chosen-bucket' }), ctx)

    const subjectKey = rateSpy.mock.calls[0]?.[0]?.subjectKey
    expect(subjectKey).not.toBe('attacker-chosen-bucket')
    expect(subjectKey).toMatch(/^host:/)
  })
})

// W-5..W-7 review finding 8 (Ruling 24 addendum 4(ee)): agents.get was admitted on the
// allowlist name alone and metered nowhere, unlike agents.list — a peer could probe arbitrary
// agent ids/names at line rate. Metered symmetrically, same subject-key rule as list's m13 fix.
describe('W-5..W-7 review finding 8: orchestration.agents.get is now metered', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('calls checkAndBumpRate for verb "get"', async () => {
    setup()
    const method = findMethod('orchestration.agents.get')
    const rateSpy = vi.spyOn(db, 'checkAndBumpRate')
    const ctx: RpcContext = { runtime }
    try {
      await method.handler(method.params!.parse({ id: 'agent_nonexistent' }), ctx)
    } catch {
      // not_found is expected past the meter — only the meter call matters here.
    }
    expect(rateSpy).toHaveBeenCalledWith(expect.objectContaining({ verb: 'get' }))
  })

  it('a peer that exceeds the rate limit is refused rate_limited before any lookup', () => {
    setup()
    const method = findMethod('orchestration.agents.get')
    vi.spyOn(db, 'checkAndBumpRate').mockReturnValue({ allowed: false, retryAfterMs: 5000 })
    const ctx: RpcContext = { runtime, pairedDeviceId: 'dev_peer_1', clientKind: 'runtime' }
    // Why not `.rejects`: agents.get's handler is synchronous — it throws directly rather than
    // returning a rejected promise.
    expect(() => method.handler(method.params!.parse({ id: 'agent_x' }), ctx)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' })
    )
  })

  it('a paired caller is metered on link:<pairedDeviceId>, never a caller-supplied value', async () => {
    setup()
    const method = findMethod('orchestration.agents.get')
    const rateSpy = vi.spyOn(db, 'checkAndBumpRate')
    const ctx: RpcContext = { runtime, pairedDeviceId: 'dev_peer_1', clientKind: 'runtime' }
    try {
      await method.handler(method.params!.parse({ id: 'agent_x' }), ctx)
    } catch {
      // not_found is expected — only the subject key matters here.
    }
    expect(rateSpy).toHaveBeenCalledWith(expect.objectContaining({ subjectKey: 'link:dev_peer_1' }))
  })
})
