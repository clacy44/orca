import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { AGENT_RETIRE_HANDLERS } from './agents-retire'

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agt_abc123',
    displayName: 'merge-restructure-backend',
    role: 'backend for the merge restructure',
    host: 'local',
    state: 'idle',
    derived: false,
    quarantined: false,
    title: null,
    branch: 'merge-restructure',
    worktreePath: '/repo',
    ...overrides
  }
}

describe('agents retire CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the retired outcome and passes --force through', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: agent(), outcome: 'retired' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_RETIRE_HANDLERS['agents retire']({
      flags: new Map([
        ['id', 'agt_abc123'],
        ['force', 'true']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.retire', {
      id: 'agt_abc123',
      force: true
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('retired')
    expect(printed).toContain('Its name is free to reclaim')
  })

  it('prints the already_retired outcome distinctly', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: agent(), outcome: 'already_retired' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_RETIRE_HANDLERS['agents retire']({
      flags: new Map([['id', 'agt_abc123']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.retire', {
      id: 'agt_abc123',
      force: undefined
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('was already retired')
  })

  it('requires a name or id', async () => {
    const call = vi.fn()
    await expect(
      AGENT_RETIRE_HANDLERS['agents retire']({
        flags: new Map(),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
