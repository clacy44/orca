// Why: projection layer between the in-memory presence registry and every wire surface — one place
// owns labels, the aggregation key, the payload caps, and the synthesized host row.
import { hostname } from 'node:os'
import type {
  RuntimeTerminalPresenceClientEvent,
  RuntimeTerminalPresenceParticipant
} from '../../shared/runtime-client-events'
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

// Why: host-observed gate. A connection that maps to no tracked participant resolves to null, and
// callers omit the presence key entirely rather than emitting an uncorroborated placeholder. Kind is
// deliberately NOT read here: the activity rows are built from every tracked connection regardless of
// scope, so a phone refused a participant here would receive its own row marked as somebody else's —
// the "rendered as their own peer" failure. Scope gates what W2 publishes, at that emit alone.
export function resolveStreamParticipant(
  registry: TerminalPresenceRegistry,
  identity: TerminalPresenceStreamIdentity
): TerminalPresenceParticipant | null {
  if (!identity.connectionId) {
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
export function resolvePublishedParticipantByGrant(
  registry: TerminalPresenceRegistry,
  hasEstablishedSubscription: (connectionId: string) => boolean,
  pairedDeviceId: string
): TerminalPresenceParticipant | null {
  for (const [connectionId, participant] of registry.connections()) {
    if (participant.pairedDeviceId === pairedDeviceId && hasEstablishedSubscription(connectionId)) {
      return participant
    }
  }
  return null
}

export function isPublishedPresenceParticipant(
  registry: TerminalPresenceRegistry,
  hasEstablishedSubscription: (connectionId: string) => boolean,
  pairedDeviceId: string
): boolean {
  return (
    resolvePublishedParticipantByGrant(registry, hasEstablishedSubscription, pairedDeviceId) !==
    null
  )
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

// Why a projection of the same rows rather than a second aggregation: the runtime-wide roster and the
// CLI column must never disagree about who is here, and one builder is the only way to guarantee it.
// `since` is dropped deliberately — W8 is membership, and every field it carries must be one a
// keystroke cannot move, which is what makes the publisher's no-change suppression exact.
export function buildTerminalPresenceRosterParticipants(
  options: Omit<TerminalPresenceRowsOptions, 'selfParticipantId'>
): { participants: RuntimeTerminalPresenceParticipant[]; truncated?: true } {
  const rows = buildTerminalPresenceRows(options)
  const participants = rows.participants.map((row) => ({
    participantId: row.participantId,
    label: row.label,
    kind: row.kind,
    attachedTerminals: row.attachedTerminals,
    // Why false here and stamped later: this payload is built ONCE per change and read by every
    // listener, so the only honest default is "nobody" until a listener identity is applied.
    self: false
  }))
  return rows.truncated ? { participants, truncated: true } : { participants }
}

// Why a fresh event per listener: `self` is the one field that differs between two readers of the same
// membership, and mutating the shared payload in place would hand the second listener the first one's row.
export function stampTerminalPresenceSelf(
  event: RuntimeTerminalPresenceClientEvent,
  selfParticipantId: string | null
): RuntimeTerminalPresenceClientEvent {
  return {
    ...event,
    participants: event.participants.map((participant) => ({
      ...participant,
      // Why not `?? false`: a listener with no participantId (an in-process or unidentified subscriber)
      // is nobody, so every row reads false rather than defaulting to the first match.
      self: selfParticipantId !== null && participant.participantId === selfParticipantId
    }))
  }
}

export type TerminalPresenceGrantSelection = {
  pairedDeviceId: string
  activeTabId: string
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser'
}

export type TerminalPresenceDeviceSelection = {
  participantId: string
  label: string
  kind: TerminalPresenceKind
  self: boolean
  activeTabId: string
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser'
}

export type TerminalPresenceDeviceSelectionsOptions = {
  registry: TerminalPresenceRegistry
  hasEstablishedSubscription: (connectionId: string) => boolean
  selections: readonly TerminalPresenceGrantSelection[]
  // Why resolved from the caller's own grant: W9 rides a per-device projection, so the reader's row is
  // known from its RpcContext without the fan-out's per-listener pass.
  selfPairedDeviceId?: string | null
}

// Why the presence registry and not the selection store decides who appears: a selection outlives the
// device that made it (it is hydrated from disk), so publishing straight from the store would name
// people who are not here. Joining on a PUBLISHED participant is what makes W9 live-only in fact.
export function buildTerminalPresenceDeviceSelections(
  options: TerminalPresenceDeviceSelectionsOptions
): TerminalPresenceDeviceSelection[] {
  const rows = new Map<string, TerminalPresenceDeviceSelection>()
  for (const selection of options.selections) {
    const participant = resolvePublishedParticipantByGrant(
      options.registry,
      options.hasEstablishedSubscription,
      selection.pairedDeviceId
    )
    if (!participant || rows.has(participant.participantId)) {
      continue
    }
    rows.set(participant.participantId, {
      participantId: participant.participantId,
      label: participant.label,
      kind: participant.kind,
      self: options.selfPairedDeviceId === selection.pairedDeviceId,
      activeTabId: selection.activeTabId,
      activeTabType: selection.activeTabType
    })
  }
  return Array.from(rows.values())
    .sort((left, right) => left.participantId.localeCompare(right.participantId))
    .slice(0, TERMINAL_PRESENCE_MAX_PARTICIPANTS)
}
