// Why its own module: `terminal.list` is the one presence surface whose caller may be anonymous, so the
// self/mobile policy and the boundary pass belong together and away from the per-stream projections —
// which also keeps the shared snapshot module free for the runtime-wide roster.
import type { RuntimeTerminalPresence, RuntimeTerminalSummary } from '../../shared/runtime-types'
import type { TerminalPresenceRegistry } from './terminal-presence-registry'
import { buildTerminalPresenceActivityRows } from './terminal-presence-activity-rows'
import {
  HOST_PARTICIPANT_ID,
  resolveStreamParticipant,
  type TerminalPresenceStreamIdentity
} from './terminal-presence-snapshot'

export type TerminalListPresenceScope = {
  // Why null rather than absent: a caller the host cannot resolve gets no `self` at all, never a wrong one.
  selfParticipantId: string | null
}

// Why the scope is resolved from the RPC envelope and not inside the runtime: only the dispatch boundary
// knows who is asking. Anonymity is LOCAL, not non-streaming — a remote caller carries identity on every
// request, streaming or not, while the Unix-socket CLI and the Electron renderer bridge carry none.
export function resolveTerminalListPresenceScope(
  registry: TerminalPresenceRegistry,
  identity: TerminalPresenceStreamIdentity
): TerminalListPresenceScope | null {
  // Why the gate is per-caller and never per-row: the roster's `'presence' in terminal` probe is only
  // sound while a response carries the key on every row or on none. A phone renders no presence surface
  // today, so it is served the byte-identical pre-presence payload instead of a roster it would drop.
  if (identity.clientKind === 'mobile') {
    return null
  }
  const participant = resolveStreamParticipant(registry, identity)
  if (participant) {
    return { selfParticipantId: participant.participantId }
  }
  // Why the host row: an anonymous caller reaches the runtime only through the two local paths, and both
  // are already declared one participant — the same synthetic host the reserved attachment key names.
  const anonymousLocalCaller = !identity.connectionId && !identity.pairedDeviceId
  return { selfParticipantId: anonymousLocalCaller ? HOST_PARTICIPANT_ID : null }
}

export type TerminalListPresenceOptions = TerminalListPresenceScope & {
  registry: TerminalPresenceRegistry
}

// Why one pass at the boundary instead of inside a summary builder: `terminal.list` has two builders and
// a PTY-fallback loop that can dominate on a headless host, so only a pass over the finished array makes
// "asked for presence ⇒ the key is on EVERY returned row" bind on both — and on any future producer.
export function applyTerminalListPresence(
  terminals: RuntimeTerminalSummary[],
  options: TerminalListPresenceOptions
): void {
  // Why one clock read for the whole pass: two rows of one response must never disagree about who is
  // typing, and the registry owns presence's single clock domain.
  const now = options.registry.now()
  for (const terminal of terminals) {
    terminal.presence = terminal.ptyId
      ? buildTerminalPresence(terminal.ptyId, now, options)
      : { attachedCount: 0, participants: [] }
  }
}

function buildTerminalPresence(
  ptyId: string,
  now: number,
  options: TerminalListPresenceOptions
): RuntimeTerminalPresence {
  // Why the same builder the stream event uses: a column that disagreed with the roster beside it would
  // be worse than no column, and one builder is the only way that cannot drift.
  const participants = buildTerminalPresenceActivityRows({
    registry: options.registry,
    ptyId,
    now,
    selfParticipantId: options.selfParticipantId
  }).map((row) => ({
    participantId: row.participantId,
    label: row.label,
    typing: row.typing,
    writing: row.writing,
    ...(row.self ? { self: true as const } : {})
  }))
  return { attachedCount: participants.length, participants }
}
