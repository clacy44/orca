import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetTerminalPresenceStateForTest,
  setPresenceForPty,
  type TerminalPresenceParticipant
} from '@/lib/pane-manager/terminal-presence-state'
import {
  resolveTerminalTabPresenceBadge,
  resolveTerminalTabPresenceLabel
} from './terminal-tab-presence-status'

function peer(overrides: Partial<TerminalPresenceParticipant> = {}): TerminalPresenceParticipant {
  return {
    participantId: 'p-peer',
    label: 'Ana laptop',
    kind: 'runtime',
    self: false,
    typing: false,
    writing: false,
    since: 1,
    ...overrides
  }
}

const PTY_IDS = { 'tab-1': ['pty-1', 'pty-2'] }

describe('resolveTerminalTabPresenceBadge', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
  })

  it('returns a primitive, never a roster object', () => {
    setPresenceForPty('pty-1', { participants: [peer({ writing: true })], arbitration: null })

    const badge = resolveTerminalTabPresenceBadge({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })

    expect(badge).toBe('writing')
    expect(typeof badge).toBe('string')
  })

  it('returns null for a tab nobody else is on, so the selector cannot repaint it', () => {
    setPresenceForPty('pty-1', {
      participants: [peer({ participantId: 'p-self', self: true, typing: true })],
      arbitration: null
    })

    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBeNull()
    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-2', ptyIdsByTabId: PTY_IDS })).toBeNull()
    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-1' })).toBeNull()
  })

  it('collapses every pane of the tab onto the loudest state', () => {
    setPresenceForPty('pty-1', { participants: [peer()], arbitration: null })
    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      'attached'
    )

    setPresenceForPty('pty-2', {
      participants: [peer({ participantId: 'p-two', label: 'Ben phone', typing: true })],
      arbitration: null
    })
    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      'typing'
    )
  })
})

describe('resolveTerminalTabPresenceLabel', () => {
  beforeEach(() => {
    resetTerminalPresenceStateForTest()
  })

  it('names the participant the badge state came from', () => {
    setPresenceForPty('pty-1', {
      participants: [peer({ participantId: 'p-quiet', label: 'Cara desktop' })],
      arbitration: null
    })
    setPresenceForPty('pty-2', {
      participants: [peer({ participantId: 'p-typist', label: 'Ana laptop', typing: true })],
      arbitration: null
    })

    expect(resolveTerminalTabPresenceLabel({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      'Ana laptop'
    )
  })

  it('has no name to give when nobody but the reader is there', () => {
    expect(resolveTerminalTabPresenceLabel({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBeNull()
  })

  it('marks a stale phone without letting it outrank anyone who is here', () => {
    setPresenceForPty('pty-1', {
      participants: [
        peer({
          participantId: 'p-phone',
          label: "Ben's phone",
          kind: 'mobile',
          stale: true,
          lastSeenAt: 1_000
        })
      ],
      arbitration: null
    })
    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      'stale'
    )
    expect(resolveTerminalTabPresenceLabel({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      "Ben's phone"
    )

    setPresenceForPty('pty-2', {
      participants: [peer({ participantId: 'p-ana', label: 'Ana laptop' })],
      arbitration: null
    })
    expect(resolveTerminalTabPresenceBadge({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      'attached'
    )
    expect(resolveTerminalTabPresenceLabel({ tabId: 'tab-1', ptyIdsByTabId: PTY_IDS })).toBe(
      'Ana laptop'
    )
  })
})
