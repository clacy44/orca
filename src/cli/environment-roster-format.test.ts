import { describe, expect, it } from 'vitest'
import { formatEnvironmentTerminalRoster } from './environment-roster-format'
import type { RosterRow } from './runtime/environment-terminal-roster'

function row(overrides: Partial<RosterRow>): RosterRow {
  return {
    environment: 'local',
    environmentId: null,
    runtimeId: 'runtime_local',
    reachability: 'ok',
    reason: null,
    terminal: 'term_a',
    title: null,
    agent: null,
    worktreePath: null,
    ...overrides
  }
}

describe('environment roster output', () => {
  it('prints one tagged line per terminal and a reachability summary', () => {
    expect(
      formatEnvironmentTerminalRoster({
        rows: [
          row({ title: '✳ Claude Code', agent: 'Claude Code' }),
          row({
            environment: 'vps',
            environmentId: 'env_vps',
            runtimeId: null,
            reachability: 'unreachable',
            reason: 'no response within 10000ms',
            terminal: null
          })
        ],
        runtimeCount: 2,
        reachableCount: 1,
        terminalCount: 1,
        truncated: false
      })
    ).toBe(
      [
        'local  runtime_local  ok  term_a  ✳ Claude Code  [Claude Code]',
        'vps  unknown-runtime  unreachable(no response within 10000ms)  (no terminals)  (untitled)',
        '',
        '1/2 runtimes reachable, 1 terminals'
      ].join('\n')
    )
  })

  it('points at environment add when nothing was polled', () => {
    expect(
      formatEnvironmentTerminalRoster({
        rows: [],
        runtimeCount: 0,
        reachableCount: 0,
        terminalCount: 0,
        truncated: false
      })
    ).toContain('orca environment add')
  })
})
