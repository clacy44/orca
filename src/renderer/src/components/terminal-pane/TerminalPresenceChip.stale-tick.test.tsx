// @vitest-environment happy-dom
// Why its own file: the sibling suite renders to static markup, and this asserts what happens after that
// render — the chip carries the same "last seen Nm ago" number the status bar does.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPresenceChip } from './TerminalPresenceChip'

const LAST_SEEN_AT = 1_700_000_000_000

describe('TerminalPresenceChip staleness copy', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(LAST_SEEN_AT + 2 * 60_000)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('counts the minutes on with no new payload behind it', async () => {
    render(
      <TerminalPresenceChip
        state={{ label: "Ben's phone", activity: 'stale', lastSeenAt: LAST_SEEN_AT }}
      />
    )
    expect(screen.getByText("Ben's phone attached · last seen 2m ago")).toBeTruthy()

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(screen.getByText("Ben's phone attached · last seen 7m ago")).toBeTruthy()
  })
})
