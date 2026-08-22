import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPresenceForPty,
  clearPresenceRosterForEnvironment,
  getPeerPresenceForPty,
  getPresenceForPty,
  getPresenceRosterEnvironmentIds,
  getPresenceRosterForEnvironment,
  onPresenceChange,
  onPresenceRosterChange,
  resetTerminalPresenceStateForTest,
  setPresenceForPty,
  setPresenceRosterForEnvironment,
  setPresenceSelectionsForEnvironment,
  type TerminalPresenceParticipant
} from './terminal-presence-state'

function participant(
  overrides: Partial<TerminalPresenceParticipant> & { participantId: string }
): TerminalPresenceParticipant {
  return {
    label: 'Ana laptop',
    kind: 'runtime',
    self: false,
    typing: false,
    writing: false,
    since: 1,
    ...overrides
  }
}

describe('terminal presence pane lane', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
  })

  it('stores a pane roster and notifies listeners with the resolved value', () => {
    const seen: { ptyId: string; participantIds: string[] }[] = []
    const unsubscribe = onPresenceChange((event) => {
      seen.push({
        ptyId: event.ptyId,
        participantIds: event.presence.participants.map((row) => row.participantId)
      })
    })

    setPresenceForPty('pty-1', {
      participants: [participant({ participantId: 'p-1' })],
      arbitration: null
    })

    expect(getPresenceForPty('pty-1').participants).toHaveLength(1)
    expect(seen).toEqual([{ ptyId: 'pty-1', participantIds: ['p-1'] }])
    unsubscribe()
  })

  it('drops an empty roster so an untouched pane reads as nobody rather than as an empty row', () => {
    setPresenceForPty('pty-1', {
      participants: [participant({ participantId: 'p-1' })],
      arbitration: null
    })
    setPresenceForPty('pty-1', { participants: [], arbitration: null })

    expect(getPresenceForPty('pty-1')).toEqual({ participants: [], arbitration: null })
  })

  it('keeps an arbitration notice that arrives with no participants left', () => {
    // Why: S6 publishes the hold on the held stream; a payload that raced the roster empty must not be
    // silently discarded by the empty-roster shortcut above.
    setPresenceForPty('pty-1', {
      participants: [],
      arbitration: { heldFor: 'p-1', until: 5000 }
    })

    expect(getPresenceForPty('pty-1').arbitration).toEqual({ heldFor: 'p-1', until: 5000 })
  })

  it('filters the reader out of the pane roster', () => {
    setPresenceForPty('pty-1', {
      participants: [
        participant({ participantId: 'p-self', self: true }),
        participant({ participantId: 'p-peer', label: 'Ben phone', kind: 'mobile' })
      ],
      arbitration: null
    })

    expect(getPeerPresenceForPty('pty-1').map((row) => row.participantId)).toEqual(['p-peer'])
  })

  it('never lets a roster write reach a pane the stream asserted', () => {
    // The authority rule: shared-control can be down while a pane's own multiplex stream is live, so a
    // roster that names nobody must not clear that pane's chip.
    setPresenceForPty('pty-1', {
      participants: [participant({ participantId: 'p-1', typing: true })],
      arbitration: null
    })

    setPresenceRosterForEnvironment('env-1', { participants: [] })
    clearPresenceRosterForEnvironment('env-1')

    expect(getPresenceForPty('pty-1').participants.map((row) => row.participantId)).toEqual(['p-1'])
    expect(getPresenceForPty('pty-1').participants[0].typing).toBe(true)
  })

  it('clears a pane only through its own lane', () => {
    setPresenceForPty('pty-1', {
      participants: [participant({ participantId: 'p-1' })],
      arbitration: null
    })
    const listener = vi.fn()
    const unsubscribe = onPresenceChange(listener)

    clearPresenceForPty('pty-1')
    clearPresenceForPty('pty-1')

    expect(getPresenceForPty('pty-1').participants).toEqual([])
    // Why once: a repeat clear on an already-empty pane must not tick every mounted overlay.
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('terminal presence runtime-wide lane', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
  })

  it('keeps W8 membership and W9 selections on separate writes for one environment', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-1',
          label: 'Ana laptop',
          kind: 'runtime',
          attachedTerminals: ['term_1'],
          self: false
        }
      ]
    })
    setPresenceSelectionsForEnvironment('env-1', [
      {
        participantId: 'p-1',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'server.ts'
      }
    ])

    const entry = getPresenceRosterForEnvironment('env-1')
    expect(entry.participants.map((row) => row.participantId)).toEqual(['p-1'])
    expect(entry.selections.map((row) => row.activeTabTitle)).toEqual(['server.ts'])
  })

  it('does not drop selections when a later roster frame arrives', () => {
    setPresenceSelectionsForEnvironment('env-1', [
      {
        participantId: 'p-1',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'server.ts'
      }
    ])
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-1',
          label: 'Ana laptop',
          kind: 'runtime',
          attachedTerminals: [],
          self: false
        }
      ],
      truncated: true
    })

    const entry = getPresenceRosterForEnvironment('env-1')
    expect(entry.selections).toHaveLength(1)
    expect(entry.truncated).toBe(true)
  })

  it('forgets an environment whose roster and selections are both empty', () => {
    const listener = vi.fn()
    const unsubscribe = onPresenceRosterChange(listener)

    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-1',
          label: 'Ana laptop',
          kind: 'runtime',
          attachedTerminals: [],
          self: false
        }
      ]
    })
    expect(getPresenceRosterEnvironmentIds()).toEqual(['env-1'])

    setPresenceRosterForEnvironment('env-1', { participants: [] })

    expect(getPresenceRosterEnvironmentIds()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
