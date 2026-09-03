// S10-16 C7, test 53: every local link-binding verb refuses a paired/mobile caller `forbidden`,
// gate-first (bogus ids never reach a read/write), and is absent from the peer allowlist.
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_LINK_BINDING_LOCAL_METHODS } from './orchestration-link-binding-local'
import { RUNTIME_PEER_RPC_METHOD_ALLOWLIST } from '../../runtime-peer-rpc-allowlist'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

function findMethod(name: string) {
  const method = ORCHESTRATION_LINK_BINDING_LOCAL_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

describe('orchestration-link-binding-local RPC methods', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  afterEach(() => {
    if (!dbOpen) {
      return
    }
    dbOpen = false
    db.close()
  })

  async function call(name: string, params: Record<string, unknown>, ctx: RpcContext) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : params
    return method.handler(parsed, ctx)
  }

  it.each([
    ['orchestration.linkBindings', { link: 'lnk_bogus' }],
    ['orchestration.linkBind', { link: 'lnk_bogus' }],
    ['orchestration.linkRevoke', { link: 'lnk_bogus' }],
    ['orchestration.linkForget', { link: 'lnk_bogus' }],
    [
      'orchestration.linkContainment',
      { subjectKind: 'link', subjectId: 'lnk_bogus', action: 'quarantine' }
    ],
    ['orchestration.replyOutbox', { link: 'lnk_bogus' }]
  ])('%s refuses a paired caller with forbidden, before any read/write', async (method, params) => {
    setup()
    const ctx: RpcContext = { runtime, pairedDeviceId: 'dev_paired_peer', clientKind: 'runtime' }
    await expect(call(method, params, ctx)).rejects.toMatchObject({ code: 'forbidden' })
    // Gate-first: a bogus link id never reaches a read, so nothing was written or read from it.
    expect(db.getPeerLinkBinding('lnk_bogus')).toBeNull()
  })

  it.each([
    ['orchestration.linkBindings', { link: 'lnk_bogus' }],
    ['orchestration.linkBind', { link: 'lnk_bogus' }],
    ['orchestration.linkRevoke', { link: 'lnk_bogus' }],
    ['orchestration.linkForget', { link: 'lnk_bogus' }],
    [
      'orchestration.linkContainment',
      { subjectKind: 'link', subjectId: 'lnk_bogus', action: 'quarantine' }
    ],
    ['orchestration.replyOutbox', { link: 'lnk_bogus' }]
  ])('%s refuses a mobile-scope caller the same way', async (name, params) => {
    setup()
    const ctx: RpcContext = { runtime, clientKind: 'mobile' }
    await expect(call(name, params, ctx)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a genuinely local caller (no pairedDeviceId, no clientKind) is admitted', async () => {
    setup()
    const ctx: RpcContext = { runtime }
    const result = (await call('orchestration.linkBindings', {}, ctx)) as { links: unknown[] }
    expect(result.links).toEqual([])
  })

  it('R30.3: none of the six local verbs are on the peer allowlist', () => {
    for (const method of ORCHESTRATION_LINK_BINDING_LOCAL_METHODS) {
      expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.has(method.name)).toBe(false)
    }
  })
})
