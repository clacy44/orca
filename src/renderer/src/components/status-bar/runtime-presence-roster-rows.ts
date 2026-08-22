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
}

export function buildRuntimePresenceRosterRows(
  entries: Iterable<[string, TerminalPresenceRosterEntry]>
): RuntimePresenceRosterRow[] {
  const rows: RuntimePresenceRosterRow[] = []
  for (const [environmentId, entry] of entries) {
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
        activeTabTitle: titleByParticipantId.get(participant.participantId) ?? null
      })
    }
  }
  // Why the host first: it is the machine everyone else is paired into, so it anchors the list rather
  // than sorting into it by name.
  return rows.sort(
    (left, right) =>
      Number(right.kind === 'host') - Number(left.kind === 'host') ||
      left.label.localeCompare(right.label) ||
      left.participantId.localeCompare(right.participantId)
  )
}
