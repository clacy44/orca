// Why: shared-presence state ticks per keystroke, so it lives in memory only — the device registry
// rewrites its whole secure file per mutation and is the wrong store for anything with a TTL.
import { randomUUID } from 'node:crypto'
import { MOBILE_PRESENCE_STALE_MS } from '../../shared/terminal-presence-last-seen'

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

// Why: every mutator publishes here, so a stamp site cannot land a change no surface hears — the
// alternative (each caller remembering to notify) is exactly how a silent presence bug ships.
export type TerminalPresenceChangeListener = (ptyId: string) => void

// Why its own channel: joining and leaving belong to no ptyId, so the per-PTY feed above cannot carry
// them — a peer holding only a shared-control socket would otherwise never reach the runtime-wide roster.
export type TerminalPresenceMembershipListener = () => void

export class TerminalPresenceRegistry {
  private readonly participants = new Map<string, TerminalPresenceParticipant>()
  private readonly attachments = new Map<string, Map<string, TerminalPresenceAttachment>>()
  private readonly grantWrites = new Map<string, Map<string, number>>()
  private readonly participantIds = new Map<string, string>()
  private readonly changeListeners = new Set<TerminalPresenceChangeListener>()
  private readonly membershipListeners = new Set<TerminalPresenceMembershipListener>()
  private readonly clock: () => number
  // Why: the synthesized host row's `since`, taken from the injected clock rather than module import,
  // so it is the one presence stamp a test can drive alongside every other one.
  startedAt: number

  constructor(options: TerminalPresenceRegistryOptions = {}) {
    // Why read through rather than capture Date.now: one clock must drive the remote stamp sites and the
    // host's IPC writers alike, and a captured reference would ignore a test's injected clock.
    this.clock = options.now ?? ((): number => Date.now())
    this.startedAt = this.now()
  }

  // Why exposed: every reader that evaluates a TTL must compare against the clock that wrote the stamps,
  // and a caller reaching for Date.now() re-opens the mixed-domain hazard one level above the registry.
  now(): number {
    return this.clock()
  }

  onChange(listener: TerminalPresenceChangeListener): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  onMembershipChange(listener: TerminalPresenceMembershipListener): () => void {
    this.membershipListeners.add(listener)
    return () => {
      this.membershipListeners.delete(listener)
    }
  }

  private notifyChanged(ptyId: string): void {
    for (const listener of this.changeListeners) {
      listener(ptyId)
    }
  }

  private notifyMembershipChanged(): void {
    for (const listener of this.membershipListeners) {
      listener()
    }
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
    this.notifyMembershipChanged()
    return participant
  }

  // Why: the mint-once mapping is bound to the DURABLE grant, not to a connection, so no disconnect may
  // drop it (§2.1 wants one id across a peer's reconnects) — revocation is the one event that may.
  forgetGrant(pairedDeviceId: string): void {
    this.participantIds.delete(pairedDeviceId)
    this.notifyMembershipChanged()
    for (const [connectionId, participant] of this.participants) {
      if (participant.pairedDeviceId === pairedDeviceId) {
        this.releaseConnection(connectionId)
      }
    }
    // Why swept separately: grant writes are keyed on the durable grant, so the connection sweep above
    // never reaches them — a revoked device's write would otherwise sit in the map until PTY exit.
    for (const [ptyId, byGrant] of this.grantWrites) {
      if (!byGrant.delete(pairedDeviceId)) {
        continue
      }
      if (byGrant.size === 0) {
        this.grantWrites.delete(ptyId)
      }
      this.notifyChanged(ptyId)
    }
  }

  releaseConnection(connectionId: string): void {
    if (this.participants.delete(connectionId)) {
      this.notifyMembershipChanged()
    }
    // Why: leak guard only — every stream teardown already detaches its own key; a socket that dies
    // without running one must not strand a row the rosters would keep showing.
    for (const [ptyId, byKey] of this.attachments) {
      let dropped = false
      for (const [key, attachment] of byKey) {
        if (attachment.connectionId === connectionId) {
          byKey.delete(key)
          dropped = true
        }
      }
      if (byKey.size === 0) {
        this.attachments.delete(ptyId)
      }
      if (dropped) {
        this.notifyChanged(ptyId)
      }
    }
  }

  getParticipantByConnection(connectionId: string): TerminalPresenceParticipant | null {
    return this.participants.get(connectionId) ?? null
  }

  connections(): ReadonlyMap<string, TerminalPresenceParticipant> {
    return this.participants
  }

  // Why edge-triggered: this runs on EVERY inbound frame, so an unconditional notify would fan the
  // runtime-wide roster out at the phone's 2-3 s polling rate. Only crossing back over the horizon
  // changes what a surface renders — and nothing else will republish it, because the falling edge that
  // raised the flag is spent and re-arms nothing while the row stays stale.
  stampInbound(connectionId: string): void {
    const participant = this.participants.get(connectionId)
    if (!participant) {
      return
    }
    const now = this.now()
    const wasStale =
      participant.kind === 'mobile' && now - participant.lastInboundAt >= MOBILE_PRESENCE_STALE_MS
    participant.lastInboundAt = now
    if (!wasStale) {
      return
    }
    // Why per connection and not per participant: a connection past the horizon is the only one that can
    // flip the aggregate, so this never misses a recovery — and a phone whose second socket stayed fresh
    // republishes a payload the roster's fingerprint diff drops.
    this.notifyMembershipChanged()
    for (const ptyId of this.ptyIdsAttachedTo(connectionId)) {
      this.notifyChanged(ptyId)
    }
  }

  private ptyIdsAttachedTo(connectionId: string): string[] {
    const ptyIds: string[] = []
    for (const [ptyId, byKey] of this.attachments) {
      for (const attachment of byKey.values()) {
        if (attachment.connectionId === connectionId) {
          ptyIds.push(ptyId)
          break
        }
      }
    }
    return ptyIds
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
    this.notifyChanged(ptyId)
  }

  // Why: the reserved key is written by the two guarded renderer writers, which belong to no socket.
  attachHost(ptyId: string): void {
    const byKey = this.attachmentsFor(ptyId)
    const existing = byKey.get(HOST_ATTACHMENT_KEY)
    byKey.set(HOST_ATTACHMENT_KEY, {
      connectionId: null,
      lastInteractiveInputAt: existing?.lastInteractiveInputAt ?? 0
    })
    this.notifyChanged(ptyId)
  }

  detach(ptyId: string, subscriptionKey: string): void {
    const byKey = this.attachments.get(ptyId)
    if (!byKey?.delete(subscriptionKey)) {
      return
    }
    if (byKey.size === 0) {
      this.attachments.delete(ptyId)
    }
    this.notifyChanged(ptyId)
  }

  // Why: the reserved host key belongs to no teardown path, so it dies with the PTY's whole entry.
  releasePty(ptyId: string): void {
    this.attachments.delete(ptyId)
    this.grantWrites.delete(ptyId)
    this.notifyChanged(ptyId)
  }

  attachmentsOf(ptyId: string): ReadonlyMap<string, TerminalPresenceAttachment> {
    return this.attachments.get(ptyId) ?? new Map()
  }

  attachmentsSnapshot(): ReadonlyMap<string, ReadonlyMap<string, TerminalPresenceAttachment>> {
    return this.attachments
  }

  // Why here and not two accessors: `participants` is private, so openInMyLane's authorization join
  // (attachmentsOf → connectionId → pairedDeviceId) runs inside the registry and exposes only the
  // grants — never a participant or a principal. The host applies `principalOf` (§2g). The reserved
  // host key (connectionId null) is skipped, so only real attached grants ever count.
  grantsAttachedTo(ptyId: string): string[] {
    const grants: string[] = []
    for (const attachment of this.attachmentsOf(ptyId).values()) {
      if (attachment.connectionId === null) {
        continue
      }
      const participant = this.participants.get(attachment.connectionId)
      if (participant) {
        grants.push(participant.pairedDeviceId)
      }
    }
    return grants
  }

  // Why: sites (a)/(b) — a raw keystroke on a live stream is human intent, and only this stamp arms a hold.
  recordInteractiveInput(ptyId: string, subscriptionKey: string): void {
    const attachment = this.attachments.get(ptyId)?.get(subscriptionKey)
    if (attachment) {
      attachment.lastInteractiveInputAt = this.now()
      this.notifyChanged(ptyId)
    }
  }

  // Why not attachHost + recordInteractiveInput: the reserved key is created and stamped in one step, so
  // one keystroke publishes one change instead of two rounds through every surface's coalescer.
  recordHostInteractiveInput(ptyId: string): void {
    this.attachmentsFor(ptyId).set(HOST_ATTACHMENT_KEY, {
      connectionId: null,
      lastInteractiveInputAt: this.now()
    })
    this.notifyChanged(ptyId)
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
    this.notifyChanged(ptyId)
  }

  grantWritesOf(ptyId: string): ReadonlyMap<string, number> {
    return this.grantWrites.get(ptyId) ?? new Map()
  }

  // Why listeners survive: reset clears state, not wiring — the notifier subscribes once at import and
  // a test that reset it would silently stop publishing every later change.
  reset(): void {
    this.participants.clear()
    this.attachments.clear()
    this.grantWrites.clear()
    this.participantIds.clear()
    this.startedAt = this.now()
    this.notifyMembershipChanged()
  }
}

// Why: one registry per host process — participantIds rotate on restart by construction.
export const terminalPresenceRegistry = new TerminalPresenceRegistry()
