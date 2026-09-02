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
