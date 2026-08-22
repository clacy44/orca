// Why shared: the local presence lane crosses main → preload → renderer, and a payload type copied per
// layer drifts on the first field any of the three adds. It is Electron IPC, not a wire surface: no
// capability, no negotiation, and nothing here is ever published to a paired client.
import type { RuntimeTerminalStreamPresenceParticipant } from './runtime-types'

export type TerminalPresenceLocalTerminal = {
  // Why both ids: `ptyId` is what the renderer keys panes by, so the pane lane joins on it with no
  // reverse lookup; `handle` is the runtime-wide display token the roster row shows, and main already
  // holds the two together. Null when the PTY has no live handle — never a handle minted for this push.
  ptyId: string
  handle: string | null
  participants: RuntimeTerminalStreamPresenceParticipant[]
}

// Why always `self`: this channel has exactly one reader and it IS the host participant, so the row is
// resolved host-side and the renderer never has to learn its own identity to filter itself out.
export type TerminalPresenceLocalHost = {
  participantId: string
  label: string
  kind: 'host'
  self: true
}

// Why the host row rides the snapshot and not every push: it is static for the process, while a push is
// one PTY's roster. Hydration is the one round trip that can carry it without repeating it per keystroke.
export type TerminalPresenceLocalSnapshot = {
  host: TerminalPresenceLocalHost
  terminals: TerminalPresenceLocalTerminal[]
}
