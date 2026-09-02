import { describe, expect, it, vi } from 'vitest'

import { LANE_HANDLERS } from './lane'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeRpcFailureError } from '../runtime-client'
import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const CAPABILITIES = [AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY]

const ANA = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const BEN = '11112222-3333-4444-5555-666677778888'

function statusEnvelope(capabilities: string[] = CAPABILITIES) {
  return { id: 'test', ok: true as const, result: { capabilities }, _meta: { runtimeId: 'r' } }
}

function readStatusResult() {
  return {
    grants: [
      {
        deviceId: 'ana-phone-01',
        label: 'Ana phone',
        perPerson: true,
        boundPrincipalId: null,
        designated: false
      },
      {
        deviceId: 'ana-phone-02',
        label: 'Ana tablet',
        perPerson: true,
        boundPrincipalId: null,
        designated: false
      },
      {
        deviceId: 'ben-laptop-99',
        label: 'Ben laptop',
        perPerson: true,
        boundPrincipalId: BEN,
        designated: true
      }
    ],
    principals: [
      {
        principalId: ANA,
        displayName: 'Ana Ng',
        delegatedGrantId: null,
        laneState: 'absent',
        boundDeviceIds: []
      },
      {
        principalId: BEN,
        displayName: 'Ben Lee',
        delegatedGrantId: 'ben-laptop-99',
        laneState: 'loaded',
        boundDeviceIds: ['ben-laptop-99']
      }
    ]
  }
}

type CallImpl = (method: string, params?: unknown) => Promise<unknown>

function makeClient(impl: CallImpl): { client: RuntimeClient; calls: [string, unknown][] } {
  const calls: [string, unknown][] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    calls.push([method, params])
    const result = await impl(method, params)
    return { id: 'test', ok: true, result, _meta: { runtimeId: 'r' } }
  })
  return { client: { call } as unknown as RuntimeClient, calls }
}

function context(
  client: RuntimeClient,
  flags: Record<string, string | boolean>,
  json = false
): HandlerContext {
  return { client, cwd: '/tmp', flags: new Map(Object.entries(flags)), json, rawArgs: [] }
}

const defaultImpl: CallImpl = (method) => {
  if (method === 'status.get') {
    return Promise.resolve(statusEnvelope().result)
  }
  if (method === 'accounts.lane.readStatus') {
    return Promise.resolve(readStatusResult())
  }
  if (method === 'accounts.lane.listPrincipals') {
    return Promise.resolve({ principals: readStatusResult().principals })
  }
  if (method === 'accounts.lane.createPrincipal') {
    return Promise.resolve({ principalId: ANA, displayName: 'Ana Ng' })
  }
  if (method === 'accounts.lane.bindGrant' || method === 'accounts.lane.rebindGrant') {
    return Promise.resolve({ bound: true })
  }
  if (method === 'accounts.lane.unbindGrant') {
    return Promise.resolve({ unbound: true })
  }
  if (method === 'accounts.lane.designatePusher') {
    return Promise.resolve({ designatedGrantId: 'ana-phone-01' })
  }
  if (method === 'accounts.lane.provision') {
    return Promise.resolve({ provisioned: true, provenanceLabel: 'a'.repeat(32) })
  }
  if (method === 'accounts.lane.deprovision') {
    return Promise.resolve({ deprovisioned: true })
  }
  if (method === 'accounts.lane.wipe') {
    return Promise.resolve({ released: true })
  }
  if (method === 'accounts.lane.readAudit') {
    return Promise.resolve({ audit: [{ at: 0, action: 'create-principal', principalId: ANA }] })
  }
  if (method === 'accounts.lane.bindFederatedLink') {
    return Promise.resolve({ boundDeviceId: 'ben-laptop-99' })
  }
  if (method === 'accounts.lane.mintInvite') {
    return Promise.resolve({
      deviceId: '52f2327b-aaaa-bbbb-cccc-000000000000',
      deviceIdPrefix: '52f2327b',
      principalId: ANA,
      displayName: 'Ana Ng',
      scope: 'runtime',
      accessProfile: 'full',
      expiresAt: Date.now() + 86_400_000,
      pairingUrl: 'orca://pair?code=abc',
      webClientUrl: null,
      endpoint: 'wss://example.com:6768'
    })
  }
  return Promise.resolve({})
}

describe('lane CLI handlers', () => {
  it('registers one handler per lane verb', () => {
    expect(Object.keys(LANE_HANDLERS).sort()).toEqual(
      [
        'lane audit',
        'lane bind',
        'lane bind-link',
        'lane create-person',
        'lane deprovision',
        'lane designate',
        'lane invite',
        'lane persons',
        'lane provision',
        'lane rebind',
        'lane status',
        'lane unbind',
        'lane wipe'
      ].sort()
    )
  })

  it('refuses every verb on a runtime without the lane capability, telling the caller to update the host', async () => {
    const { client } = makeClient((method) =>
      method === 'status.get' ? Promise.resolve({ capabilities: [] }) : defaultImpl(method)
    )
    await expect(LANE_HANDLERS['lane persons'](context(client, {}))).rejects.toThrow(
      /Update the host/
    )
  })

  it('lists people over the local listPrincipals read', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane persons'](context(client, {}))
    expect(calls.map(([method]) => method)).toEqual(['status.get', 'accounts.lane.listPrincipals'])
  })

  it('requires --name to create a person', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(LANE_HANDLERS['lane create-person'](context(client, {}))).rejects.toThrow(
      /Missing a value for --name/
    )
  })

  it('passes the display name through to createPrincipal', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane create-person'](context(client, { name: 'Ana Ng' }))
    expect(calls).toContainEqual(['accounts.lane.createPrincipal', { displayName: 'Ana Ng' }])
  })

  it('resolves a device by pairing label and a person by display name when binding', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane bind'](context(client, { device: 'Ben laptop', person: 'Ben Lee' }))
    expect(calls).toContainEqual([
      'accounts.lane.bindGrant',
      { deviceId: 'ben-laptop-99', principalId: BEN }
    ])
  })

  it('resolves a device by a unique id prefix', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane unbind'](context(client, { device: 'ben-laptop' }))
    expect(calls).toContainEqual(['accounts.lane.unbindGrant', { deviceId: 'ben-laptop-99' }])
  })

  it('refuses an ambiguous device prefix and lists the candidates', async () => {
    const { client } = makeClient(defaultImpl)
    let message = ''
    try {
      await LANE_HANDLERS['lane bind'](context(client, { device: 'ana-phone', person: 'Ana Ng' }))
    } catch (caught) {
      message = (caught as Error).message
    }
    expect(message).toMatch(/matches more than one device/)
    expect(message).toContain('ana-phone-01')
    expect(message).toContain('ana-phone-02')
  })

  it('surfaces an RPC refusal sentence verbatim', async () => {
    const refusal =
      'That device is already bound to a person. Unbind it first — re-binding is unbind-then-bind, never a rewrite in place.'
    const { client } = makeClient((method, params) => {
      if (method === 'accounts.lane.bindGrant') {
        return Promise.reject(
          new RuntimeRpcFailureError({
            id: 't',
            ok: false,
            error: { code: 'accounts.lane.grant_already_bound', message: refusal },
            _meta: { runtimeId: 'r' }
          })
        )
      }
      return defaultImpl(method, params)
    })
    await expect(
      LANE_HANDLERS['lane bind'](context(client, { device: 'ben-laptop-99', person: 'Ben Lee' }))
    ).rejects.toThrow(refusal)
  })

  it('reads lane status and can filter to one person', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane status'](context(client, { person: 'Ben Lee' }, true))
    expect(calls).toContainEqual(['accounts.lane.readStatus', undefined])
  })

  it('reads the audit trail', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane audit'](context(client, {}, true))
    expect(calls).toContainEqual(['accounts.lane.readAudit', undefined])
  })

  it('requires --force to release a latched wipe-pending mark', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(LANE_HANDLERS['lane wipe'](context(client, { person: 'Ana Ng' }))).rejects.toThrow(
      /requires `--force`/
    )
  })

  it('resolves --person and calls accounts.lane.wipe with force: true', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane wipe'](context(client, { person: 'Ana Ng', force: true }))
    expect(calls).toContainEqual(['accounts.lane.wipe', { principalId: ANA, force: true }])
  })

  it('reports when the lane was not latched, without throwing', async () => {
    const { client } = makeClient((method, params) =>
      method === 'accounts.lane.wipe'
        ? Promise.resolve({ released: false })
        : defaultImpl(method, params)
    )
    await LANE_HANDLERS['lane wipe'](context(client, { person: 'Ana Ng', force: true }))
  })

  it('refuses a bind-link whose grant belongs to a different person than asserted', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane bind-link'](context(client, { link: 'f'.repeat(64), person: 'Ana Ng' }))
    ).rejects.toThrow(/belongs to Ben Lee, not Ana Ng/)
  })

  it('rejects --environment rather than silently retargeting the host', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane persons'](context(client, { environment: 'homelab' }))
    ).rejects.toThrow(/does not retarget/)
  })

  it('resolves --person to a principalId and mints the invite', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane invite'](
      context(client, {
        person: 'Ana Ng',
        scope: 'runtime',
        profile: 'full',
        ttl: '2',
        address: 'example.com'
      })
    )
    expect(calls).toContainEqual([
      'accounts.lane.mintInvite',
      {
        principalId: ANA,
        scope: 'runtime',
        accessProfile: 'full',
        ttlHours: 2,
        address: 'example.com'
      }
    ])
  })

  it('defaults --scope to runtime and omits ttl/address when not given', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane invite'](context(client, { person: 'Ana Ng', profile: 'full' }))
    expect(calls).toContainEqual([
      'accounts.lane.mintInvite',
      { principalId: ANA, scope: 'runtime', accessProfile: 'full' }
    ])
  })

  it('refuses an unknown --person before minting anything', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](context(client, { person: 'Nobody', profile: 'full' }))
    ).rejects.toThrow(/No person matches/)
    expect(calls.some(([method]) => method === 'accounts.lane.mintInvite')).toBe(false)
  })

  it('rejects an invalid --scope', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](
        context(client, { person: 'Ana Ng', scope: 'desktop', profile: 'full' })
      )
    ).rejects.toThrow(/--scope must be/)
  })

  it('rejects a --ttl outside 1..24', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](context(client, { person: 'Ana Ng', ttl: '0', profile: 'full' }))
    ).rejects.toThrow(/--ttl must be/)
    await expect(
      LANE_HANDLERS['lane invite'](
        context(client, { person: 'Ana Ng', ttl: '25', profile: 'full' })
      )
    ).rejects.toThrow(/--ttl must be/)
  })

  it('rejects --environment on lane invite like every other lane verb', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](
        context(client, { person: 'Ana Ng', environment: 'homelab', profile: 'full' })
      )
    ).rejects.toThrow(/does not retarget/)
  })

  it('S10-19 W-6: --profile is required, no default', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](context(client, { person: 'Ana Ng' }))
    ).rejects.toThrow(/--profile/)
    expect(calls.some(([method]) => method === 'accounts.lane.mintInvite')).toBe(false)
  })

  it('S10-19 W-6: rejects an invalid --profile value', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](context(client, { person: 'Ana Ng', profile: 'admin' }))
    ).rejects.toThrow(/--profile must be/)
  })

  it('S10-19 W-6 (NEG-20): refuses --scope mobile --profile peer at the CLI', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await expect(
      LANE_HANDLERS['lane invite'](
        context(client, { person: 'Ana Ng', scope: 'mobile', profile: 'peer' })
      )
    ).rejects.toThrow(/runtime-scoped only/)
    expect(calls.some(([method]) => method === 'accounts.lane.mintInvite')).toBe(false)
  })

  it('S10-19 W-6: --profile peer --scope runtime mints', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_HANDLERS['lane invite'](
      context(client, { person: 'Ana Ng', scope: 'runtime', profile: 'peer' })
    )
    expect(calls).toContainEqual([
      'accounts.lane.mintInvite',
      { principalId: ANA, scope: 'runtime', accessProfile: 'peer' }
    ])
  })
})
