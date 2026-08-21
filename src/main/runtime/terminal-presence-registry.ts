// Why: shared-presence state ticks per keystroke, so it lives in memory only — the device registry
// rewrites its whole secure file per mutation and is the wrong store for anything with a TTL.
import { randomUUID } from 'node:crypto'

export type TerminalPresenceParticipantKind = 'runtime' | 'mobile'

// Why: the local human has no socket and no subscription, so it owns one reserved attachment key
// (connectionId null) inside the ordinary map — that is what lets it read as typing, not writing.
export const HOST_ATTACHMENT_KEY = 'host'

export type TerminalPresenceParticipant = {
  // Why: opaque and process-local. NOT the registry deviceId, which is the relay binding identity
  // and the on-disk navigation key; nothing may ever persist against this.
  participantId: string
  pairedDeviceId: string
  label: string
  kind: TerminalPresenceParticipantKind
  connectedAt: number
  lastInboundAt: number
}

export type TerminalPresenceAttachment = {
  connectionId: string | null
  lastInteractiveInputAt: number
}

export type TerminalPresenceConnection = {
  connectionId: string
  pairedDeviceId: string
  label: string
  kind: TerminalPresenceParticipantKind
}

export type TerminalPresenceRegistryOptions = {
  // Why: Date.now() is presence's single clock domain; injectable so TTL tests drive every stamp together.
  now?: () => number
}

export class TerminalPresenceRegistry {
  private readonly participants = new Map<string, TerminalPresenceParticipant>()
  private readonly attachments = new Map<string, Map<string, TerminalPresenceAttachment>>()
  private readonly grantWrites = new Map<string, Map<string, number>>()
  private readonly participantIds = new Map<string, string>()
  private readonly now: () => number
  // Why: the synthesized host row's `since`, taken from the injected clock rather than module import,
  // so it is the one presence stamp a test can drive alongside every other one.
  startedAt: number

  constructor(options: TerminalPresenceRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
  }

  // Why: minted once per grant and reused for every later socket of that grant, so one peer's
  // extra window or reconnect never splits into two roster rows.
  private participantIdFor(pairedDeviceId: string): string {
    const existing = this.participantIds.get(pairedDeviceId)
    if (existing) {
      return existing
    }
    const participantId = randomUUID()
    this.participantIds.set(pairedDeviceId, participantId)
    return participantId
  }

  registerConnection(connection: TerminalPresenceConnection): TerminalPresenceParticipant {
    const now = this.now()
    const participant: TerminalPresenceParticipant = {
      participantId: this.participantIdFor(connection.pairedDeviceId),
      pairedDeviceId: connection.pairedDeviceId,
      label: connection.label,
      kind: connection.kind,
      connectedAt: now,
      lastInboundAt: now
    }
    this.participants.set(connection.connectionId, participant)
    return participant
  }

  releaseConnection(connectionId: string): void {
    this.participants.delete(connectionId)
    // Why: leak guard only — every stream teardown already detaches its own key; a socket that dies
    // without running one must not strand a row the rosters would keep showing.
    for (const [ptyId, byKey] of this.attachments) {
      for (const [key, attachment] of byKey) {
        if (attachment.connectionId === connectionId) {
          byKey.delete(key)
        }
      }
      if (byKey.size === 0) {
        this.attachments.delete(ptyId)
      }
    }
  }

  getParticipantByConnection(connectionId: string): TerminalPresenceParticipant | null {
    return this.participants.get(connectionId) ?? null
  }

  connections(): ReadonlyMap<string, TerminalPresenceParticipant> {
    return this.participants
  }

  stampInbound(connectionId: string): void {
    const participant = this.participants.get(connectionId)
    if (participant) {
      participant.lastInboundAt = this.now()
    }
  }

  private attachmentsFor(ptyId: string): Map<string, TerminalPresenceAttachment> {
    let byKey = this.attachments.get(ptyId)
    if (!byKey) {
      byKey = new Map()
      this.attachments.set(ptyId, byKey)
    }
    return byKey
  }

  attach(ptyId: string, subscriptionKey: string, connectionId: string): void {
    this.attachmentsFor(ptyId).set(subscriptionKey, {
      connectionId,
      lastInteractiveInputAt: 0
    })
  }

  // Why: the reserved key is written by the two guarded renderer writers, which belong to no socket.
  attachHost(ptyId: string): void {
    const byKey = this.attachmentsFor(ptyId)
    const existing = byKey.get(HOST_ATTACHMENT_KEY)
    byKey.set(HOST_ATTACHMENT_KEY, {
      connectionId: null,
      lastInteractiveInputAt: existing?.lastInteractiveInputAt ?? 0
    })
  }

  detach(ptyId: string, subscriptionKey: string): void {
    const byKey = this.attachments.get(ptyId)
    if (!byKey) {
      return
    }
    byKey.delete(subscriptionKey)
    if (byKey.size === 0) {
      this.attachments.delete(ptyId)
    }
  }

  // Why: the reserved host key belongs to no teardown path, so it dies with the PTY's whole entry.
  releasePty(ptyId: string): void {
    this.attachments.delete(ptyId)
    this.grantWrites.delete(ptyId)
  }

  attachmentsOf(ptyId: string): ReadonlyMap<string, TerminalPresenceAttachment> {
    return this.attachments.get(ptyId) ?? new Map()
  }

  attachmentsSnapshot(): ReadonlyMap<string, ReadonlyMap<string, TerminalPresenceAttachment>> {
    return this.attachments
  }

  // Why: sites (a)/(b) — a raw keystroke on a live stream is human intent, and only this stamp arms a hold.
  recordInteractiveInput(ptyId: string, subscriptionKey: string): void {
    const attachment = this.attachments.get(ptyId)?.get(subscriptionKey)
    if (attachment) {
      attachment.lastInteractiveInputAt = this.now()
    }
  }

  recordHostInteractiveInput(ptyId: string): void {
    this.attachHost(ptyId)
    this.recordInteractiveInput(ptyId, HOST_ATTACHMENT_KEY)
  }

  // Why: site (d) is a bare RPC with no subscription to hang a stamp on, so grant writes key on the
  // durable grant instead — which is also why they can never arm arbitration.
  recordGrantWrite(ptyId: string, pairedDeviceId: string): void {
    let byGrant = this.grantWrites.get(ptyId)
    if (!byGrant) {
      byGrant = new Map()
      this.grantWrites.set(ptyId, byGrant)
    }
    byGrant.set(pairedDeviceId, this.now())
  }

  grantWritesOf(ptyId: string): ReadonlyMap<string, number> {
    return this.grantWrites.get(ptyId) ?? new Map()
  }

  reset(): void {
    this.participants.clear()
    this.attachments.clear()
    this.grantWrites.clear()
    this.participantIds.clear()
    this.startedAt = this.now()
  }
}

// Why: one registry per host process — participantIds rotate on restart by construction.
export const terminalPresenceRegistry = new TerminalPresenceRegistry()
