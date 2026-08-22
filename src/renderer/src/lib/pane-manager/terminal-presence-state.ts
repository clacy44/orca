// Why outside Zustand: presence ticks per keystroke. A store slice would fan every stamp out to every
// subscriber of the terminal store (docs/reference/renderer-agent-status-performance.md); this is the same
// module-level-Map + listener-set shape mobile-driver-state.ts uses, re-rendered through the existing tick
// counters (use-mobile-overlay-ticks.ts).
//
// Two lanes, deliberately separate:
//   - per-ptyId (W4), authoritative for its own pane because it rides that pane's own stream;
//   - runtime-wide (W8 roster + W9 selections), which is one debounce interval stale at best and simply
//     absent while shared-control walks its reconnect ladder. A missing roster must therefore never clear
//     a chip the pane's own stream is asserting, which is why nothing here lets the roster write lane one.
import type {
  RuntimeSessionTabDeviceSelection,
  RuntimeTerminalStreamPresenceArbitration,
  RuntimeTerminalStreamPresenceParticipant
} from '../../../../shared/runtime-types'
import type { RuntimeTerminalPresenceParticipant } from '../../../../shared/runtime-client-events'

export type TerminalPresenceParticipant = RuntimeTerminalStreamPresenceParticipant
export type TerminalPresenceArbitration = RuntimeTerminalStreamPresenceArbitration

export type TerminalPanePresence = {
  participants: TerminalPresenceParticipant[]
  // Why declared now, unused until S6: this module owns the state shape, and S6 and S8 both write through
  // it. Adding the slot later would reshape a file two slices already depend on.
  arbitration: TerminalPresenceArbitration | null
}

const EMPTY_PANE_PRESENCE: TerminalPanePresence = { participants: [], arbitration: null }

const presenceByPtyId = new Map<string, TerminalPanePresence>()

type PanePresenceChangeEvent = { ptyId: string; presence: TerminalPanePresence }
const paneChangeListeners = new Set<(event: PanePresenceChangeEvent) => void>()

export function onPresenceChange(listener: (event: PanePresenceChangeEvent) => void): () => void {
  paneChangeListeners.add(listener)
  return () => {
    paneChangeListeners.delete(listener)
  }
}

export function setPresenceForPty(ptyId: string, presence: TerminalPanePresence): void {
  if (presence.participants.length === 0 && !presence.arbitration) {
    presenceByPtyId.delete(ptyId)
  } else {
    presenceByPtyId.set(ptyId, presence)
  }
  const next = getPresenceForPty(ptyId)
  for (const listener of paneChangeListeners) {
    listener({ ptyId, presence: next })
  }
}

export function clearPresenceForPty(ptyId: string): void {
  if (!presenceByPtyId.has(ptyId)) {
    return
  }
  setPresenceForPty(ptyId, EMPTY_PANE_PRESENCE)
}

export function getPresenceForPty(ptyId: string): TerminalPanePresence {
  return presenceByPtyId.get(ptyId) ?? EMPTY_PANE_PRESENCE
}

/** Everyone on this PTY who is not the reader. `self` is host-resolved per stream, so this never
 *  renders a user as their own peer. */
export function getPeerPresenceForPty(ptyId: string): TerminalPresenceParticipant[] {
  return getPresenceForPty(ptyId).participants.filter((participant) => !participant.self)
}

export type TerminalPresenceSelection = RuntimeSessionTabDeviceSelection & {
  /** Resolved against the same snapshot the selection arrived on; null when that tab carried no title. */
  activeTabTitle: string | null
}

export type TerminalPresenceRosterEntry = {
  participants: RuntimeTerminalPresenceParticipant[]
  truncated: boolean
  selections: TerminalPresenceSelection[]
}

const EMPTY_ROSTER_ENTRY: TerminalPresenceRosterEntry = {
  participants: [],
  truncated: false,
  selections: []
}

// Why keyed by environment: one desktop can hold several paired runtimes at once, and two of them can
// name the same participantId without meaning the same person.
const rosterByEnvironmentId = new Map<string, TerminalPresenceRosterEntry>()

const rosterChangeListeners = new Set<() => void>()

export function onPresenceRosterChange(listener: () => void): () => void {
  rosterChangeListeners.add(listener)
  return () => {
    rosterChangeListeners.delete(listener)
  }
}

function notifyRosterChange(): void {
  for (const listener of rosterChangeListeners) {
    listener()
  }
}

function writeRosterEntry(environmentId: string, next: TerminalPresenceRosterEntry): void {
  if (next.participants.length === 0 && next.selections.length === 0 && !next.truncated) {
    rosterByEnvironmentId.delete(environmentId)
  } else {
    rosterByEnvironmentId.set(environmentId, next)
  }
  notifyRosterChange()
}

export function setPresenceRosterForEnvironment(
  environmentId: string,
  roster: { participants: RuntimeTerminalPresenceParticipant[]; truncated?: boolean }
): void {
  const existing = rosterByEnvironmentId.get(environmentId) ?? EMPTY_ROSTER_ENTRY
  writeRosterEntry(environmentId, {
    participants: roster.participants,
    truncated: roster.truncated === true,
    // Why kept: W8 and W9 arrive on separate channels at separate cadences, so a roster frame must not
    // discard the selections the last session.tabs snapshot published.
    selections: existing.selections
  })
}

export function setPresenceSelectionsForEnvironment(
  environmentId: string,
  selections: TerminalPresenceSelection[]
): void {
  const existing = rosterByEnvironmentId.get(environmentId) ?? EMPTY_ROSTER_ENTRY
  writeRosterEntry(environmentId, { ...existing, selections })
}

export function clearPresenceRosterForEnvironment(environmentId: string): void {
  if (!rosterByEnvironmentId.delete(environmentId)) {
    return
  }
  notifyRosterChange()
}

export function getPresenceRosterForEnvironment(
  environmentId: string
): TerminalPresenceRosterEntry {
  return rosterByEnvironmentId.get(environmentId) ?? EMPTY_ROSTER_ENTRY
}

export function getPresenceRosterEnvironmentIds(): string[] {
  return Array.from(rosterByEnvironmentId.keys())
}

/** Test-only: both lanes are process-global, so a case that seeded one would otherwise leak into the next. */
export function resetTerminalPresenceStateForTest(): void {
  presenceByPtyId.clear()
  rosterByEnvironmentId.clear()
}
