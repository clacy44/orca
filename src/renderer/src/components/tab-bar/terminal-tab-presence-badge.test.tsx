// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TerminalTabPresenceBadge } from './terminal-tab-presence-badge'
import {
  resetTerminalPresenceStateForTest,
  setPresenceForPty
} from '@/lib/pane-manager/terminal-presence-state'
import {
  resetTerminalCredentialLaneStateForTest,
  setCredentialLaneForPty
} from '@/lib/pane-manager/terminal-credential-lane-state'
import { useAppStore } from '../../store'

function seedTab(ptyIds: string[]): void {
  useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ptyIds } })
}

describe('TerminalTabPresenceBadge lane owner', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
    resetTerminalCredentialLaneStateForTest()
    seedTab(['pty-1'])
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState({ ptyIdsByTabId: {} })
  })

  it('adds the credential owner to the badge title beside the peer presence', () => {
    setPresenceForPty('pty-1', {
      participants: [
        {
          participantId: 'peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: true,
          writing: false,
          since: 1
        }
      ],
      arbitration: null
    })
    setCredentialLaneForPty('pty-1', {
      credentialLane: 'grant',
      laneAccountLabel: { owner: 'Ana', accountName: 'work' }
    })
    const { container } = render(<TerminalTabPresenceBadge tabId="tab-1" />)
    const dot = container.querySelector('[data-tab-presence]') as HTMLElement
    expect(dot.getAttribute('title')).toBe('Ana laptop is typing in this tab · runs on Ana · work')
  })

  it('leaves the presence title unchanged when no pane is on a person’s lane', () => {
    setPresenceForPty('pty-1', {
      participants: [
        {
          participantId: 'peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: true,
          writing: false,
          since: 1
        }
      ],
      arbitration: null
    })
    setCredentialLaneForPty('pty-1', { credentialLane: 'host' })
    const { container } = render(<TerminalTabPresenceBadge tabId="tab-1" />)
    const dot = container.querySelector('[data-tab-presence]') as HTMLElement
    expect(dot.getAttribute('title')).toBe('Ana laptop is typing in this tab')
  })
})
