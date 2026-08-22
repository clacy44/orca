// Why its own module beside the state lane: the local IPC lane arrives as one PTY at a time, but
// Surface 3 is a runtime-wide roster, so projecting it needs the last payload of EVERY local PTY —
// state the IPC hub has nowhere to keep. Everything below writes through terminal-presence-state.ts,
// so nothing downstream branches on local-vs-remote.
import type { RuntimeTerminalPresenceParticipant } from '../../../../shared/runtime-client-events'
import type {
  TerminalPresenceLocalHost,
  TerminalPresenceLocalSnapshot,
  TerminalPresenceLocalTerminal
} from '../../../../shared/terminal-presence-ipc'
import {
  clearPresenceRosterForEnvironment,
  setPresenceForPty,
  setPresenceRosterForEnvironment
} from './terminal-presence-state'

// Why a sentinel: the roster map is keyed by environmentId and this runtime is the one nobody paired
// into, so it has none. A runtime environment id is a persisted uuid, and the hub's desired-set
// teardown only ever names those — neither can collide with this key.
export const LOCAL_PRESENCE_ENVIRONMENT_ID = '__local__'

const terminalsByPtyId = new Map<string, TerminalPresenceLocalTerminal>()
const pendingTerminals: TerminalPresenceLocalTerminal[] = []
let hostRow: TerminalPresenceLocalHost | null = null
let hydrated = false

function writeTerminal(terminal: TerminalPresenceLocalTerminal): void {
  if (terminal.participants.length === 0) {
    terminalsByPtyId.delete(terminal.ptyId)
  } else {
    terminalsByPtyId.set(terminal.ptyId, terminal)
  }
  // Why the same map the remote lane writes, keyed by the raw local ptyId: remote panes are keyed by a
  // prefixed id, so the two lanes share one map without ever colliding.
  setPresenceForPty(terminal.ptyId, {
    participants: terminal.participants,
    // Why null: Q2's hold is published on the held stream, and a local PTY has no stream to hold.
    arbitration: null
  })
}

function collectRosterRows(): Map<string, RuntimeTerminalPresenceParticipant> {
  const rows = new Map<string, RuntimeTerminalPresenceParticipant>()
  for (const terminal of terminalsByPtyId.values()) {
    for (const participant of terminal.participants) {
      const row = rows.get(participant.participantId) ?? {
        participantId: participant.participantId,
        label: participant.label,
        kind: participant.kind,
        // Why carried through rather than recomputed: the host resolved it, and this renderer has no
        // other way to learn which row is itself.
        self: participant.self,
        attachedTerminals: []
      }
      // Why the handle and not the ptyId: this is the runtime-wide row, and a handle is the token every
      // other roster surface displays.
      if (terminal.handle && !row.attachedTerminals.includes(terminal.handle)) {
        row.attachedTerminals.push(terminal.handle)
      }
      rows.set(participant.participantId, row)
    }
  }
  return rows
}

function publishRoster(): void {
  const rows = collectRosterRows()
  const peers = Array.from(rows.values()).filter(
    (row) => row.participantId !== hostRow?.participantId
  )
  // Why nothing at all when nobody is here: a solo desktop must render no People section, and a lone
  // host row naming only yourself is exactly that section appearing for one person.
  if (peers.length === 0 || !hostRow) {
    clearPresenceRosterForEnvironment(LOCAL_PRESENCE_ENVIRONMENT_ID)
    return
  }
  const host = rows.get(hostRow.participantId) ?? { ...hostRow, attachedTerminals: [] }
  setPresenceRosterForEnvironment(LOCAL_PRESENCE_ENVIRONMENT_ID, {
    participants: [host, ...peers]
  })
}

/** One local PTY's roster changed. Buffered until hydration, because a push that lands during the
 *  snapshot round trip is NEWER than the snapshot and must not be overwritten by it. */
export function applyLocalTerminalPresence(terminal: TerminalPresenceLocalTerminal): void {
  if (!hydrated) {
    pendingTerminals.push(terminal)
    return
  }
  writeTerminal(terminal)
  publishRoster()
}

export function hydrateLocalTerminalPresence(snapshot: TerminalPresenceLocalSnapshot): void {
  hostRow = snapshot.host
  for (const terminal of snapshot.terminals) {
    writeTerminal(terminal)
  }
  hydrated = true
  for (const terminal of pendingTerminals.splice(0)) {
    writeTerminal(terminal)
  }
  publishRoster()
}

/** No snapshot will ever arrive on this mount. Ends the buffering state rather than leaving the lane
 *  dark with a queue nothing drains — later pushes still feed the pane surfaces, minus the host row. */
export function markLocalTerminalPresenceUnavailable(): void {
  pendingTerminals.length = 0
  hydrated = true
}

/** Drops every local row. The hub calls this when its effect tears down: the lane is process-global,
 *  so a remount must re-hydrate rather than inherit what the previous mount left behind. */
export function resetLocalTerminalPresence(): void {
  for (const ptyId of Array.from(terminalsByPtyId.keys())) {
    setPresenceForPty(ptyId, { participants: [], arbitration: null })
  }
  terminalsByPtyId.clear()
  pendingTerminals.length = 0
  hostRow = null
  hydrated = false
  clearPresenceRosterForEnvironment(LOCAL_PRESENCE_ENVIRONMENT_ID)
}
