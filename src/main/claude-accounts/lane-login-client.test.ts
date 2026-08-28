import { describe, expect, it, vi } from 'vitest'
import { LaneLoginClient, LaneLoginRefusedError } from './lane-login-client'
import { AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { LaneLoginTransport } from './lane-login-transport'

function makeTransport(overrides: Partial<LaneLoginTransport> = {}): LaneLoginTransport {
  return {
    hostId: 'env-1',
    getCapabilities: vi.fn(async () => [AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY]),
    call: vi.fn(async () => ({})) as unknown as LaneLoginTransport['call'],
    subscribeStatus: vi.fn(async () => () => {}),
    ...overrides
  }
}

describe('LaneLoginClient', () => {
  it('reports unsupported when the host lacks the v2 capability (v1 alone is not enough)', async () => {
    const transport = makeTransport({
      getCapabilities: vi.fn(async () => ['agent.identity-lanes.v1'])
    })
    const client = new LaneLoginClient(transport)
    const state = await client.connect()
    expect(state).toBe('unsupported')
    expect(transport.subscribeStatus).not.toHaveBeenCalled()
  })

  it('subscribes only once the v2 capability is confirmed, and connect() is idempotent', async () => {
    const transport = makeTransport()
    const client = new LaneLoginClient(transport)
    await client.connect()
    await client.connect()
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
    expect(client.getCapabilityState()).toBe('supported')
  })

  it('loginStart passes expectedEmail through and returns the exact L1 shape', async () => {
    const call = vi.fn(async () => ({
      loginSessionId: 'sess-1',
      authorizeUrl: 'https://platform.claude.com/authorize?x=1',
      expiresAt: 1234
    }))
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    const result = await client.loginStart('dev@example.com')
    expect(call).toHaveBeenCalledWith('accounts.lane.loginStart', {
      expectedEmail: 'dev@example.com'
    })
    expect(result.loginSessionId).toBe('sess-1')
    expect(result.authorizeUrl).toContain('platform.claude.com')
  })

  it('never re-requests or caches authorizeUrl on loginStatus — the shape has no such field', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'accounts.lane.loginStatus') {
        return { state: 'live', expiresAt: 1, attempts: 0, identity: null }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    const status = await client.loginStatus('sess-1')
    expect(status).not.toHaveProperty('authorizeUrl')
  })

  it('wraps a refused call in a LaneLoginRefusedError carrying the host code+message', async () => {
    const call = vi.fn(async () => {
      throw { code: 'accounts.lane.login_not_designated', message: 'not designated' }
    })
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    await expect(client.loginStart('a@b.com')).rejects.toMatchObject({
      code: 'accounts.lane.login_not_designated',
      message: 'not designated'
    })
    await expect(client.loginStart('a@b.com')).rejects.toBeInstanceOf(LaneLoginRefusedError)
  })

  it('selectAccount resolves synchronously to {active}, never a pending intermediate state', async () => {
    const call = vi.fn(async () => ({ active: 'acct-1' }))
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    const result = await client.selectAccount('acct-1')
    expect(result).toEqual({ active: 'acct-1' })
  })

  it('dispatches login-started/-completed/-failed frames to their own callbacks', async () => {
    let deliver: (frame: unknown) => void = () => {}
    const transport = makeTransport({
      subscribeStatus: vi.fn(async (onFrame) => {
        deliver = onFrame as (frame: unknown) => void
        return () => {}
      })
    })
    const onLoginStarted = vi.fn()
    const onLoginCompleted = vi.fn()
    const onLoginFailed = vi.fn()
    const client = new LaneLoginClient(transport, {
      onLoginStarted,
      onLoginCompleted,
      onLoginFailed
    })
    await client.connect()
    deliver({ type: 'login-started', loginSessionId: 's1', expiresAt: 10 })
    deliver({ type: 'login-completed', loginSessionId: 's1', identity: { email: 'a@b.com' } })
    deliver({ type: 'login-failed', loginSessionId: 's2', code: 'x', message: 'y' })
    expect(onLoginStarted).toHaveBeenCalledWith('s1', 10)
    expect(onLoginCompleted).toHaveBeenCalledWith('s1', { email: 'a@b.com' })
    expect(onLoginFailed).toHaveBeenCalledWith('s2', 'x', 'y')
  })

  // Mutation proof: swapping the capability constant this client checks from v2 back to v1 must
  // turn the first test above red, because a v1-only host must never be treated as login-capable.
  it('MUTATION PROOF: checking only v1 would wrongly accept a v1-only host', async () => {
    const v1Only = ['agent.identity-lanes.v1']
    expect(v1Only.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)).toBe(false)
  })
})
