import { afterEach, describe, expect, it } from 'vitest'
import type {
  TerminalPresenceLocalHost,
  TerminalPresenceLocalTerminal
} from '../../../../shared/terminal-presence-ipc'
import type { RuntimeTerminalStreamPresenceParticipant } from '../../../../shared/runtime-types'
import {
  LOCAL_PRESENCE_ENVIRONMENT_ID,
  applyLocalTerminalPresence,
  hydrateLocalTerminalPresence,
  resetLocalTerminalPresence
} from './terminal-presence-local-lane'
import {
  getPeerPresenceForPty,
  getPresenceRosterForEnvironment,
  resetTerminalPresenceStateForTest
} from './terminal-presence-state'

const PTY_ID = 'pty-local-1'
const HANDLE = 'terminal-7'

const HOST: TerminalPresenceLocalHost = {
  participantId: 'host',
  label: 'devbox',
  kind: 'host',
  self: true
}

function participant(
  overrides: Partial<RuntimeTerminalStreamPresenceParticipant> = {}
): RuntimeTerminalStreamPresenceParticipant {
  return {
    participantId: 'p-ana',
    label: 'Ana laptop',
    kind: 'runtime',
    self: false,
    typing: false,
    writing: false,
    since: 1_000,
    ...overrides
  }
}

function hostParticipant(
  overrides: Partial<RuntimeTerminalStreamPresenceParticipant> = {}
): RuntimeTerminalStreamPresenceParticipant {
  return participant({
    participantId: 'host',
    label: 'devbox',
    kind: 'host',
    self: true,
    ...overrides
  })
}

function terminal(
  participants: RuntimeTerminalStreamPresenceParticipant[]
): TerminalPresenceLocalTerminal {
  return { ptyId: PTY_ID, handle: HANDLE, participants }
}

function rosterRows(): ReturnType<typeof getPresenceRosterForEnvironment>['participants'] {
  return getPresenceRosterForEnvironment(LOCAL_PRESENCE_ENVIRONMENT_ID).participants
}

afterEach(() => {
  resetLocalTerminalPresence()
  resetTerminalPresenceStateForTest()
})

describe('local terminal presence lane', () => {
  it('renders a peer on the host own pane and marks the host row self in the roster', () => {
    hydrateLocalTerminalPresence({
      host: HOST,
      terminals: [terminal([hostParticipant(), participant()])]
    })

    // Surface 1/2 read this: the chip and the tab badge are both peers-of-this-pty.
    expect(getPeerPresenceForPty(PTY_ID).map((row) => row.label)).toEqual(['Ana laptop'])
    expect(rosterRows()).toEqual([
      {
        participantId: 'host',
        label: 'devbox',
        kind: 'host',
        self: true,
        attachedTerminals: [HANDLE]
      },
      {
        participantId: 'p-ana',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        attachedTerminals: [HANDLE]
      }
    ])
  })

  it('flips the host row to typing on a local keystroke without ever showing it as a peer', () => {
    hydrateLocalTerminalPresence({
      host: HOST,
      terminals: [terminal([hostParticipant(), participant()])]
    })

    applyLocalTerminalPresence(terminal([hostParticipant({ typing: true }), participant()]))

    // Site (c)'s reserved-key stamp reached the lane; `self` is what keeps it out of the peer list.
    expect(getPeerPresenceForPty(PTY_ID).map((row) => row.typing)).toEqual([false])
    expect(rosterRows()[0]).toMatchObject({ participantId: 'host', self: true })
  })

  it('flips a peer to typing for the chip', () => {
    hydrateLocalTerminalPresence({ host: HOST, terminals: [terminal([participant()])] })
    expect(getPeerPresenceForPty(PTY_ID)[0]?.typing).toBe(false)

    applyLocalTerminalPresence(terminal([participant({ typing: true })]))

    expect(getPeerPresenceForPty(PTY_ID)[0]?.typing).toBe(true)
  })

  it('renders no People section for a solo desktop', () => {
    // Negative control: a host-only payload is one person looking at their own name.
    hydrateLocalTerminalPresence({ host: HOST, terminals: [terminal([hostParticipant()])] })

    expect(rosterRows()).toEqual([])
  })

  it('clears the pane and the roster when the last peer leaves', () => {
    hydrateLocalTerminalPresence({
      host: HOST,
      terminals: [terminal([hostParticipant(), participant()])]
    })

    applyLocalTerminalPresence(terminal([]))

    expect(getPeerPresenceForPty(PTY_ID)).toEqual([])
    expect(rosterRows()).toEqual([])
  })

  it('applies a push that landed during the hydration round trip, and keeps it', () => {
    // The push is newer than the snapshot in flight, so hydration must not roll it back.
    applyLocalTerminalPresence(terminal([hostParticipant(), participant({ typing: true })]))
    expect(getPeerPresenceForPty(PTY_ID)).toEqual([])

    hydrateLocalTerminalPresence({ host: HOST, terminals: [terminal([hostParticipant()])] })

    expect(getPeerPresenceForPty(PTY_ID)[0]?.typing).toBe(true)
  })

  it('drops every local row on reset so a remount re-hydrates', () => {
    hydrateLocalTerminalPresence({
      host: HOST,
      terminals: [terminal([hostParticipant(), participant()])]
    })

    resetLocalTerminalPresence()

    expect(getPeerPresenceForPty(PTY_ID)).toEqual([])
    expect(rosterRows()).toEqual([])
  })
})
