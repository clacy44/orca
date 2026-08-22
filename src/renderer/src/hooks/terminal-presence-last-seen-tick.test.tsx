// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { terminalPresenceLastSeenMinutes } from '../../../shared/terminal-presence-last-seen'
import { useTerminalPresenceLastSeenTick } from './terminal-presence-last-seen-tick'

const LAST_SEEN_AT = 1_700_000_000_000

function StaleRow({ stale }: { stale: boolean }): ReactElement {
  useTerminalPresenceLastSeenTick(stale)
  return (
    <span data-testid="copy">
      last seen {terminalPresenceLastSeenMinutes(LAST_SEEN_AT, Date.now())}m ago
    </span>
  )
}

describe('useTerminalPresenceLastSeenTick', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(LAST_SEEN_AT + 2 * 60_000)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  // The host emits the stale flip once and re-arms nothing, so with no tick the count freezes at whatever
  // it read when the payload landed — the one number the copy exists to carry.
  it('moves the count on with no new payload behind it', async () => {
    render(<StaleRow stale={true} />)
    expect(screen.getByTestId('copy').textContent).toBe('last seen 2m ago')

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(screen.getByTestId('copy').textContent).toBe('last seen 7m ago')
  })

  // Negative control: a roster with nobody stale arms nothing, so a solo desktop pays no timer at all.
  it('arms no timer while no row is stale', async () => {
    render(<StaleRow stale={false} />)

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(screen.getByTestId('copy').textContent).toBe('last seen 2m ago')
  })
})
