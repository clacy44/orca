// Why shared: this payload crosses main → preload → renderer, and a copy per layer drifts on the first
// field any of the three adds. Electron IPC only — nothing here is ever published to a paired client.
import type { RuntimeTerminalStreamPresenceParticipant } from './runtime-types'

export type TerminalPresenceLocalTerminal = {
  // Why both: the pane lane joins on `ptyId`, the roster row displays `handle`. Null when the PTY has
  // no live handle — a read-only surface must never mint one.
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

// Why on the snapshot and not every push: it is static for the process, and a push is one PTY's roster.
export type TerminalPresenceLocalSnapshot = {
  host: TerminalPresenceLocalHost
  terminals: TerminalPresenceLocalTerminal[]
}
