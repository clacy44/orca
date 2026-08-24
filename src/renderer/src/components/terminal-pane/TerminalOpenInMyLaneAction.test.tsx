// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalOpenInMyLaneAction } from './TerminalOpenInMyLaneAction'
import type { TerminalCredentialLaneAttribution } from './terminal-credential-lane-attribution'
import type { TerminalLaneAccountChipState } from './terminal-lane-account-chip-state'

const OWNED: TerminalCredentialLaneAttribution = {
  kind: 'owned',
  account: { label: 'Ana · work' } satisfies TerminalLaneAccountChipState
}
const SHARED: TerminalCredentialLaneAttribution = { kind: 'shared', source: 'host' }

describe('TerminalOpenInMyLaneAction', () => {
  afterEach(cleanup)

  it('offers the action on another person’s owned lane when the host supports it', async () => {
    const onOpen = vi.fn()
    render(
      <TerminalOpenInMyLaneAction
        capabilitySupported
        attribution={OWNED}
        viewerOwnsLane={false}
        busy={false}
        onOpen={onOpen}
      />
    )
    await userEvent.click(screen.getByTestId('open-in-my-lane'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('hides when the host does not advertise the capability', () => {
    render(
      <TerminalOpenInMyLaneAction
        capabilitySupported={false}
        attribution={OWNED}
        viewerOwnsLane={false}
        busy={false}
        onOpen={vi.fn()}
      />
    )
    expect(screen.queryByTestId('open-in-my-lane')).toBeNull()
  })

  it('hides on the viewer’s own lane', () => {
    render(
      <TerminalOpenInMyLaneAction
        capabilitySupported
        attribution={OWNED}
        viewerOwnsLane
        busy={false}
        onOpen={vi.fn()}
      />
    )
    expect(screen.queryByTestId('open-in-my-lane')).toBeNull()
  })

  it('hides on a shared (non-owned) row', () => {
    render(
      <TerminalOpenInMyLaneAction
        capabilitySupported
        attribution={SHARED}
        viewerOwnsLane={false}
        busy={false}
        onOpen={vi.fn()}
      />
    )
    expect(screen.queryByTestId('open-in-my-lane')).toBeNull()
  })
})
