import { describe, expect, it, vi } from 'vitest'
import {
  cancelLaneLogin,
  startLaneLogin,
  submitLaneLoginCode,
  type LaneLoginRequestClient
} from './lane-login-request'

function makeClient(handler: (method: string, params: unknown) => unknown): LaneLoginRequestClient {
  return {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      const result = handler(method, params)
      if (result && typeof result === 'object' && 'refused' in (result as object)) {
        return {
          ok: false,
          error: (result as { refused: { code: string; message: string } }).refused
        }
      }
      return { ok: true, result }
    })
  }
}

describe('startLaneLogin', () => {
  it('passes expectedEmail through and returns the awaiting-code stage with the exact L1 shape', async () => {
    const client = makeClient(() => ({
      loginSessionId: 's1',
      authorizeUrl: 'https://platform.claude.com/authorize?x=1',
      expiresAt: 42
    }))
    const state = await startLaneLogin(client, 'dev@example.com')
    expect(client.sendRequest).toHaveBeenCalledWith('accounts.lane.loginStart', {
      expectedEmail: 'dev@example.com'
    })
    expect(state).toEqual({
      stage: 'awaiting-code',
      loginSessionId: 's1',
      authorizeUrl: 'https://platform.claude.com/authorize?x=1',
      expiresAt: 42
    })
  })

  it('renders the host refusal sentence verbatim, never a client-invented string', async () => {
    const client = makeClient(() => ({
      refused: { code: 'accounts.lane.login_not_designated', message: 'host sentence' }
    }))
    const state = await startLaneLogin(client, 'dev@example.com')
    expect(state).toEqual({ stage: 'error', message: 'host sentence' })
  })
})

describe('submitLaneLoginCode', () => {
  it('completes with the verified identity email', async () => {
    const client = makeClient(() => ({
      status: 'completed',
      identity: { email: 'dev@example.com' },
      attemptsRemaining: 3
    }))
    const state = await submitLaneLoginCode(client, 's1', '123456')
    expect(state).toEqual({ stage: 'completed', email: 'dev@example.com' })
  })

  it('a rejected code produces an error stage naming attempts remaining, not a raw code', async () => {
    const client = makeClient(() => ({ status: 'rejected', identity: null, attemptsRemaining: 2 }))
    const state = await submitLaneLoginCode(client, 's1', 'bad')
    expect(state.stage).toBe('error')
  })
})

describe('cancelLaneLogin', () => {
  it('sends loginCancel with the session id', async () => {
    const client = makeClient(() => ({ cancelled: true }))
    await cancelLaneLogin(client, 's1')
    expect(client.sendRequest).toHaveBeenCalledWith('accounts.lane.loginCancel', {
      loginSessionId: 's1'
    })
  })
})
