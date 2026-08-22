// Why its own module: this is the per-PTY W4 projection, and the runtime-wide roster, identity and
// label rules it sits beside are already at the counted-line ceiling with S4's and S5's projections
// still to land — splitting after they land would be a much larger diff for the same result.
import type { RuntimeTerminalStreamPresenceParticipant } from '../../shared/runtime-types'
import {
  HOST_ATTACHMENT_KEY,
  type TerminalPresenceParticipant,
  type TerminalPresenceRegistry
} from './terminal-presence-registry'
import {
  HOST_PARTICIPANT_ID,
  TERMINAL_PRESENCE_MAX_PARTICIPANTS,
  resolveHostPresenceLabel
} from './terminal-presence-snapshot'

// Why: one window for both activity flags. Long enough to bridge the gap between keystrokes in a burst,
// short enough that a chip clears while the reader still remembers pressing the key.
export const TERMINAL_PRESENCE_ACTIVITY_TTL_MS = 3000

// Why the shared type and not a local twin: this row IS the W4 wire shape, and the renderer decodes it
// against that declaration — two independent copies would drift on the first field either side adds.
export type TerminalPresenceActivityRow = RuntimeTerminalStreamPresenceParticipant

export type TerminalPresenceParticipantIndex = {
  byConnection: ReadonlyMap<string, TerminalPresenceParticipant>
  byGrant: ReadonlyMap<string, TerminalPresenceParticipant>
}

export type TerminalPresenceActivityRowsOptions = {
  registry: TerminalPresenceRegistry
  ptyId: string
  now: number
  // Why: resolved per emitting stream — nothing else lets a client learn which row is itself.
  selfParticipantId?: string | null
  // Why optional and not required: the per-stream emit builds one PTY's rows and has nothing to hoist,
  // while `terminal.list` builds every row of a response and would otherwise re-walk every connection
  // once per row. Same reason its single clock read is hoisted.
  index?: TerminalPresenceParticipantIndex
}

// Why keyed two ways: an attachment names a connection while a grant write names the durable grant, and
// the earliest connection of a grant is the one whose `since` the aggregate keeps.
export function buildTerminalPresenceParticipantIndex(
  registry: TerminalPresenceRegistry
): TerminalPresenceParticipantIndex {
  const byConnection = new Map<string, TerminalPresenceParticipant>()
  const byGrant = new Map<string, TerminalPresenceParticipant>()
  for (const [connectionId, participant] of registry.connections()) {
    byConnection.set(connectionId, participant)
    const known = byGrant.get(participant.pairedDeviceId)
    if (!known || participant.connectedAt < known.connectedAt) {
      byGrant.set(participant.pairedDeviceId, participant)
    }
  }
  return { byConnection, byGrant }
}

type ActivityDraft = Omit<TerminalPresenceActivityRow, 'self'>

// Why: one PTY's roster is who is on THIS terminal — the always-present host row belongs to the
// runtime-wide surfaces, not here, or a headless serve would name a human on every pane it never sees.
export function buildTerminalPresenceActivityRows(
  options: TerminalPresenceActivityRowsOptions
): TerminalPresenceActivityRow[] {
  const { registry, ptyId, now } = options
  const { byConnection, byGrant } = options.index ?? buildTerminalPresenceParticipantIndex(registry)
  const drafts = new Map<string, ActivityDraft>()
  const upsert = (draft: ActivityDraft): ActivityDraft => {
    const existing = drafts.get(draft.participantId)
    if (!existing) {
      drafts.set(draft.participantId, draft)
      return draft
    }
    existing.typing ||= draft.typing
    existing.writing ||= draft.writing
    existing.since = Math.min(existing.since, draft.since)
    return existing
  }
  for (const [key, attachment] of registry.attachmentsOf(ptyId)) {
    const typing = isTerminalPresenceActivityFresh(attachment.lastInteractiveInputAt, now)
    if (key === HOST_ATTACHMENT_KEY) {
      upsert({
        participantId: HOST_PARTICIPANT_ID,
        label: resolveHostPresenceLabel(),
        kind: 'host',
        typing,
        writing: false,
        since: registry.startedAt
      })
      continue
    }
    const participant = attachment.connectionId
      ? byConnection.get(attachment.connectionId)
      : undefined
    if (participant) {
      upsert({ ...toDraft(participant), typing })
    }
  }
  for (const [pairedDeviceId, lastGrantWriteAt] of registry.grantWritesOf(ptyId)) {
    // Why: a stale grant write is not a row — nobody is attached, so an expired write must clear the
    // participant entirely rather than linger as an idle name until the PTY dies.
    const participant = isTerminalPresenceActivityFresh(lastGrantWriteAt, now)
      ? byGrant.get(pairedDeviceId)
      : undefined
    if (participant) {
      upsert({ ...toDraft(participant), writing: true })
    }
  }
  return Array.from(drafts.values())
    .sort(
      (left, right) =>
        left.since - right.since || left.participantId.localeCompare(right.participantId)
    )
    .slice(0, TERMINAL_PRESENCE_MAX_PARTICIPANTS)
    .map((draft) => ({
      ...draft,
      // Why: typing outranks writing — the interactive stamp is the one that can hold a peer's keystroke,
      // so a participant doing both reads as the state with consequences.
      writing: draft.writing && !draft.typing,
      self: options.selfParticipantId === draft.participantId
    }))
}

// Why exported: the change notifier arms its falling edge off the same freshness test the rows read,
// so a drift between the two would publish a flag no expiry emit ever clears.
export function isTerminalPresenceActivityFresh(stamp: number, now: number): boolean {
  return stamp > 0 && now - stamp < TERMINAL_PRESENCE_ACTIVITY_TTL_MS
}

function toDraft(participant: TerminalPresenceParticipant): ActivityDraft {
  return {
    participantId: participant.participantId,
    label: participant.label,
    kind: participant.kind,
    typing: false,
    writing: false,
    since: participant.connectedAt
  }
}
