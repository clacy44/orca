import { describe, expect, it } from 'vitest'
import {
  formatEnvironmentTerminalRoster,
  formatTerminalPresence
} from './environment-roster-format'
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
        'local  runtime_local  ok  term_a  ✳ Claude Code  presence?  [Claude Code]',
        'vps  unknown-runtime  unreachable(no response within 10000ms)  (no terminals)  (untitled)  presence?',
        '',
        '1/2 runtimes reachable, 1 terminals'
      ].join('\n')
    )
  })

  it('separates a peer that published no presence from one where nobody is attached', () => {
    expect(
      formatEnvironmentTerminalRoster({
        rows: [
          row({ terminal: 'term_old' }),
          row({ terminal: 'term_empty', presence: '' }),
          row({ terminal: 'term_nobody', presence: null }),
          row({ terminal: 'term_busy', presence: 'Ana (typing), devbox' })
        ],
        runtimeCount: 1,
        reachableCount: 1,
        terminalCount: 4,
        truncated: false
      })
        .split('\n')
        .slice(0, 4)
        .map((line) => line.split('  ').at(-1))
    ).toEqual(['presence?', '-', '-', 'Ana (typing), devbox'])
  })

  it('renders each participant from the kind and flags the host published', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 3,
        participants: [
          {
            participantId: 'p-1',
            label: 'Ana',
            kind: 'runtime',
            typing: true,
            writing: false,
            self: true
          },
          {
            participantId: 'p-2',
            label: "Ben's phone",
            kind: 'mobile',
            typing: false,
            writing: true
          },
          { participantId: 'host', label: 'devbox', kind: 'host', typing: false, writing: false }
        ]
      })
      // Why the host marker: the host publishes the bare machine name so each surface can compose its
      // own, and without it the local human is indistinguishable from a peer device named after a box.
    ).toBe("Ana (typing), Ben's phone (writing), devbox (host)")
  })

  it('keeps the host marker and the activity marker in one parenthetical', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          { participantId: 'host', label: 'devbox', kind: 'host', typing: true, writing: false }
        ]
      })
    ).toBe('devbox (host, typing)')
  })

  // Why: `registerConnection` labels an unnamed grant '' (runtime-rpc.ts), so an attached participant
  // can format to the empty string — and an empty column is how this formatter says "nobody attached".
  it('names an unnamed participant rather than collapsing the column to nobody', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          { participantId: 'p-1', label: '', kind: 'runtime', typing: false, writing: false }
        ]
      })
    ).toBe('unnamed device')
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          { participantId: 'p-1', label: '', kind: 'runtime', typing: true, writing: false }
        ]
      })
    ).toBe('unnamed device (typing)')
  })

  // Why asserted here too: the host already suppresses `writing` under `typing`, and this column must
  // not be the place that starts depending on it — typing is the state a peer's keystroke can collide with.
  it('prefers typing over writing for a participant carrying both flags', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          { participantId: 'p-1', label: 'Ana', kind: 'runtime', typing: true, writing: true }
        ]
      })
    ).toBe('Ana (typing)')
  })

  it('formats a capable host with nobody attached as the empty column', () => {
    expect(formatTerminalPresence({ attachedCount: 0, participants: [] })).toBe('')
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

  // S7: the CLI column carries the same staleness the desktop chip does, and drops the activity markers
  // with it — the host has heard nothing from that phone, so neither flag is evidence of anything.
  it('prints how long ago a stale phone was last seen instead of an activity marker', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          {
            participantId: 'p-2',
            label: "Ben's phone",
            kind: 'mobile',
            typing: true,
            writing: true,
            stale: true,
            lastSeenAt: Date.now() - 4 * 60_000
          }
        ]
      })
    ).toBe("Ben's phone (attached · last seen 4m ago)")
  })

  // The two fields are independent optionals on the wire. One reading on every surface: the flag alone
  // still drops the activity markers, and only the stamp unlocks the "how long" clause.
  it('prints a stale row plain when it carries no stamp', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          {
            participantId: 'p-2',
            label: "Ben's phone",
            kind: 'mobile',
            typing: true,
            writing: true,
            stale: true
          }
        ]
      })
    ).toBe("Ben's phone")
  })

  // Negative control: a runtime peer is heartbeat-bounded, so nothing on this path may print it stale.
  it('leaves a peer that published no staleness exactly as before', () => {
    expect(
      formatTerminalPresence({
        attachedCount: 1,
        participants: [
          { participantId: 'p-1', label: 'Ana', kind: 'runtime', typing: false, writing: false }
        ]
      })
    ).toBe('Ana')
  })
})
