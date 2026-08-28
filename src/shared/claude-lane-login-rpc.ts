// S9-L2 (design rev 38 §2l/§3): the shared RPC shapes for the per-lane login quartet plus the
// in-lane switch/remove/logout verbs. These are the EXACT shapes L1's server plan defines — every
// schema is `.strict()` there and none carries a lane or principal field, because the lane is
// `principalOf(ctx.pairedDeviceId)` and nothing else. This file is types only (no server-side zod
// schema lives here, since L1's server is not yet merged into this tree); the desktop/mobile
// clients built against it are exercised with a mocked transport until L1 lands.
import type { ClaudeLaneRefusalCode } from './claude-lane-refusals'

export type LaneLoginIdentity = {
  email: string
  uuid?: string
  organization?: string
}

// 1) accounts.lane.loginStart
export type LaneLoginStartParams = {
  /** Trimmed, non-empty, <=254 chars, email-shaped. Required (§3 row 1): an optional expectation
   *  would make I6 skippable at the caller's choice. */
  expectedEmail: string
}
export type LaneLoginStartResult = {
  loginSessionId: string
  /** The URL the CLI printed, OSC-8 stripped, delivered only on this reply on this connection. */
  authorizeUrl: string
  expiresAt: number
}

// 2) accounts.lane.loginSubmitCode
export type LaneLoginSubmitCodeParams = {
  loginSessionId: string
  code: string
}
export type LaneLoginSubmitCodeResult = {
  status: 'completed' | 'rejected'
  identity: LaneLoginIdentity | null
  attemptsRemaining: number
}

// 3) accounts.lane.loginCancel
export type LaneLoginCancelParams = { loginSessionId: string }
export type LaneLoginCancelResult = { cancelled: true }

// 4) accounts.lane.loginStatus — never re-serves authorizeUrl.
export type LaneLoginStatusParams = { loginSessionId: string }
export type LaneLoginState = 'live' | 'child-exited' | 'captured' | 'cancelled'
export type LaneLoginStatusResult = {
  state: LaneLoginState
  expiresAt: number
  attempts: number
  identity: LaneLoginIdentity | null
}

// 5) accounts.lane.selectAccount — synchronous, never 'pending'.
export type LaneSelectAccountParams = { laneAccountId: string }
export type LaneSelectAccountResult = { active: string }

// 6) accounts.lane.removeAccount
export type LaneRemoveAccountParams = { laneAccountId: string }
export type LaneRemoveAccountResult = { removed: string }

// 7) accounts.lane.logout
export type LaneLogoutResult = { cleared: string[] }

/** The lane-local id shape the host mints at login (`device-registry.ts:95`'s v4-UUID regex). */
export const LANE_ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type LaneAccountRow = {
  laneAccountId: string
  email: string
  label: string | null
  active: boolean
}

/** The lane-login client/service's own capability-probe state (shared so `lane-login-ipc.ts`,
 *  which the web typecheck project reaches, never has to import from `src/main`). */
export type LaneLoginCapabilityState = 'unknown' | 'checking' | 'supported' | 'unsupported'

/**
 * New `LaneStatusFrame` union members (§3 row 2): `login-started` never carries the URL — that
 * rides only the starting grant's `loginStart` reply — it exists so a principal's other bound
 * grants can render "a login is in progress" and correlate the completion frame.
 */
export type LaneLoginStatusFrame =
  | { type: 'login-started'; loginSessionId: string; expiresAt: number }
  | { type: 'login-completed'; loginSessionId: string; identity: LaneLoginIdentity }
  | { type: 'login-failed'; loginSessionId: string; code: ClaudeLaneRefusalCode; message: string }

/** A typed refusal as it crosses the wire: a code plus the host's own complete sentence. */
export type LaneLoginRpcError = {
  code: ClaudeLaneRefusalCode | (string & {})
  message: string
}

export function isLaneLoginRpcError(value: unknown): value is LaneLoginRpcError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}
