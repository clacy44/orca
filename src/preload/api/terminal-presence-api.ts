import type {
  TerminalPresenceLocalSnapshot,
  TerminalPresenceLocalTerminal
} from '../../shared/terminal-presence-ipc'

// Why an IPC surface beside `pty` and not a runtime one: the host's own renderer has no wire channel
// that carries presence for a LOCAL PTY (gap 9), and this lane is Electron IPC — no capability, no
// negotiation, nothing published to a paired client.
export type TerminalPresenceApi = {
  /** Every local PTY somebody is on, plus this machine's always-present host row. Read once on mount:
   *  events emitted before the listener existed are lost, not queued. */
  get: () => Promise<TerminalPresenceLocalSnapshot>
  /** One local PTY's roster changed. Main suppresses this entirely while that PTY has no peer, so a
   *  solo desktop never sees it fire. */
  onChanged: (callback: (terminal: TerminalPresenceLocalTerminal) => void) => () => void
}
