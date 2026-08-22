import { describe, expect, it, vi } from 'vitest'
import {
  collectEnvironmentTerminalRoster,
  LOCAL_ROSTER_ENVIRONMENT,
  type RosterProbe,
  type RosterProbeResponse
} from './environment-terminal-roster'

function reachable(
  environment: string,
  environmentId: string | null,
  response: RosterProbeResponse
): RosterProbe {
  return { environment, environmentId, listTerminals: async () => response }
}

function failing(environment: string, error: unknown): RosterProbe {
  return {
    environment,
    environmentId: `env_${environment}`,
    listTerminals: async () => {
      throw error
    }
  }
}

function rpcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('cross-runtime terminal roster', () => {
  it('tags every terminal row with its runtime identity', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      reachable(LOCAL_ROSTER_ENVIRONMENT, null, {
        runtimeId: 'runtime_local',
        terminals: [
          { handle: 'term_a', title: '✳ Claude Code', worktreePath: '/repo/a' },
          { handle: 'term_b', title: null }
        ]
      }),
      reachable('vps', 'env_vps', {
        runtimeId: 'runtime_vps',
        terminals: [{ handle: 'term_c', title: 'codex' }]
      })
    ])

    expect(roster.rows).toEqual([
      {
        environment: 'local',
        environmentId: null,
        runtimeId: 'runtime_local',
        reachability: 'ok',
        reason: null,
        terminal: 'term_a',
        title: '✳ Claude Code',
        agent: 'Claude Code',
        worktreePath: '/repo/a'
      },
      {
        environment: 'local',
        environmentId: null,
        runtimeId: 'runtime_local',
        reachability: 'ok',
        reason: null,
        terminal: 'term_b',
        title: null,
        agent: null,
        worktreePath: null
      },
      {
        environment: 'vps',
        environmentId: 'env_vps',
        runtimeId: 'runtime_vps',
        reachability: 'ok',
        reason: null,
        terminal: 'term_c',
        title: 'codex',
        agent: 'Codex',
        worktreePath: null
      }
    ])
    expect(roster).toMatchObject({ runtimeCount: 2, reachableCount: 2, terminalCount: 3 })
  })

  it('keeps a reachable runtime that owns no terminals', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      reachable('idle', 'env_idle', { runtimeId: 'runtime_idle', terminals: [] })
    ])

    expect(roster.rows).toHaveLength(1)
    expect(roster.rows[0]).toMatchObject({
      environment: 'idle',
      reachability: 'ok',
      terminal: null
    })
    expect(roster.terminalCount).toBe(0)
  })

  it('degrades one dead peer to an unreachable row without failing the roster', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      reachable(LOCAL_ROSTER_ENVIRONMENT, null, {
        runtimeId: 'runtime_local',
        terminals: [{ handle: 'term_a', title: null }]
      }),
      failing('vps', rpcError('runtime_unreachable', 'Connection refused.'))
    ])

    expect(roster.rows.map((row) => [row.environment, row.reachability, row.reason])).toEqual([
      ['local', 'ok', null],
      ['vps', 'unreachable', 'runtime_unreachable: Connection refused.']
    ])
    expect(roster).toMatchObject({ runtimeCount: 2, reachableCount: 1, terminalCount: 1 })
  })

  it('separates a missing capability from an unreachable runtime', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      failing('old-peer', rpcError('method_not_found', 'Unknown method: terminal.list')),
      failing('offline', new Error('socket hang up'))
    ])

    expect(roster.rows.map((row) => row.reachability)).toEqual([
      'capability-missing',
      'unreachable'
    ])
    expect(roster.rows[1].reason).toBe('socket hang up')
    expect(roster.reachableCount).toBe(0)
  })

  it('bounds a hung peer with its own timeout and still reports the others', async () => {
    vi.useFakeTimers()
    try {
      const pending = collectEnvironmentTerminalRoster(
        [
          reachable(LOCAL_ROSTER_ENVIRONMENT, null, { runtimeId: 'runtime_local', terminals: [] }),
          {
            environment: 'hung',
            environmentId: 'env_hung',
            listTerminals: () => new Promise<RosterProbeResponse>(() => {})
          }
        ],
        { timeoutMs: 2_000 }
      )
      await vi.advanceTimersByTimeAsync(2_000)
      const roster = await pending

      expect(roster.rows[1]).toMatchObject({
        environment: 'hung',
        reachability: 'unreachable',
        reason: 'no response within 2000ms'
      })
      expect(roster.reachableCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a peer probe that throws before its request is sent', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      {
        environment: 'stale',
        environmentId: 'env_stale',
        listTerminals: () => {
          throw rpcError('invalid_argument', 'Saved environment has no endpoint.')
        }
      }
    ])

    expect(roster.rows[0]).toMatchObject({
      reachability: 'unreachable',
      reason: 'invalid_argument: Saved environment has no endpoint.'
    })
  })

  it('keeps a peer that published no presence distinguishable from one where nobody is attached', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      reachable('old-host', 'env_old', {
        runtimeId: 'runtime_old',
        terminals: [{ handle: 'term_old', title: null }]
      }),
      reachable('new-host', 'env_new', {
        runtimeId: 'runtime_new',
        terminals: [
          { handle: 'term_idle', title: null, presence: '' },
          { handle: 'term_busy', title: null, presence: 'Ana (typing)' }
        ]
      })
    ])

    // Why `in` and not the value: an explicit `presence: undefined` would read as "nobody" at the
    // formatter, which is the one thing this column must never say about an unknown peer.
    expect(roster.rows.map((row) => ('presence' in row ? row.presence : 'absent'))).toEqual([
      'absent',
      '',
      'Ana (typing)'
    ])
  })

  it('states nobody rather than unknown on the row of a runtime with no terminals', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      reachable('idle', 'env_idle', { runtimeId: 'runtime_idle', terminals: [] })
    ])

    expect(roster.rows[0].presence).toBeNull()
  })

  it('reports truncation from any polled runtime', async () => {
    const roster = await collectEnvironmentTerminalRoster([
      reachable('a', 'env_a', { runtimeId: 'runtime_a', terminals: [], truncated: false }),
      reachable('b', 'env_b', {
        runtimeId: 'runtime_b',
        terminals: [{ handle: 'term_b', title: null }],
        truncated: true
      })
    ])

    expect(roster.truncated).toBe(true)
  })
})
