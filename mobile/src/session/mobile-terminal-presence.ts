// Read-only presence for the phone: who else is on this terminal, and whether they are typing. The
// phone is never held and never arbitrates (§3), so there is nothing here but a decoder and one line
// of text — anything more would put a take-back affordance on the one client that can never use it.
import { terminalPresenceLastSeenMinutes } from '../../../src/shared/terminal-presence-last-seen'

/** The subset of the host's W4 row this screen renders. Extra keys are ignored by construction, which
 *  is what lets a newer host add fields without a mobile release. */
export type MobileTerminalPresenceRow = {
  participantId: string
  label: string
  /** The union is a rendering hint, not a gate: a newer host may add a kind, and this phone cannot be
   *  respun to catch up with it. An unfamiliar one decodes as an ordinary peer. */
  kind: 'runtime' | 'mobile' | 'host' | (string & {})
  self: boolean
  typing: boolean
  writing: boolean
  stale?: boolean
  lastSeenAt?: number
}

const UNNAMED_LABEL = 'Unnamed device'

function isPresenceRow(value: unknown): value is MobileTerminalPresenceRow {
  if (!value || typeof value !== 'object') {
    return false
  }
  const row = value as Record<string, unknown>
  return (
    typeof row.participantId === 'string' &&
    typeof row.label === 'string' &&
    typeof row.kind === 'string' &&
    typeof row.self === 'boolean' &&
    typeof row.typing === 'boolean' &&
    typeof row.writing === 'boolean'
  )
}

/** Null for every stream event that is not a well-formed `terminal-presence`, so an older host that
 *  echoes nothing and a newer one that adds an event type both leave this screen unchanged. */
export function decodeMobileTerminalPresence(event: unknown): MobileTerminalPresenceRow[] | null {
  if (!event || typeof event !== 'object') {
    return null
  }
  const data = event as Record<string, unknown>
  if (data.type !== 'terminal-presence' || !Array.isArray(data.participants)) {
    return null
  }
  // Why all-or-nothing over the STRUCTURAL fields only: a partly readable roster would show somebody as
  // alone who is not. A new `kind` VALUE is not that — rejecting one would blank the banner on every row
  // of a roster the phone can otherwise read in full, which is the opposite of degrading.
  return data.participants.every(isPresenceRow)
    ? (data.participants as MobileTerminalPresenceRow[])
    : null
}

// Why typing outranks writing and stale outranks nothing: the same ladder the desktop chip uses, so
// two people looking at the same terminal from different devices read the same words.
function rank(row: MobileTerminalPresenceRow): number {
  if (row.typing) {
    return 2
  }
  if (row.writing) {
    return 1
  }
  return row.stale ? -1 : 0
}

/** One line naming the loudest peer, or null when the reader is alone. `self` is host-resolved, so this
 *  can never render the holder of this phone as their own peer. */
export function summarizeMobileTerminalPresence(
  rows: readonly MobileTerminalPresenceRow[],
  now: number = Date.now()
): string | null {
  const peers = rows.filter((row) => !row.self)
  if (peers.length === 0) {
    return null
  }
  const loudest = peers.reduce((best, row) => (rank(row) > rank(best) ? row : best))
  const label = loudest.label.length > 0 ? loudest.label : UNNAMED_LABEL
  const others = peers.length > 1 ? ` +${peers.length - 1}` : ''
  if (loudest.stale) {
    // Why plain "attached" without the stamp rather than a fabricated one: this phone does not know how
    // long the silence has run, and inventing a duration for it is the one thing staleness copy exists
    // to prevent. With it, the host's shared helper owns the floor — the stamp is on the host's clock.
    if (loudest.lastSeenAt === undefined) {
      return `${label} attached${others}`
    }
    const minutes = terminalPresenceLastSeenMinutes(loudest.lastSeenAt, now)
    return `${label} attached, last seen ${minutes}m ago${others}`
  }
  if (loudest.typing) {
    return `${label} is typing${others}`
  }
  return loudest.writing ? `${label} is writing${others}` : `${label} attached${others}`
}
