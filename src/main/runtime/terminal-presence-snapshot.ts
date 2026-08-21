// Why: projection layer between the in-memory presence registry and every wire surface — one place
// owns labels, the aggregation key, the payload caps, and the synthesized host row.
import { hostname } from 'node:os'
import {
  HOST_ATTACHMENT_KEY,
  type TerminalPresenceParticipant,
  type TerminalPresenceRegistry
} from './terminal-presence-registry'

export type TerminalPresenceKind = 'runtime' | 'mobile' | 'host'

// Why: the local human is one synthetic participant absorbing the renderer bridge, local `orca`, and
// every other anonymous caller; §2.6 uses the same sentinel string as the grant key.
export const HOST_PARTICIPANT_ID = 'host'

// Why: bounds what a mobile (re)subscribe drags across the relay; membership-only cadence does the rest.
export const TERMINAL_PRESENCE_MAX_PARTICIPANTS = 32
export const TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS = 64

let cachedHostName: string | null = null

// Why: copied from the SSH shared-workspace roster (`hostname() || 'This device'`), the one in-repo
// precedent for naming this machine; read once so the label is identical on every target. The bare
// machine name only — the "(host)" suffix is a localization-catalog string the renderer composes off
// `kind === 'host'`, never a literal concatenated onto a peer-facing display name here.
export function resolveHostPresenceLabel(): string {
  cachedHostName ??= hostname() || 'This device'
  return cachedHostName
}

// Why: one window for both activity flags. Long enough to bridge the gap between keystrokes in a burst,
// short enough that a chip clears while the reader still remembers pressing the key.
export const TERMINAL_PRESENCE_ACTIVITY_TTL_MS = 3000

export type TerminalPresenceStreamIdentity = {
  connectionId?: string
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
}

// Why: host-observed gate. A connection that maps to no tracked runtime-scope participant resolves to
// null, and callers omit the presence key entirely rather than emitting an uncorroborated placeholder.
export function resolveStreamParticipant(
  registry: TerminalPresenceRegistry,
  identity: TerminalPresenceStreamIdentity
): TerminalPresenceParticipant | null {
  if (!identity.connectionId || identity.clientKind !== 'runtime') {
    return null
  }
  const participant = registry.getParticipantByConnection(identity.connectionId)
  if (!participant) {
    return null
  }
  // Why: the socket's grant and the dispatch envelope must agree before a participantId goes on the wire.
  if (identity.pairedDeviceId && participant.pairedDeviceId !== identity.pairedDeviceId) {
    return null
  }
  return participant
}

export type TerminalPresenceStreamPresence = {
  participantId: string
  label: string
  kind: TerminalPresenceKind
  self: true
}

export function toStreamPresence(
  participant: TerminalPresenceParticipant
): TerminalPresenceStreamPresence {
  return {
    participantId: participant.participantId,
    label: participant.label,
    kind: participant.kind,
    self: true
  }
}

// Why: site (d) is a bare RPC and no host-observed field separates a headless agent's one-shot socket
// from a human's desktop send — but a grant does: the desktop's grant also holds the shared-control
// subscription, while the coordinator's holds only the one-shot. Fails dark, never wrong.
export function isPublishedPresenceParticipant(
  registry: TerminalPresenceRegistry,
  hasEstablishedSubscription: (connectionId: string) => boolean,
  pairedDeviceId: string
): boolean {
  for (const [connectionId, participant] of registry.connections()) {
    if (participant.pairedDeviceId === pairedDeviceId && hasEstablishedSubscription(connectionId)) {
      return true
    }
  }
  return false
}

export type TerminalPresenceActivityRow = {
  participantId: string
  label: string
  kind: TerminalPresenceKind
  typing: boolean
  writing: boolean
  since: number
  self: boolean
}

export type TerminalPresenceActivityRowsOptions = {
  registry: TerminalPresenceRegistry
  ptyId: string
  now: number
  // Why: resolved per emitting stream — nothing else lets a client learn which row is itself.
  selfParticipantId?: string | null
}

type ActivityDraft = Omit<TerminalPresenceActivityRow, 'self'>

// Why: one PTY's roster is who is on THIS terminal — the always-present host row belongs to the
// runtime-wide surfaces, not here, or a headless serve would name a human on every pane it never sees.
export function buildTerminalPresenceActivityRows(
  options: TerminalPresenceActivityRowsOptions
): TerminalPresenceActivityRow[] {
  const { registry, ptyId, now } = options
  const isFresh = (stamp: number): boolean =>
    stamp > 0 && now - stamp < TERMINAL_PRESENCE_ACTIVITY_TTL_MS
  const byConnection = new Map<string, TerminalPresenceParticipant>()
  const byGrant = new Map<string, TerminalPresenceParticipant>()
  for (const [connectionId, participant] of registry.connections()) {
    byConnection.set(connectionId, participant)
    const known = byGrant.get(participant.pairedDeviceId)
    if (!known || participant.connectedAt < known.connectedAt) {
      byGrant.set(participant.pairedDeviceId, participant)
    }
  }
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
    const typing = isFresh(attachment.lastInteractiveInputAt)
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
    const participant = isFresh(lastGrantWriteAt) ? byGrant.get(pairedDeviceId) : undefined
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

export type TerminalPresenceRow = {
  participantId: string
  label: string
  kind: TerminalPresenceKind
  self: boolean
  // Why: handles, never ptyIds — ptyId is an internal runtime identifier no presence surface publishes.
  attachedTerminals: string[]
  since: number
}

export type TerminalPresenceRowsOptions = {
  registry: TerminalPresenceRegistry
  // Why: publish a grant only once one of its sockets holds a live subscription, so the one-shot socket
  // every remote `orca` command opens never flashes a participant in and out.
  hasEstablishedSubscription: (connectionId: string) => boolean
  // Why: required, and applied before the cap — bounding ptyIds and translating afterwards would apply
  // the limit to the wrong list. A pty with no live handle resolves to null and is dropped.
  resolveTerminalHandle: (ptyId: string) => string | null
  // Why: resolved per listener — nothing else lets a client learn which row is itself.
  selfParticipantId?: string | null
  // Why: the host's attachments are "what is selected and visible", not its reserved activity key.
  hostAttachedTerminals?: readonly string[]
}

export type TerminalPresenceRows = {
  participants: TerminalPresenceRow[]
  truncated?: true
}

type Aggregate = {
  participant: TerminalPresenceParticipant
  connectedAt: number
  established: boolean
  attachedPtyIds: Set<string>
}

function collectAggregates(
  registry: TerminalPresenceRegistry,
  hasEstablishedSubscription: (connectionId: string) => boolean
): Map<string, Aggregate> {
  const byParticipant = new Map<string, Aggregate>()
  const participantByConnection = new Map<string, TerminalPresenceParticipant>()
  for (const [connectionId, participant] of registry.connections()) {
    participantByConnection.set(connectionId, participant)
    const existing = byParticipant.get(participant.participantId)
    const established = hasEstablishedSubscription(connectionId)
    if (existing) {
      existing.connectedAt = Math.min(existing.connectedAt, participant.connectedAt)
      existing.established ||= established
      continue
    }
    byParticipant.set(participant.participantId, {
      participant,
      connectedAt: participant.connectedAt,
      established,
      attachedPtyIds: new Set()
    })
  }
  for (const [ptyId, byKey] of registry.attachmentsSnapshot()) {
    for (const [key, attachment] of byKey) {
      if (key === HOST_ATTACHMENT_KEY || attachment.connectionId === null) {
        continue
      }
      const participant = participantByConnection.get(attachment.connectionId)
      const aggregate = participant ? byParticipant.get(participant.participantId) : undefined
      aggregate?.attachedPtyIds.add(ptyId)
    }
  }
  return byParticipant
}

function boundTerminals(handles: Iterable<string>): string[] {
  return Array.from(handles).slice(0, TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS)
}

function toRow(aggregate: Aggregate, options: TerminalPresenceRowsOptions): TerminalPresenceRow {
  const handles: string[] = []
  for (const ptyId of aggregate.attachedPtyIds) {
    const handle = options.resolveTerminalHandle(ptyId)
    if (handle) {
      handles.push(handle)
    }
  }
  return {
    participantId: aggregate.participant.participantId,
    label: aggregate.participant.label,
    kind: aggregate.participant.kind,
    self: options.selfParticipantId === aggregate.participant.participantId,
    attachedTerminals: boundTerminals(handles),
    since: aggregate.connectedAt
  }
}

// Why: one entry per participantId — a peer's shared-control socket and each of its terminal sockets
// collapse to a single row whose attachments are the union and whose `since` is the earliest connect.
export function buildTerminalPresenceRows(
  options: TerminalPresenceRowsOptions
): TerminalPresenceRows {
  // Why: kind 'mobile' rows reach here as soon as a phone authenticates, but a phone has no bounded
  // reap horizon — S7 owes them the `stale` suffix before any surface publishes them, or the two
  // liveness contracts blend silently.
  const aggregates = Array.from(
    collectAggregates(options.registry, options.hasEstablishedSubscription).values()
  ).filter((aggregate) => aggregate.established)
  aggregates.sort(
    (left, right) =>
      left.connectedAt - right.connectedAt ||
      left.participant.participantId.localeCompare(right.participant.participantId)
  )
  const hostRow: TerminalPresenceRow = {
    participantId: HOST_PARTICIPANT_ID,
    label: resolveHostPresenceLabel(),
    kind: 'host',
    self: options.selfParticipantId === HOST_PARTICIPANT_ID,
    attachedTerminals: boundTerminals(options.hostAttachedTerminals ?? []),
    // Why: the host row does not depend on anything connecting, so its "since" is when presence
    // started — read from the registry's injected clock so tests drive every stamp through one clock.
    since: options.registry.startedAt
  }
  const capacity = TERMINAL_PRESENCE_MAX_PARTICIPANTS - 1
  const participants = [
    hostRow,
    ...aggregates.slice(0, capacity).map((aggregate) => toRow(aggregate, options))
  ]
  return aggregates.length > capacity ? { participants, truncated: true } : { participants }
}
