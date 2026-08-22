// @vitest-environment happy-dom
// Why its own file: every other case here renders to static markup, and the one thing this asserts is
// that the copy keeps moving after the render that produced it.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetTerminalPresenceStateForTest,
  setPresenceRosterForEnvironment
} from '@/lib/pane-manager/terminal-presence-state'
import { RuntimePresenceStatusRows } from './RuntimePresenceStatusRows'

const LAST_SEEN_AT = 1_700_000_000_000

describe('RuntimePresenceStatusRows staleness copy', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(LAST_SEEN_AT + 2 * 60_000)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  // The host emits the stale flip exactly once — its falling edge is spent while the phone stays silent —
  // so a phone last heard from 40 minutes ago would otherwise read "last seen 2m ago" until the window
  // closed, which is the one number this copy exists to carry.
  it('counts the minutes on with no new payload behind it', async () => {
    setPresenceRosterForEnvironment('env-1', {
      participants: [
        {
          participantId: 'p-ben',
          label: "Ben's phone",
          kind: 'mobile',
          attachedTerminals: ['term_1'],
          self: false,
          stale: true,
          lastSeenAt: LAST_SEEN_AT
        }
      ]
    })

    render(<RuntimePresenceStatusRows />)
    expect(screen.getByText('Attached · last seen 2m ago')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(screen.getByText('Attached · last seen 7m ago')).toBeTruthy()
  })
})
