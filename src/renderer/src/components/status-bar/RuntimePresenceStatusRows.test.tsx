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
})
