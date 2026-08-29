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

  it('emits a login-started JSON line under --json as soon as loginStartInline resolves, before the final result line', async () => {
    const { client } = makeClient(defaultImpl)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'ana@x.com', code: '123456' }, true)
      )
      const lines = logSpy.mock.calls.map((call) => call[0] as string)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0])).toEqual({
        event: 'login-started',
        loginSessionId: 'session-1',
        authorizeUrl: 'https://platform.claude.com/oauth/authorize?redirect_uri=x',
        expiresAt: expect.any(Number)
      })
      expect(JSON.parse(lines[1])).toMatchObject({ ok: true })
    } finally {
      logSpy.mockRestore()
    }
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

  // S9 design §2d closure principle: the CLI owns a host-inline session it started, so an
  // interrupted terminal must cancel it rather than leaving it live for the 180s TTL.
  describe('interrupting a pending login (§2d closure principle)', () => {
    // Why: identify the listener THIS call registered by set difference — matches
    // account.test.ts's helper, since `process.listeners(signal)` also carries vitest's own.
    function newSignalListener(
      signal: NodeJS.Signals,
      before: readonly unknown[]
    ): (signal: NodeJS.Signals) => void {
      const added = process.listeners(signal).filter((listener) => !before.includes(listener))
      if (added.length !== 1) {
        throw new Error(`Expected 1 new ${signal} listener, found ${added.length}`)
      }
      return added[0] as (signal: NodeJS.Signals) => void
    }

    it('cancels the started session and exits non-zero when SIGINT interrupts the code prompt', async () => {
      const { client, calls } = makeClient(defaultImpl)
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const listenersBefore = process.listeners('SIGINT')

      const pending = LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'ana@x.com' })
      )
      await vi.waitFor(() =>
        expect(calls.some(([method]) => method === 'accounts.lane.loginStartInline')).toBe(true)
      )

      newSignalListener('SIGINT', listenersBefore)('SIGINT')

      await vi.waitFor(() =>
        expect(calls).toContainEqual(['accounts.lane.loginCancelInline', { principalId: ANA }])
      )
      // loginCancelInline's own schema carries no loginSessionId (the runtime resolves the one
      // host-inline session THIS principal has in flight) — this IS that call, since it is the
      // only session the runtime knows about here.
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))

      await pending
      exitSpy.mockRestore()
    })

    it('does not cancel a code already handed to the runtime — it may be mid-turn', async () => {
      let releaseSubmit: (() => void) | undefined
      const { client, calls } = makeClient((method, params) => {
        if (method === 'accounts.lane.loginSubmitCodeInline') {
          return new Promise((resolve) => {
            releaseSubmit = () =>
              resolve({
                status: 'completed',
                identity: { email: 'ana@x.com' },
                attemptsRemaining: 4
              })
          })
        }
        return defaultImpl(method, params)
      })
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const listenersBefore = process.listeners('SIGINT')

      const pending = LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'ana@x.com', code: '123456' })
      )
      await vi.waitFor(() =>
        expect(calls.some(([method]) => method === 'accounts.lane.loginSubmitCodeInline')).toBe(
          true
        )
      )

      newSignalListener('SIGINT', listenersBefore)('SIGINT')
      await Promise.resolve()
      await Promise.resolve()
      expect(calls.some(([method]) => method === 'accounts.lane.loginCancelInline')).toBe(false)

      releaseSubmit!()
      await pending

      expect(calls.some(([method]) => method === 'accounts.lane.loginCancelInline')).toBe(false)
      exitSpy.mockRestore()
    })

    it('cancels only once when a second signal arrives before the first finishes', async () => {
      const { client, calls } = makeClient(defaultImpl)
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const sigintBefore = process.listeners('SIGINT')
      const sigtermBefore = process.listeners('SIGTERM')

      const pending = LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'ana@x.com' })
      )
      await vi.waitFor(() =>
        expect(calls.some(([method]) => method === 'accounts.lane.loginStartInline')).toBe(true)
      )

      const onSigint = newSignalListener('SIGINT', sigintBefore)
      const onSigterm = newSignalListener('SIGTERM', sigtermBefore)
      onSigint('SIGINT')
      onSigterm('SIGTERM')

      await vi.waitFor(() =>
        expect(
          calls.filter(([method]) => method === 'accounts.lane.loginCancelInline')
        ).toHaveLength(1)
      )
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
      await pending

      expect(exitSpy).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(130)
      exitSpy.mockRestore()
    })

    it('negative control: no signal, no cancel — a normal scripted login never calls loginCancelInline', async () => {
      const { client, calls } = makeClient(defaultImpl)
      await LANE_LOGIN_HANDLERS['lane login'](
        context(client, { person: 'Ana Ng', email: 'ana@x.com', code: '123456' })
      )
      expect(calls.some(([method]) => method === 'accounts.lane.loginCancelInline')).toBe(false)
    })
  })
})
