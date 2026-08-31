import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeRpcFailureError } from '../runtime/types'
import { formatCliError } from '../format'
import { AGENT_PACT_HANDLERS } from './agents-pact'

function pactThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thr_9fk2',
    pact_state: 'engaged',
    pact_proposer_agent_id: 'agt_me',
    pact_with_agent_id: 'agt_them',
    pact_turn_agent_id: 'agt_them',
    pact_steps_total: 6,
    pact_ordinal: 3,
    pact_paused_at: null,
    pact_pause_reason: null,
    ...overrides
  }
}

describe('agents pact CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('propose: resolves --with to agent:<id>, forwards --on/--steps, and prints the exact nextSteps', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          thread: pactThread({ pact_state: 'proposed', pact_turn_agent_id: null }),
          nextSteps: [
            'orca agents pact --on thr_9fk2 --accept',
            'orca agents wait --thread thr_9fk2 --for pact'
          ]
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents pact']({
      flags: new Map<string, string | boolean>([
        ['with', 'backend-merge'],
        ['on', 'thr_9fk2'],
        ['steps', '6']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
    expect(call).toHaveBeenCalledWith('orchestration.threads.pact', {
      id: 'thr_9fk2',
      with: 'agent:agt_them',
      steps: 6,
      open: undefined,
      accept: undefined,
      decline: undefined,
      pause: undefined,
      resume: undefined,
      release: undefined,
      reasonCode: undefined
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('pact proposed with backend-merge on thr_9fk2 (6 steps)')
    expect(printed).toContain('Next: orca agents pact --on thr_9fk2 --accept')
    expect(printed).toContain('Next: orca agents wait --thread thr_9fk2 --for pact')
  })

  it('accept: --on and --accept only, no peer resolution round trip', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        thread: pactThread(),
        nextSteps: ['orca agents wait --thread thr_9fk2 --for step']
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents pact']({
      flags: new Map<string, string | boolean>([
        ['on', 'thr_9fk2'],
        ['accept', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      'orchestration.threads.pact',
      expect.objectContaining({ id: 'thr_9fk2', accept: true })
    )
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('pact engaged. Your turn is second.')
    expect(printed).toContain('Next: orca agents wait --thread thr_9fk2 --for step')
  })

  it('resume: requested outcome (non-pausing side) prints "Requested:" without throwing', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        thread: pactThread({ pact_paused_at: '2026-01-01 00:00:00' }),
        requested: true,
        nextSteps: ['orca agents pact --resume --on thr_9fk2']
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents pact']({
      flags: new Map<string, string | boolean>([
        ['on', 'thr_9fk2'],
        ['resume', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('Requested:')
    expect(printed).toContain('theirs to confirm')
  })

  it('rejects passing more than one action flag', async () => {
    await expect(
      AGENT_PACT_HANDLERS['agents pact']({
        flags: new Map<string, string | boolean>([
          ['on', 'thr_1'],
          ['accept', true],
          ['decline', true]
        ]),
        client: { call: vi.fn() } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toThrow(/exactly one of/)
  })

  it('rejects --steps and --open together', async () => {
    const call = vi.fn().mockImplementation((method: string) =>
      method === 'orchestration.agents.get'
        ? Promise.resolve({
            result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
          })
        : Promise.resolve({ result: {} })
    )
    await expect(
      AGENT_PACT_HANDLERS['agents pact']({
        flags: new Map<string, string | boolean>([
          ['with', 'backend-merge'],
          ['on', 'thr_1'],
          ['steps', '3'],
          ['open', true]
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toThrow(/mutually exclusive/)
  })

  it('rejects a missing --on for an action flag', async () => {
    await expect(
      AGENT_PACT_HANDLERS['agents pact']({
        flags: new Map<string, string | boolean>([['accept', true]]),
        client: { call: vi.fn() } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toThrow(/--on/)
  })

  it('--show reads the ledger and renders the ASCII table with a third-party-check footer', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        thread: pactThread(),
        entries: [
          {
            ordinal: 0,
            kind: 'propose',
            actorAgentId: 'agt_me',
            actorDisplayName: 'fable-chair',
            at: '2026-01-01 14:01:07',
            summary: null,
            summaryShaPrefix: null,
            withheld: false,
            purged: false,
            reasonCode: null
          },
          {
            ordinal: 1,
            kind: 'step',
            actorAgentId: 'agt_me',
            actorDisplayName: 'fable-chair',
            at: '2026-01-01 14:06:12',
            summary: 'spec frozen at rev 2',
            summaryShaPrefix: 'abc123',
            withheld: false,
            purged: false,
            reasonCode: null
          },
          {
            ordinal: 2,
            kind: 'step',
            actorAgentId: 'agt_them',
            actorDisplayName: 'backend-merge',
            at: '2026-01-01 14:19:55',
            summary: null,
            summaryShaPrefix: '4c1e77b0a233',
            withheld: true,
            purged: false,
            reasonCode: null
          }
        ],
        omitted: { purged: 0, withheld: 1 },
        nextSteps: []
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents pact']({
      flags: new Map<string, string | boolean>([['show', 'thr_9fk2']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.threads.pactLedger', { threadId: 'thr_9fk2' })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('pact thr_9fk2')
    expect(printed).toContain('fable-chair <-> backend-merge')
    expect(printed).toContain('engaged, 3/6, turn: backend-merge')
    expect(printed).toContain('"spec frozen at rev 2"')
    expect(printed).toContain('[withheld - author quarantined - sha256 4c1e77b0a233]')
    expect(printed).toContain('Third-party check: orca agents pact --show thr_9fk2 --json')
  })

  it('--show on a threadless pact prints a clean no-pact message, not a crash', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        thread: pactThread({
          pact_state: null,
          pact_proposer_agent_id: null,
          pact_with_agent_id: null,
          pact_turn_agent_id: null,
          pact_steps_total: null,
          pact_ordinal: 0
        }),
        entries: [],
        omitted: { purged: 0, withheld: 0 },
        nextSteps: []
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents pact']({
      flags: new Map<string, string | boolean>([['show', 'thr_plain']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('No pact on thread thr_plain.')
    expect(printed).toContain('orca agents pact --with <name> --on thr_plain')
  })

  it('step: forwards --thread/--done/--acknowledge-gate and prints the ordinal', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        ordinal: 3,
        of: 6,
        turn: 'agt_them',
        messageId: 'msg_1',
        sequence: 44,
        gateFlags: null,
        nextSteps: ['orca agents wait --thread thr_9fk2 --for step']
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents step']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_9fk2'],
        ['done', 'spec frozen at rev 2'],
        ['acknowledge-gate', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.threads.step', {
      threadId: 'thr_9fk2',
      done: 'spec frozen at rev 2',
      acknowledgeGate: true
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('step 3/6 recorded')
    expect(printed).toContain('Next: orca agents wait --thread thr_9fk2 --for step')
  })

  it('a typed pact refusal (pact_exists, with nextSteps) is never swallowed and renders its escape hatch', async () => {
    const refusal = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: {
        code: 'pact_exists',
        message:
          'Refused: thr_9fk2 already has a pact (engaged, 3/6). Read it (orca agents pact --show thr_9fk2); a released pact can be proposed on again.',
        data: { nextSteps: ['orca agents pact --show thr_9fk2'] }
      },
      _meta: { runtimeId: null }
    })
    const call = vi.fn().mockRejectedValue(refusal)
    await expect(
      AGENT_PACT_HANDLERS['agents pact']({
        flags: new Map<string, string | boolean>([
          ['on', 'thr_9fk2'],
          ['accept', true]
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toBe(refusal)
    const rendered = formatCliError(refusal)
    expect(rendered).toContain('already has a pact')
    expect(rendered).toContain('Next step: orca agents pact --show thr_9fk2')
  })
})

describe('agents invite CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves --agent to an id and invites onto --thread', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          participant: {
            thread_id: 'thr_9fk2',
            agent_id: 'agt_them',
            invite_state: 'pending'
          },
          nextSteps: ['orca agents thread --id thr_9fk2']
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_PACT_HANDLERS['agents invite']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_9fk2'],
        ['agent', 'backend-merge']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
    expect(call).toHaveBeenCalledWith('orchestration.threads.invite', {
      threadId: 'thr_9fk2',
      agentId: 'agt_them'
    })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('Invited backend-merge to thread thr_9fk2.')
    expect(printed).toContain('Next: orca agents thread --id thr_9fk2')
  })

  it('a quarantine refusal from the invite RPC propagates with its nextSteps intact', async () => {
    const refusal = new RuntimeRpcFailureError({
      id: 'req_1',
      ok: false,
      error: {
        code: 'agent_quarantined',
        message:
          'Refused: a pact needs two accountable participants and backend-merge is quarantined.',
        data: { nextSteps: ['orca agents quarantine backend-merge --lift'] }
      },
      _meta: { runtimeId: null }
    })
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.reject(refusal)
    })
    await expect(
      AGENT_PACT_HANDLERS['agents invite']({
        flags: new Map<string, string | boolean>([
          ['thread', 'thr_9fk2'],
          ['agent', 'backend-merge']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toBe(refusal)
  })
})
