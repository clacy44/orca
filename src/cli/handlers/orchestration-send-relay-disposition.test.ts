import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// S10-15 review B-2: split out of orchestration.test.ts (max-lines ratchet) — `orchestration
// send`'s relay disposition must be checked BEFORE the generic `'message' in r` branch, or a
// cross-host send the peer refused prints "Sent <id>" and exits 0.
const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

describe('orchestration send — cross-host relay disposition (S10-15 review B-2)', () => {
  const originalExitCode = process.exitCode
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
    process.exitCode = undefined
  })
  afterEach(() => {
    process.exitCode = originalExitCode
  })

  const invokeSend = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

  it('prints a "Warning: ... was NOT delivered" and sets exitCode=1 when the peer refused the relay — never "Sent <id>" (B-2)', async () => {
    const resultPayload = {
      message: { id: 'msg_refused01' },
      relay: {
        destination: 'peer_agent',
        environment: 'windows',
        accepted: false,
        code: 'agent_quarantined',
        reason: 'answerer is quarantined and cannot receive mail.'
      }
    }
    callMock.mockResolvedValue({ result: resultPayload })
    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'agent:agt_them'],
        ['subject', 'hi'],
        ['host', 'windows']
      ])
    )
    expect(process.exitCode).toBe(1)
    const lastCall = vi.mocked(printResult).mock.calls.at(-1)
    const formatter = lastCall?.[2] as (r: unknown) => string
    const printed = formatter(resultPayload)
    expect(printed).toContain('NOT delivered')
    expect(printed).not.toMatch(/^Sent /)
    expect(printed).toContain('windows')
    expect(printed).toContain('answerer is quarantined')
  })

  it('accepted relay formatter never falls through to the generic "Sent <id>" branch', async () => {
    const resultPayload = {
      message: { id: 'msg_accepted01' },
      relay: { destination: 'peer_agent', environment: 'windows', accepted: true }
    }
    callMock.mockResolvedValue({ result: resultPayload })
    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'agent:agt_them'],
        ['subject', 'hi'],
        ['host', 'windows']
      ])
    )
    expect(process.exitCode).toBeUndefined()
    const lastCall = vi.mocked(printResult).mock.calls.at(-1)
    const formatter = lastCall?.[2] as (r: unknown) => string
    const printed = formatter(resultPayload)
    expect(printed).toBe('Relayed msg_accepted01 to windows')
  })
})
