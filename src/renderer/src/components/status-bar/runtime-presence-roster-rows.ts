// Why a pure join beside the component: W8 (membership) and W9 (selections) arrive on separate channels
// at separate cadences, so "who is here and what are they looking at" is a merge with rules — one row per
// participant, joined on participantId, and a selection for somebody the roster does not list is dropped
// rather than promoted into a row the roster never corroborated.
import type { TerminalPresenceRosterEntry } from '@/lib/pane-manager/terminal-presence-state'

export type RuntimePresenceRosterRow = {
  environmentId: string
  participantId: string
  label: string
  kind: 'runtime' | 'mobile' | 'host'
  self: boolean
  attachedCount: number
  activeTabTitle: string | null
  // Why carried instead of derived: only the host knows a phone stopped answering, so the row states it
  // and the surface phrases it — a renderer that guessed would need a liveness signal it does not have.
  lastSeenAt: number | null
}

export type RuntimePresenceRoster = {
  rows: RuntimePresenceRosterRow[]
  // Why carried out rather than read off a row: the host caps the payload, so "there are more" is a
  // property of the roster, and a client that cannot say it silently claims a truncated list is whole.
  truncated: boolean
}

export function buildRuntimePresenceRosterRows(
  entries: Iterable<[string, TerminalPresenceRosterEntry]>
): RuntimePresenceRoster {
  const rows: RuntimePresenceRosterRow[] = []
  let truncated = false
  for (const [environmentId, entry] of entries) {
    truncated ||= entry.truncated
    const titleByParticipantId = new Map(
      entry.selections.map((selection) => [selection.participantId, selection.activeTabTitle])
    )
    for (const participant of entry.participants) {
      rows.push({
        environmentId,
        participantId: participant.participantId,
        label: participant.label,
        kind: participant.kind,
        self: participant.self,
        attachedCount: participant.attachedTerminals.length,
        activeTabTitle: titleByParticipantId.get(participant.participantId) ?? null,
        lastSeenAt: participant.stale ? (participant.lastSeenAt ?? null) : null
      })
    }
  }
  // Why the host first: it is the machine everyone else is paired into, so it anchors the list rather
  // than sorting into it by name.
  rows.sort(
    (left, right) =>
      Number(right.kind === 'host') - Number(left.kind === 'host') ||
      left.label.localeCompare(right.label) ||
      left.participantId.localeCompare(right.participantId)
  )
  return { rows, truncated }
}
