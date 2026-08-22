import { describe, expect, it } from 'vitest'
import type { TerminalPresenceParticipant } from '@/lib/pane-manager/terminal-presence-state'
import { resolveTerminalPresenceChipState } from './terminal-presence-chip-state'

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

describe('resolveTerminalPresenceChipState', () => {
  it('renders nothing when the reader is alone on the pty', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [peer({ participantId: 'p-self', self: true, typing: true })],
        arbitration: null
      })
    ).toBeNull()
  })

  it('names an attached peer with no activity', () => {
    expect(resolveTerminalPresenceChipState({ participants: [peer()], arbitration: null })).toEqual(
      { label: 'Ana laptop', activity: 'attached' }
    )
  })

  it('promotes a grant write to writing', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [peer({ writing: true })],
        arbitration: null
      })
    ).toEqual({ label: 'Ana laptop', activity: 'writing' })
  })

  it('promotes a live interactive stamp to typing', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [peer({ typing: true })],
        arbitration: null
      })
    ).toEqual({ label: 'Ana laptop', activity: 'typing' })
  })

  it('ranks typing over writing on one participant and across two', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [peer({ typing: true, writing: true })],
        arbitration: null
      })
    ).toEqual({ label: 'Ana laptop', activity: 'typing' })

    expect(
      resolveTerminalPresenceChipState({
        participants: [
          peer({ participantId: 'p-writer', label: 'Ben phone', writing: true }),
          peer({ participantId: 'p-typist', label: 'Ana laptop', typing: true })
        ],
        arbitration: null
      })
    ).toEqual({ label: 'Ana laptop', activity: 'typing' })
  })

  it('shows the hold above every other state and names the participant it yields to', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [
          peer({ participantId: 'p-typist', label: 'Ana laptop', typing: true }),
          peer({ participantId: 'p-writer', label: 'Ben phone', writing: true })
        ],
        arbitration: { heldFor: 'p-typist', until: 5000 }
      })
    ).toEqual({ label: 'Ana laptop', activity: 'held' })
  })

  it('ignores an arbitration notice that names the reader or nobody on this pty', () => {
    // Negative control: a hold the roster cannot corroborate must fall back to the activity ladder
    // rather than inventing a "press again" prompt against a name the pane never saw.
    expect(
      resolveTerminalPresenceChipState({
        participants: [peer({ participantId: 'p-self', self: true }), peer({ typing: true })],
        arbitration: { heldFor: 'p-self', until: 5000 }
      })
    ).toEqual({ label: 'Ana laptop', activity: 'typing' })

    expect(
      resolveTerminalPresenceChipState({
        participants: [peer({ writing: true })],
        arbitration: { heldFor: 'p-absent', until: 5000 }
      })
    ).toEqual({ label: 'Ana laptop', activity: 'writing' })
  })

  // S7: a phone the host has not heard from in two minutes reads as attached-but-silent, never as typing.
  it('renders a stale phone as its own state and keeps the copy stamp', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [
          peer({ kind: 'mobile', label: "Ben's phone", stale: true, lastSeenAt: 1_000 })
        ],
        arbitration: null
      })
    ).toEqual({ label: "Ben's phone", activity: 'stale', lastSeenAt: 1_000 })
  })

  // The negative control that matters: `stale` wins even if an activity flag somehow survived, because
  // a row nobody has heard from cannot honestly claim a keystroke.
  it('never renders a stale row as typing', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [
          peer({ kind: 'mobile', typing: true, writing: true, stale: true, lastSeenAt: 1_000 })
        ],
        arbitration: null
      })?.activity
    ).toBe('stale')
  })

  it('lets a peer who is actually here outrank a stale phone', () => {
    expect(
      resolveTerminalPresenceChipState({
        participants: [
          peer({ participantId: 'p-phone', kind: 'mobile', stale: true, lastSeenAt: 1_000 }),
          peer({ participantId: 'p-ana', label: 'Ana laptop' })
        ],
        arbitration: null
      })
    ).toEqual({ label: 'Ana laptop', activity: 'attached' })
  })
})
