/**
 * The five-cancellers-one-code-path machinery (S9-L1 A1, §sessionStateMachine "CANCEL, SPLIT").
 * Free functions over the registry's own session map — not methods — so
 * `principal-lane-lifecycle.ts` can be handed `cancelLaneLoginSessions` as a plain synchronous
 * function (§fenceWiring) without exposing the whole registry to it.
 */
import { rmSync } from 'node:fs'
import { getLaneAccountsRoot } from './lane-account-index'
import { resolveContainedLaneAccountEntry } from './principal-lane-account-store'
import { flush, type Session } from './lane-login-session-types'

/** Pure, synchronous: the state-transition half. Never leaves `cancelled`, never fires from
 * `captured`. Kills the process group; does NOT touch the filesystem. */
export function cancelStateTransition(sessions: Map<string, Session>, sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.state === 'captured' || session.state === 'cancelled') {
    return
  }
  session.state = 'cancelled'
  if (session.ttlTimer) {
    clearTimeout(session.ttlTimer)
    session.ttlTimer = null
  }
  session.handle?.kill(new Error('This Claude login was cancelled.'))
  flush(session.pasteReadyWaiters)
  flush(session.promptEdgeWaiters)
}

/** The destructive half: sweeps the session's half-written `<laneAccountId>` directory.
 * Idempotent, and a no-op once `captured` has already promoted the credential elsewhere. */
export async function cancelDestructive(
  sessions: Map<string, Session>,
  sessionId: string
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session || session.swept || session.state === 'captured') {
    return
  }
  session.swept = true
  const contained = resolveContainedLaneAccountEntry(
    getLaneAccountsRoot(session.laneDir),
    session.laneAccountId
  )
  if (contained) {
    rmSync(contained, { recursive: true, force: true })
  }
}

/** Every in-flight session of `laneId` -> `cancelled`, synchronously — no promise returned
 * (§fenceWiring: taken in the SAME synchronous step as `markLaneWipePending`). */
export function cancelLaneLoginSessions(sessions: Map<string, Session>, laneId: string): void {
  for (const session of sessions.values()) {
    if (session.laneId === laneId) {
      cancelStateTransition(sessions, session.sessionId)
    }
  }
}

/** The destructive half for every session `cancelLaneLoginSessions` just marked — run INSIDE the
 * wipe's own `serializeLaneWrite` turn, never concurrently with an admitted capture. */
export async function sweepCancelledLoginDirs(
  sessions: Map<string, Session>,
  laneId: string
): Promise<void> {
  const toSweep = [...sessions.values()].filter(
    (session) => session.laneId === laneId && session.state === 'cancelled' && !session.swept
  )
  for (const session of toSweep) {
    await cancelDestructive(sessions, session.sessionId)
  }
}
