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
