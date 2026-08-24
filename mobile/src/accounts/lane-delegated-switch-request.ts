/**
 * The phone half of §2l: the phone chooses, the desktop pushes, the host arbitrates.
 *
 * Today's screen sends `accounts.selectClaude` unconditionally, which §2d refuses
 * `accounts.selection_out_of_scope` the moment the caller's person holds a lane. This routes that
 * one call instead, and only when the host says the caller holds a lane.
 *
 * Two rules this module exists to keep:
 *  - the outcome is learned from the lane status stream, NEVER from the return value: the host
 *    genuinely does not know it yet and answers `pending`.
 *  - a refusal renders the HOST's sentence verbatim. There is no client-side code table, because
 *    §3's Rule-3 row makes the sentence the host's job — an older phone has no string for
 *    `desktop_unavailable` or `switch_timed_out` and must not invent one.
 */

export const AGENT_IDENTITY_LANES_CAPABILITY = 'agent.identity-lanes.v1'

export type MobileDelegableAccount = {
  delegatedAccountId: string
  displayName: string | null
  email: string | null
}

export type MobileLaneProjection = {
  /** Whether the host published a lane row belonging to THIS caller. */
  holdsLane: boolean
  laneState: 'loaded' | 'absent' | 'reauth-required' | null
  heldDisplayName: string | null
  /** Which delegable token the lane holds. Comparing display names marked every row when null. */
  heldDelegatedAccountId: string | null
  delegable: MobileDelegableAccount[]
}

export const NO_LANE: MobileLaneProjection = {
  holdsLane: false,
  laneState: null,
  heldDisplayName: null,
  heldDelegatedAccountId: null,
  delegable: []
}

/**
 * Reads the additive `claudeLanes` rows off a raw accounts snapshot.
 *
 * Deliberately its own reader rather than a widening of `decodeAccountsSnapshot`: an old host
 * sends no such field, and a phone that cannot parse it must degrade to today's behaviour, not
 * fail the whole snapshot.
 */
export function readLaneProjection(snapshot: unknown): MobileLaneProjection {
  const rows = asRecord(snapshot)?.claudeLanes
  if (!Array.isArray(rows)) {
    return NO_LANE
  }
  const self = rows.map(asRecord).find((row) => row?.scope === 'self')
  if (!self) {
    return NO_LANE
  }
  return {
    holdsLane: true,
    laneState: readLaneState(self.laneState),
    heldDisplayName: readString(self.displayName),
    heldDelegatedAccountId: readString(self.heldDelegatedAccountId),
    delegable: readDelegable(self.delegable)
  }
}

export type ClaudeSwitchCall =
  | { method: 'accounts.selectClaude'; params: { accountId: string | null } }
  | { method: 'accounts.lane.requestSwitch'; params: { delegatedAccountId: string } }
  | { method: null; reason: 'unsupported-host' | 'not-delegable' }

/**
 * The branch §5 pins: with a lane it is `requestSwitch`, without one it stays `selectClaude`.
 *
 * Capability-gated, because a new method against an old host fails as `method_not_found` and the
 * person should be told to update the host rather than shown a stack trace.
 */
export function resolveClaudeSwitchCall(args: {
  lane: MobileLaneProjection
  accountId: string | null
  delegatedAccountId?: string | null
  hostCapabilities: readonly string[]
}): ClaudeSwitchCall {
  if (!args.lane.holdsLane) {
    return { method: 'accounts.selectClaude', params: { accountId: args.accountId } }
  }
  if (!args.hostCapabilities.includes(AGENT_IDENTITY_LANES_CAPABILITY)) {
    return { method: null, reason: 'unsupported-host' }
  }
  if (!args.delegatedAccountId) {
    return { method: null, reason: 'not-delegable' }
  }
  return {
    method: 'accounts.lane.requestSwitch',
    params: { delegatedAccountId: args.delegatedAccountId }
  }
}

/**
 * Whether to open `accounts.lane.statusSubscribe` — gated on the SAME host capability its sibling
 * `requestSwitch` is gated on, so an old host produces "update the host" and not a raw
 * `method_not_found` from a stream that never rides.
 */
export function shouldSubscribeToLaneStatus(args: {
  lane: MobileLaneProjection
  hostCapabilities: readonly string[]
  connected: boolean
}): boolean {
  return (
    args.connected &&
    args.lane.holdsLane &&
    args.hostCapabilities.includes(AGENT_IDENTITY_LANES_CAPABILITY)
  )
}

export type SwitchRequestState =
  | { status: 'idle' }
  | { status: 'pending'; requestId: string | null; delegatedAccountId: string }
  | { status: 'failed'; message: string }
  | { status: 'switched'; displayName: string | null }

export type SwitchRequestEvent =
  | { type: 'requested'; requestId: string | null; delegatedAccountId: string }
  | { type: 'refused'; message: string }
  | { type: 'lane-frame'; frame: unknown }

export const IDLE_SWITCH_STATE: SwitchRequestState = { status: 'idle' }

/**
 * `pending` until the lane status stream says otherwise — a returned `pending` is not an outcome.
 */
export function reduceSwitchRequest(
  state: SwitchRequestState,
  event: SwitchRequestEvent
): SwitchRequestState {
  if (event.type === 'requested') {
    return {
      status: 'pending',
      requestId: event.requestId,
      delegatedAccountId: event.delegatedAccountId
    }
  }
  if (event.type === 'refused') {
    return { status: 'failed', message: event.message }
  }
  const frame = asRecord(event.frame)
  if (!frame) {
    return state
  }
  if (frame.type === 'switch-failed' && state.status === 'pending') {
    // The host's sentence, verbatim: this client owns no code table (§3's Rule-3 row).
    return { status: 'failed', message: readString(frame.message) ?? '' }
  }
  if (frame.type === 'status' || frame.type === 'ready') {
    const status = asRecord(frame.status)
    if (state.status === 'pending' && status?.laneState === 'loaded') {
      return { status: 'switched', displayName: readString(status.heldDisplayName) }
    }
  }
  return state
}

function readDelegable(value: unknown): MobileDelegableAccount[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: MobileDelegableAccount[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const delegatedAccountId = readString(record?.delegatedAccountId)
    if (!delegatedAccountId) {
      continue
    }
    rows.push({
      delegatedAccountId,
      displayName: readString(record?.displayName),
      email: readString(record?.email)
    })
  }
  return rows
}

function readLaneState(value: unknown): MobileLaneProjection['laneState'] {
  return value === 'loaded' || value === 'absent' || value === 'reauth-required' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/**
 * Whether THIS delegable row is the one the lane holds.
 *
 * Keyed on the stable token the host publishes, never on the two nullable owner-authored names:
 * with no display names set, `null === null` marked the whole list "Loaded on this host".
 */
export function isLaneAccountLoaded(
  lane: MobileLaneProjection,
  delegatedAccountId: string
): boolean {
  return lane.laneState === 'loaded' && lane.heldDelegatedAccountId === delegatedAccountId
}
