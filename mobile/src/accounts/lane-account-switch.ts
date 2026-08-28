/**
 * S9-L2 (design rev 38 §2l/§3): the phone acts DIRECTLY on the lane now — no desktop push, no
 * `pending` state, no lane-status subscription to learn the outcome. `accounts.lane.selectAccount`
 * is a local file rewrite on the host and completes synchronously.
 *
 * Replaces `resolveClaudeSwitchCall`'s role for the v2 model — S9-L3 deletes the push model and the
 * v1 routing module (`lane-delegated-switch-request.ts`) outright; `accounts.tsx` now wires only
 * this one.
 */
export const AGENT_IDENTITY_LANES_V2_CAPABILITY = 'agent.identity-lanes.v2'

export type LaneAccountRow = {
  laneAccountId: string
  email: string
  label: string | null
  active: boolean
}

export type LaneAccountsProjection = {
  holdsLane: boolean
  accounts: LaneAccountRow[]
}

export const NO_LANE_ACCOUNTS: LaneAccountsProjection = { holdsLane: false, accounts: [] }

export type LaneAccountSwitchCall =
  | { method: 'accounts.selectClaude'; params: { accountId: string | null } }
  | { method: 'accounts.lane.selectAccount'; params: { laneAccountId: string } }
  | { method: null; reason: 'unsupported-host' | 'account_unknown' }

/**
 * With no lane: unchanged, `accounts.selectClaude`. With a lane: `accounts.lane.selectAccount`
 * among the lane's OWN accounts, gated on v2 — a v1-only host gets "update the host", never a
 * silent fall-back to the deleted `requestSwitch`.
 */
export function resolveLaneAccountSwitchCall(args: {
  lane: LaneAccountsProjection
  accountId: string | null
  laneAccountId?: string | null
  hostCapabilities: readonly string[]
}): LaneAccountSwitchCall {
  if (!args.lane.holdsLane) {
    return { method: 'accounts.selectClaude', params: { accountId: args.accountId } }
  }
  if (!args.hostCapabilities.includes(AGENT_IDENTITY_LANES_V2_CAPABILITY)) {
    return { method: null, reason: 'unsupported-host' }
  }
  const laneAccountId = args.laneAccountId ?? null
  if (!laneAccountId || !args.lane.accounts.some((a) => a.laneAccountId === laneAccountId)) {
    return { method: null, reason: 'account_unknown' }
  }
  return { method: 'accounts.lane.selectAccount', params: { laneAccountId } }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Additive `accounts` rows on the `status`/snapshot payload (§3 row 2) — a projection of the index. */
export function readLaneAccountsProjection(snapshot: unknown): LaneAccountsProjection {
  const rows = asRecord(snapshot)?.claudeLanes
  if (!Array.isArray(rows)) {
    return NO_LANE_ACCOUNTS
  }
  const self = rows.map(asRecord).find((row) => row?.scope === 'self')
  if (!self) {
    return NO_LANE_ACCOUNTS
  }
  const accountRows = Array.isArray(self.accounts) ? self.accounts : []
  return {
    holdsLane: true,
    accounts: accountRows.map(asRecord).flatMap((row): LaneAccountRow[] => {
      if (!row || typeof row.laneAccountId !== 'string' || typeof row.email !== 'string') {
        return []
      }
      return [
        {
          laneAccountId: row.laneAccountId,
          email: row.email,
          label: typeof row.label === 'string' ? row.label : null,
          active: row.active === true
        }
      ]
    })
  }
}
