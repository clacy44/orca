/**
 * Shared types and small pure primitives for the lane login session state machine — split out of
 * `lane-login-session.ts` purely for the 300-line ratchet (S9-L1 A1, §sessionStateMachine).
 *
 * STATES: `live` -> `child-exited` -> `captured`. `cancelled` is terminal and reachable from
 * `live` or `child-exited`, never from `captured`. No transition leaves `cancelled`.
 */
import {
  ClaudeLaneRefusal,
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES
} from '../../shared/claude-lane-refusals'
import type { ClaudeCliChildProcessHandle } from './claude-cli-child-process'
import type { LaneLoginCaptureResult } from './lane-login-capture'

/** Re-declared beside `MAX_LOGIN_CODE_ATTEMPTS` rather than imported from the ratcheted
 * `service.ts` (AGENTS.md: ratcheted files take delegating calls only) — same value, `:52`. */
export const LOGIN_TIMEOUT_MS = 180_000

/** Bounded so a co-tenant cannot pin a lane in "logging in" indefinitely on wrong-code retries. */
export const MAX_LOGIN_CODE_ATTEMPTS = 5

export type LaneLoginSessionOwner = { kind: 'grant'; deviceId: string } | { kind: 'host-inline' }

export type LaneLoginSessionState = 'live' | 'child-exited' | 'captured' | 'cancelled'

export type LaneLoginSessionStatus = {
  sessionId: string
  laneId: string
  owner: LaneLoginSessionOwner
  state: LaneLoginSessionState
  expiresAt: number
  attempts: number
  identity: { email: string } | null
}

export type LaneLoginSubmitCodeResult = {
  status: 'completed' | 'rejected'
  identity: { email: string } | null
  attemptsRemaining: number
}

/** The registry's own mutable record — internal; callers see only `LaneLoginSessionStatus`. */
export type Session = {
  sessionId: string
  laneId: string
  laneDir: string
  laneAccountId: string
  authDir: string
  expectedEmail: string
  owner: LaneLoginSessionOwner
  state: LaneLoginSessionState
  expiresAt: number
  attempts: number
  identity: { email: string } | null
  handle: ClaudeCliChildProcessHandle | null
  exited: boolean
  exitPromise: Promise<void>
  pasteReady: boolean
  pasteReadyWaiters: (() => void)[]
  promptWasShowing: boolean
  promptEdgeCount: number
  promptEdgeWaiters: (() => void)[]
  swept: boolean
  ttlTimer: ReturnType<typeof setTimeout> | null
  /** Set by the TTL arm before it reaps, so a `start()` still awaiting the URL surfaces
   * `login_session_expired` instead of the raw error the killed child settles with. */
  ttlExpired: boolean
  captureOncePromise: Promise<LaneLoginCaptureResult> | null
  /** True from the stdin write until `submitCode`'s exit/reprompt race settles — the signal
   * `onChildSettled` uses to tell §sessionStateMachine's `child-exited` sub-case (b) ("exit INTO
   * a successful capture", stay cancellable, no reap) from sub-case (a) ("exit BEFORE a capture",
   * reap now). `onChildSettled` always runs before the racing `submitCode` call observes the
   * exit (its exit promise resolves the settled handler before anyone downstream sees it), so
   * this flag — not the (always-still-null) `captureOncePromise` — is the only signal available
   * at reap time. */
  pendingSubmit: boolean
}

export function flush(waiters: (() => void)[]): void {
  const toFlush = waiters.splice(0)
  for (const waiter of toFlush) {
    waiter()
  }
}

export function refusal(
  code: Exclude<keyof typeof CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES, 'accounts.lane.login_cancelled'>
): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(code, CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES[code])
}

export function wipeInProgressRefusal(action: string): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.wipe_in_progress',
    `Orca is clearing this credential lane on the host right now, so it did not ${action}. Wait for that to finish, then try again.`
  )
}

/** Resolves once the paste-code prompt has fired, or immediately if it already has. */
export function awaitPasteReady(session: Session): Promise<void> {
  if (session.pasteReady) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    session.pasteReadyWaiters.push(resolve)
  })
}

/** Resolves once a NEW prompt edge fires past `baseline` — a fresh reprompt, not the one already
 * counted when the caller started waiting. */
export function awaitPromptEdgeAfter(session: Session, baseline: number): Promise<void> {
  if (session.promptEdgeCount > baseline) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    session.promptEdgeWaiters.push(resolve)
  })
}
