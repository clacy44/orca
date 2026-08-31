import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { AGENT_HANDLERS } from './agents'

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

describe('agents CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('register prints a populated next command', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: agent(), created: true, reMinted: false }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents register']({
      flags: new Map([
        ['name', 'merge-restructure-backend'],
        ['role', 'backend for the merge restructure']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.register', {
      name: 'merge-restructure-backend',
      role: 'backend for the merge restructure'
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('Registered agent "merge-restructure-backend"')
    expect(printed).toContain('Next: orca orchestration send --to agent:agt_abc123')
  })

  it('find prints exact text for resolved, with the populated next command', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        outcome: 'resolved',
        query: 'the merge-restructure backend agent',
        candidates: [{ ...agent(), confidence: 0.92, why: ['merge', 'restructure', 'backend'] }],
        nextSteps: []
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents find']({
      flags: new Map([['query', 'the merge-restructure backend agent']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('Resolved: merge-restructure-backend (agt_abc123) — confidence 0.92.')
    expect(printed).toContain('Next: orca orchestration send --to agent:agt_abc123')
  })

  it('find prints exact text for ambiguous, including the disambiguating command', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        outcome: 'ambiguous',
        query: 'the merge-restructure backend agent',
        candidates: [
          { ...agent({ id: 'agt_1', displayName: 'merge-backend-a' }), confidence: 0.6, why: [] },
          { ...agent({ id: 'agt_2', displayName: 'merge-backend-b' }), confidence: 0.55, why: [] }
        ],
        nextSteps: ['orca agents show --id agt_1', 'orca agents show --id agt_2']
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents find']({
      flags: new Map([['query', 'the merge-restructure backend agent']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('Ambiguous: 2 candidates match "the merge-restructure backend agent"')
    expect(printed).toContain('merge-backend-a (agt_1)')
    expect(printed).toContain('merge-backend-b (agt_2)')
    expect(printed).toContain('Next: orca agents show --id agt_1')
  })

  it('find prints exact text for no_match, pointing at agents list', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        outcome: 'no_match',
        query: 'a completely unrelated description',
        candidates: [],
        nextSteps: ['orca agents list']
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents find']({
      flags: new Map([['query', 'a completely unrelated description']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toBe(
      'No match for "a completely unrelated description".\nNext: orca agents list'
    )
  })

  it('list marks a derived agent with a leading ~ and shows omitted quarantined count', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        agents: [
          agent({ derived: true, displayName: 'merge-restructure-claude-a1b2', role: null })
        ],
        liveCount: 0,
        derivedCount: 1,
        omitted: { quarantined: 2, derived: 0 }
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents list']({
      flags: new Map(),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('~merge-restructure-claude-a1b2')
    expect(printed).toContain('2 quarantined agent(s) omitted')
  })

  it('show resolves a bare id positional (agt_ prefix) without --id', async () => {
    const call = vi.fn().mockResolvedValue({ result: { agent: agent(), pushable: true } })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents show']({
      flags: new Map([['name', 'agt_abc123']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { id: 'agt_abc123' })
  })

  // FIX (major, re-review): a quarantined derived row must never get a working send address.
  it('show for a quarantined derived agent prints the show next-step, never a send address', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        agent: agent({ derived: true, quarantined: true, terminalHandle: undefined }),
        pushable: false
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents show']({
      flags: new Map([['name', 'agt_abc123']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('Next: orca agents show --id agt_abc123')
    expect(printed).not.toContain('send --to')
  })

  it('quarantine prints a populated next command', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: agent({ quarantined: true }) }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents quarantine']({
      flags: new Map([
        ['id', 'agt_abc123'],
        ['reason-code', 'flagged']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('is now quarantined')
    expect(printed).toContain('Next: orca agents show --id agt_abc123')
  })

  it('retire prints the retired outcome and passes --force through', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: agent(), outcome: 'retired' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents retire']({
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

  it('retire prints the already_retired outcome distinctly', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agent: agent(), outcome: 'already_retired' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_HANDLERS['agents retire']({
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
})
