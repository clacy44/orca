import { describe, expect, it, vi } from 'vitest'

import { LANE_LOGIN_HANDLERS } from './lane-login'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const CAPABILITIES = [AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY]
const ANA = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function readStatusResult() {
  return {
    grants: [],
    principals: [
      {
        principalId: ANA,
        displayName: 'Ana Ng',
        delegatedGrantId: null,
        laneState: 'loaded',
        boundDeviceIds: [],
        unverifiedLegacy: false
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
    return Promise.resolve({ capabilities: CAPABILITIES })
  }
  if (method === 'accounts.lane.readStatus') {
    return Promise.resolve(readStatusResult())
  }
  if (method === 'accounts.lane.loginStartInline') {
    return Promise.resolve({
      loginSessionId: 'session-1',
      authorizeUrl: 'https://platform.claude.com/oauth/authorize?redirect_uri=x',
      expiresAt: Date.now() + 180_000
    })
  }
  if (method === 'accounts.lane.loginSubmitCodeInline') {
    return Promise.resolve({
      status: 'completed',
      identity: { email: 'ana@x.com' },
      attemptsRemaining: 4
    })
  }
  if (method === 'accounts.lane.loginCancelInline') {
    return Promise.resolve({ cancelled: true })
  }
  if (method === 'accounts.lane.logoutInline') {
    return Promise.resolve({ cleared: ['.credentials.json'] })
  }
  if (method === 'accounts.lane.listAccountsInline') {
    return Promise.resolve({
      accounts: [
        { laneAccountId: 'acct-1', email: 'ana@x.com', label: null, active: true },
        { laneAccountId: 'acct-2', email: 'ana-work@x.com', label: 'work', active: false }
      ]
    })
  }
  if (method === 'accounts.lane.selectAccountInline') {
    return Promise.resolve({ active: 'acct-2' })
  }
  return Promise.resolve({})
}

describe('lane-login CLI handlers (S9-L1 §modules E)', () => {
  it('registers exactly the four host-inline verbs', () => {
    expect(Object.keys(LANE_LOGIN_HANDLERS).sort()).toEqual(
      ['lane accounts', 'lane login', 'lane logout', 'lane use'].sort()
    )
  })

  it('refuses lane login on a runtime without the lane capability', async () => {
    const { client } = makeClient((method) =>
      method === 'status.get' ? Promise.resolve({ capabilities: [] }) : defaultImpl(method)
    )
    await expect(
      LANE_LOGIN_HANDLERS['lane login'](context(client, { person: 'Ana Ng', email: 'a@x.com' }))
    ).rejects.toThrow(/Update the host/)
  })

  it('requires --email for lane login', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_LOGIN_HANDLERS['lane login'](context(client, { person: 'Ana Ng' }))
    ).rejects.toThrow(/Missing a value for --email/)
  })

  it('runs a scripted login (--code) through loginStartInline then loginSubmitCodeInline', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_LOGIN_HANDLERS['lane login'](
      context(client, { person: 'Ana Ng', email: 'ana@x.com', code: '123456' })
    )
    expect(calls).toContainEqual([
      'accounts.lane.loginStartInline',
      { principalId: ANA, expectedEmail: 'ana@x.com' }
    ])
    expect(calls).toContainEqual([
      'accounts.lane.loginSubmitCodeInline',
      { principalId: ANA, loginSessionId: 'session-1', code: '123456' }
    ])
  })

  it('throws (a script failure) when a scripted --code is rejected, rather than looping', async () => {
    const { client } = makeClient((method, params) => {
      if (method === 'accounts.lane.loginSubmitCodeInline') {
        return Promise.resolve({ status: 'rejected', identity: null, attemptsRemaining: 2 })
      }
      return defaultImpl(method, params)
    })
    await expect(
      LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'ana@x.com', code: 'wrong' })
      )
    ).rejects.toThrow(/not accepted/)
  })

  it('lane login --cancel calls loginCancelInline and never starts a session', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_LOGIN_HANDLERS['lane login'](context(client, { person: 'Ana Ng', cancel: true }))
    expect(calls).toContainEqual(['accounts.lane.loginCancelInline', { principalId: ANA }])
    expect(calls.some(([method]) => method === 'accounts.lane.loginStartInline')).toBe(false)
  })

  it('lane logout resolves --person and calls logoutInline', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_LOGIN_HANDLERS['lane logout'](context(client, { person: 'Ana Ng' }))
    expect(calls).toContainEqual(['accounts.lane.logoutInline', { principalId: ANA }])
  })

  it('lane accounts resolves --person and lists via listAccountsInline', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_LOGIN_HANDLERS['lane accounts'](context(client, { person: 'Ana Ng' }, true))
    expect(calls).toContainEqual(['accounts.lane.listAccountsInline', { principalId: ANA }])
  })

  it('lane use resolves an account by email and calls selectAccountInline with its id', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_LOGIN_HANDLERS['lane use'](
      context(client, { person: 'Ana Ng', account: 'ana-work@x.com' })
    )
    expect(calls).toContainEqual([
      'accounts.lane.selectAccountInline',
      { principalId: ANA, laneAccountId: 'acct-2' }
    ])
  })

  it('lane use resolves an account by its laneAccountId directly', async () => {
    const { client, calls } = makeClient(defaultImpl)
    await LANE_LOGIN_HANDLERS['lane use'](context(client, { person: 'Ana Ng', account: 'acct-2' }))
    expect(calls).toContainEqual([
      'accounts.lane.selectAccountInline',
      { principalId: ANA, laneAccountId: 'acct-2' }
    ])
  })

  it('lane use refuses an --account selector matching no captured login', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_LOGIN_HANDLERS['lane use'](
        context(client, { person: 'Ana Ng', account: 'nobody@x.com' })
      )
    ).rejects.toThrow(/No signed-in account matches/)
  })

  it('rejects --environment on the four host-inline lane verbs like every other lane verb', async () => {
    const { client } = makeClient(defaultImpl)
    await expect(
      LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'a@x.com', environment: 'homelab' })
      )
    ).rejects.toThrow(/does not retarget/)
    await expect(
      LANE_LOGIN_HANDLERS['lane logout'](
        context(client, { person: 'Ana Ng', environment: 'homelab' })
      )
    ).rejects.toThrow(/does not retarget/)
    await expect(
      LANE_LOGIN_HANDLERS['lane accounts'](
        context(client, { person: 'Ana Ng', environment: 'homelab' })
      )
    ).rejects.toThrow(/does not retarget/)
    await expect(
      LANE_LOGIN_HANDLERS['lane use'](
        context(client, { person: 'Ana Ng', account: 'a', environment: 'homelab' })
      )
    ).rejects.toThrow(/does not retarget/)
  })
})
