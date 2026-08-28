import {
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES,
  ClaudeLaneRefusal,
  isClaudeLaneRefusal
} from '../../shared/claude-lane-refusals'
import type { Session } from './lane-login-session-types'

/**
 * What a `start()` that failed while awaiting the URL should throw. A child reaped underneath
 * it settles with a raw kill/exit error; the caller gets the named refusal for what actually
 * happened — the TTL, or a logout/revoke/designation move — never that error. Read the session
 * BEFORE the caller's own `cancel()`, which is what would otherwise erase the distinction.
 */
export function refusalForAbortedStart(session: Session | undefined, error: unknown): unknown {
  if (session?.ttlExpired) {
    return new ClaudeLaneRefusal(
      'accounts.lane.login_session_expired',
      CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.login_session_expired']
    )
  }
  if (session?.state === 'cancelled' && !isClaudeLaneRefusal(error)) {
    return new ClaudeLaneRefusal(
      'accounts.lane.login_cancelled',
      CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.login_cancelled']
    )
  }
  return error
}
