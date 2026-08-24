// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const openTerminalInMyLane = vi.fn().mockResolvedValue(undefined)
vi.mock('./open-terminal-in-my-lane', () => ({
  openTerminalInMyLane: (...args: unknown[]) => openTerminalInMyLane(...args)
}))

import { TerminalPresenceLaneChip } from './TerminalPresenceLaneChip'
import {
  setCredentialLaneForPty,
  resetTerminalCredentialLaneStateForTest
} from '@/lib/pane-manager/terminal-credential-lane-state'
import type { TerminalPaneCredentialLane } from '@/lib/pane-manager/terminal-credential-lane-state'

function renderChip(ptyId: string): void {
  render(<TerminalPresenceLaneChip ptyId={ptyId} presenceState={null} />)
}

describe('TerminalPresenceLaneChip', () => {
  beforeEach(() => {
    resetTerminalCredentialLaneStateForTest()
    openTerminalInMyLane.mockClear()
  })
  afterEach(cleanup)

  it('renders the owner label and account name for an owned lane', () => {
    setCredentialLaneForPty('pty-1', {
      credentialLane: 'grant',
      laneAccountLabel: { owner: 'Ana', accountName: 'work' }
    })
    renderChip('pty-1')
    expect(screen.getByText('Ana · work')).toBeTruthy()
  })

  it('renders the shared-credential note for a host lane', () => {
    setCredentialLaneForPty('pty-1', { credentialLane: 'host' })
    renderChip('pty-1')
    expect(screen.getByText('Shared credential')).toBeTruthy()
  })

  it('labels a remote lane and a WSL lane for where they run', () => {
    setCredentialLaneForPty('pty-remote', { credentialLane: 'remote' })
    setCredentialLaneForPty('pty-wsl', { credentialLane: 'wsl' })
    render(<TerminalPresenceLaneChip ptyId="pty-remote" presenceState={null} />)
    render(<TerminalPresenceLaneChip ptyId="pty-wsl" presenceState={null} />)
    expect(screen.getByText('Runs on a remote host')).toBeTruthy()
    expect(screen.getByText('Runs in WSL')).toBeTruthy()
  })

  it('renders nothing for an unattributed (pre-S9) pane', () => {
    const { container } = render(<TerminalPresenceLaneChip ptyId="pty-none" presenceState={null} />)
    expect(container.querySelector('[data-terminal-lane-account]')).toBeNull()
    expect(container.querySelector('[data-terminal-lane-note]')).toBeNull()
    expect(container.querySelector('[data-testid="open-in-my-lane"]')).toBeNull()
  })

  it('offers "Open in my lane" on another person’s owned lane and fires the RPC', async () => {
    const lane: TerminalPaneCredentialLane = {
      credentialLane: 'grant',
      laneAccountLabel: { owner: 'Boris' }
    }
    setCredentialLaneForPty('pty-boris', lane)
    renderChip('pty-boris')
    await userEvent.click(screen.getByTestId('open-in-my-lane'))
    expect(openTerminalInMyLane).toHaveBeenCalledWith('pty-boris')
  })

  it('does not offer the action on the viewer’s own lane', () => {
    setCredentialLaneForPty('pty-mine', {
      credentialLane: 'grant',
      laneAccountLabel: { owner: 'Ana' },
      credentialLaneOwner: true
    })
    renderChip('pty-mine')
    expect(screen.queryByTestId('open-in-my-lane')).toBeNull()
  })
})
