import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetTerminalPresenceStateForTest,
  setPresenceRosterForEnvironment,
  setPresenceSelectionsForEnvironment
} from '@/lib/pane-manager/terminal-presence-state'
import { RuntimePresenceStatusRows } from './RuntimePresenceStatusRows'

describe('RuntimePresenceStatusRows', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
  })

  it('renders nothing for a runtime nobody is paired into', () => {
    expect(renderToStaticMarkup(<RuntimePresenceStatusRows />)).toBe('')
  })

  it('names every participant with what they have selected', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'host',
          label: 'devbox',
          kind: 'host',
          attachedTerminals: ['term_9'],
          self: true
        },
        {
          participantId: 'p-ana',
          label: 'Ana laptop',
          kind: 'runtime',
          attachedTerminals: ['term_1', 'term_2'],
          self: false
        },
        {
          participantId: 'p-ben',
          label: 'Ben phone',
          kind: 'mobile',
          attachedTerminals: [],
          self: false
        }
      ]
    })
    setPresenceSelectionsForEnvironment('env-1', [
      {
        participantId: 'p-ana',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'server.ts'
      }
    ])

    const markup = renderToStaticMarkup(<RuntimePresenceStatusRows />)

    expect(markup).toContain('People')
    // The host entry appears when present, with the suffix composed in the renderer.
    expect(markup).toContain('devbox (host)')
    expect(markup).toContain('Ana laptop')
    expect(markup).toContain('server.ts')
    // W8 with no W9 row still says what it knows: attached versus nothing open.
    expect(markup).toContain('Attached')
    expect(markup).toContain('Ben phone')
    expect(markup).toContain('Idle')
    expect(markup.indexOf('devbox (host)')).toBeLessThan(markup.indexOf('Ana laptop'))
  })

  // §2.2's stated purpose for the flag: a client must be able to say "there are more" rather than
  // present a capped list as a complete one.
  it('says so when the host capped the roster', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-ana',
          label: 'Ana laptop',
          kind: 'runtime',
          attachedTerminals: [],
          self: false
        }
      ],
      truncated: true
    })

    expect(renderToStaticMarkup(<RuntimePresenceStatusRows />)).toContain('More people not shown')
  })

  // The negative control: an uncapped roster must claim nothing of the sort.
  it('says nothing about overflow while the roster fits', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-ana',
          label: 'Ana laptop',
          kind: 'runtime',
          attachedTerminals: [],
          self: false
        }
      ]
    })

    expect(renderToStaticMarkup(<RuntimePresenceStatusRows />)).not.toContain(
      'More people not shown'
    )
  })

  it('marks the reader rather than rendering them as their own peer', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-self',
          label: 'This desktop',
          kind: 'runtime',
          attachedTerminals: [],
          self: true
        }
      ]
    })

    expect(renderToStaticMarkup(<RuntimePresenceStatusRows />)).toContain('This desktop (you)')
  })

  it('drops a selection the roster does not corroborate', () => {
    // Negative control: W9 and W8 are separate channels, so a selection for somebody who is not in the
    // membership payload must not conjure a row.
    setPresenceSelectionsForEnvironment('env-1', [
      {
        participantId: 'p-ghost',
        label: 'Nobody',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'ghost.ts'
      }
    ])

    const markup = renderToStaticMarkup(<RuntimePresenceStatusRows />)

    expect(markup).not.toContain('Nobody')
    expect(markup).not.toContain('ghost.ts')
  })

  it('says how long ago a stale phone was last seen, ahead of what it had selected', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-ben',
          label: "Ben's phone",
          kind: 'mobile',
          attachedTerminals: ['term_1'],
          self: false,
          stale: true,
          lastSeenAt: Date.now() - 4 * 60_000
        }
      ]
    })
    setPresenceSelectionsForEnvironment('env-1', [
      {
        participantId: 'p-ben',
        label: "Ben's phone",
        kind: 'mobile',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'server.ts'
      }
    ])

    const markup = renderToStaticMarkup(<RuntimePresenceStatusRows />)

    expect(markup).toContain('Attached · last seen 4m ago')
    expect(markup).toContain('data-presence-stale="true"')
    expect(markup).not.toContain('server.ts')
  })

  // The two fields are independent optionals on the wire. One reading on every surface: the flag alone
  // still suppresses the row's activity — here, what that phone had selected — and only the stamp
  // unlocks the "how long" clause, so nothing is invented for a duration this window does not know.
  it('drops the selection but says no duration for a stale row with no stamp', () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-ben',
          label: "Ben's phone",
          kind: 'mobile',
          attachedTerminals: ['term_1'],
          self: false,
          stale: true
        }
      ]
    })
    setPresenceSelectionsForEnvironment('env-1', [
      {
        participantId: 'p-ben',
        label: "Ben's phone",
        kind: 'mobile',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'server.ts'
      }
    ])

    const markup = renderToStaticMarkup(<RuntimePresenceStatusRows />)

    expect(markup).toContain('data-presence-stale="true"')
    expect(markup).toContain('Attached')
    expect(markup).not.toContain('last seen')
    expect(markup).not.toContain('server.ts')
  })
})
