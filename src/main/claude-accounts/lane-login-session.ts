/**
 * Per-lane Claude login sessions (S9-L1 A1, §sessionStateMachine, §fenceWiring). The in-memory
 * session map + state machine `start`/`submitCode`/`cancelStateTransition`/`cancelDestructive`/
 * `statusOf`, and the two entry points into it — a bound grant, or the host-inline CLI — share
 * ONE map, which is what makes "two entry points, one session" a property this module can hold.
 *
 * PROCESS-LOCALITY: the map is never persisted (§sessionStateMachine). A restart drops every
 * session record; a later submit against a dropped id is `login_session_unknown`, never a hang
 * or a raw stdin error against a pipe nothing owns any more.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnLaneLoginChild } from './lane-login-session-child'
import {
  cancelDestructive as cancelDestructiveOp,
  cancelLaneLoginSessions as cancelLaneLoginSessionsOp,
  cancelStateTransition as cancelStateTransitionOp,
  sweepCancelledLoginDirs as sweepCancelledLoginDirsOp
} from './lane-login-session-cancel'
import {
  LOGIN_TIMEOUT_MS,
  MAX_LOGIN_CODE_ATTEMPTS,
  flush,
  refusal,
  wipeInProgressRefusal,
  type LaneLoginSessionOwner,
  type LaneLoginSessionStatus,
  type LaneLoginSubmitCodeResult,
  type Session
} from './lane-login-session-types'
import { assertLoginCliVersionSupported } from './lane-login-cli-version-gate'
import { assertLaneAccountStoreHasRoom } from './principal-lane-account-store'
import { getLaneAccountsRoot } from './lane-account-index'
import { resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'
import { isLaneWipePending } from './lane-wipe-pending'
import type { LaneAuthState } from './lane-auth-state'
import { LaneCredentialWriter } from './lane-credential-writer'
import { captureLaneLogin, type LaneLoginCaptureResult } from './lane-login-capture'

export {
  LOGIN_TIMEOUT_MS,
  MAX_LOGIN_CODE_ATTEMPTS,
  type LaneLoginSessionOwner,
  type LaneLoginSessionState,
  type LaneLoginSessionStatus,
  type LaneLoginSubmitCodeResult
} from './lane-login-session-types'

export type LaneLoginSessionRegistryOptions = {
  authState: Pick<LaneAuthState, 'serializeLaneWrite'>
  writer?: Pick<LaneCredentialWriter, 'writeCredentials' | 'writeOauthAccount'>
  now?: () => number
  mintId?: () => string
}

export class LaneLoginSessionRegistry {
  private readonly sessions = new Map<string, Session>()
  private readonly authState: Pick<LaneAuthState, 'serializeLaneWrite'>
  private readonly writer: Pick<LaneCredentialWriter, 'writeCredentials' | 'writeOauthAccount'>
  private readonly now: () => number
  private readonly mintId: () => string

  constructor(options: LaneLoginSessionRegistryOptions) {
    this.authState = options.authState
    this.writer = options.writer ?? new LaneCredentialWriter()
    this.now = options.now ?? Date.now
    this.mintId = options.mintId ?? randomUUID
  }

  /**
   * `start`'s order is fixed and non-negotiable (§modules A1):
   *  (1) SYNCHRONOUS, no `await` between any of these — obligation (4″)'s induction step, so a
   *      `cancel` racing this call always sees the session before anything else can happen to it.
   *  (2) only THEN does anything `await`: the auth dir, the marker, the spawn, the URL read.
   */
  async start(params: {
    laneId: string
    laneDir: string
    expectedEmail: string
    owner: LaneLoginSessionOwner
  }): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: number }> {
    const { laneId, laneDir, expectedEmail, owner } = params

    // (1) — no `await` between here and `this.sessions.set` below.
    assertLoginCliVersionSupported()
    if (isLaneWipePending(laneId)) {
      throw wipeInProgressRefusal('start a login')
    }
    assertLaneAccountStoreHasRoom(laneDir)
    if (this.hasInFlightSession(laneId)) {
      throw refusal('accounts.lane.login_already_in_flight')
    }
    const sessionId = this.mintId()
    const laneAccountId = this.mintId()
    const laneAccountsRoot = getLaneAccountsRoot(laneDir)
    const authDir = join(laneAccountsRoot, laneAccountId, 'auth')
    const createdAt = this.now()
    const session: Session = {
      sessionId,
      laneId,
      laneDir,
      laneAccountId,
      authDir,
      expectedEmail,
      owner,
      state: 'live',
      expiresAt: createdAt + LOGIN_TIMEOUT_MS,
      attempts: 0,
      identity: null,
      handle: null,
      exited: false,
      exitPromise: Promise.resolve(),
      pasteReady: false,
      pasteReadyWaiters: [],
      promptWasShowing: false,
      promptEdgeCount: 0,
      promptEdgeWaiters: [],
      swept: false,
      ttlTimer: null,
      captureOncePromise: null
    }
    this.sessions.set(sessionId, session)
    session.ttlTimer = setTimeout(() => this.onTtlExpired(sessionId), LOGIN_TIMEOUT_MS)
    session.ttlTimer.unref?.()

    // (2) — everything past this point may `await`.
    try {
      mkdirSync(authDir, { recursive: true })
      // Marker written BEFORE the spawn (§storeLayout ordering (1)) via the shared
      // `managed-auth-path.ts` machinery, `adoptLegacyMarker` writing it in place of a bespoke
      // copy of the same write.
      const trustedAuthDir = resolveOwnedClaudeManagedAuthPath(laneAccountId, authDir, {
        root: laneAccountsRoot,
        adoptLegacyMarker: true
      })
      if (!trustedAuthDir) {
        throw new Error('Orca could not prove ownership of the login directory it just created.')
      }
      // Canonical, not the raw path just mkdir'd — the same path every later reader (A4, the
      // account store) resolves this directory to.
      session.authDir = trustedAuthDir
      const authorizationUrl = await this.spawnAndAwaitUrl(session)
      return { sessionId, authorizationUrl, expiresAt: session.expiresAt }
    } catch (error) {
      this.cancelStateTransition(sessionId)
      await this.cancelDestructive(sessionId)
      throw error
    }
  }

  /**
   * Writes to THIS session's child stdin only, and only after `isPasteCodePrompt` has fired —
   * buffered until then. Bounded by `MAX_LOGIN_CODE_ATTEMPTS`; a submit past the TTL is
   * `login_session_expired` with destructive cleanup, never a write into a dead pipe.
   */
  async submitCode(sessionId: string, code: string): Promise<LaneLoginSubmitCodeResult> {
    const session = this.sessions.get(sessionId)
    // Checked BEFORE a byte reaches any stdin: unknown id, a cancelled session, or a session an
    // exit already reaped. `submitCode` is the ONLY path a code reaches a login child by, so a
    // child that has already exited by the time a NEW call starts is always the crash/TTL/cancel
    // case — the in-flight call racing that same exit is a different call, already past this
    // guard when the exit happened.
    if (!session || session.state === 'cancelled' || session.exited) {
      throw refusal('accounts.lane.login_session_unknown')
    }
    if (this.now() >= session.expiresAt) {
      this.cancelStateTransition(sessionId)
      await this.cancelDestructive(sessionId)
      throw refusal('accounts.lane.login_session_expired')
    }
    if (session.attempts >= MAX_LOGIN_CODE_ATTEMPTS) {
      this.cancelStateTransition(sessionId)
      await this.cancelDestructive(sessionId)
      throw refusal('accounts.lane.login_code_rejected')
    }

    await this.awaitPasteReady(session)
    // Re-read via a fresh lookup: TS narrows `session.state`/`exited` from the guard above and
    // does not know an `await` let them mutate, so re-fetch rather than trust the stale narrowed
    // snapshot. `exited` catches a child that crashed WHILE this call was buffering, before ever
    // printing the prompt — `awaitPasteReady` only resolves that case via the exit flush below,
    // never a genuine paste-ready edge, so writing to its stdin here would be the raw EPIPE the
    // exit-reaped check exists to prevent.
    const afterPasteReady = this.sessions.get(sessionId)
    if (!afterPasteReady || afterPasteReady.state === 'cancelled' || afterPasteReady.exited) {
      throw refusal('accounts.lane.login_session_unknown')
    }

    session.attempts += 1
    const edgeBaseline = session.promptEdgeCount
    const repromptWaited = this.awaitPromptEdgeAfter(session, edgeBaseline)
    session.handle?.writeStdin(`${code}\n`)

    const settled = await Promise.race([
      session.exitPromise.then(() => 'exited' as const),
      repromptWaited.then(() => 'reprompt' as const)
    ])

    if (settled === 'reprompt' && !session.exited) {
      const attemptsRemaining = MAX_LOGIN_CODE_ATTEMPTS - session.attempts
      if (attemptsRemaining <= 0) {
        this.cancelStateTransition(sessionId)
        await this.cancelDestructive(sessionId)
        throw refusal('accounts.lane.login_code_rejected')
      }
      return { status: 'rejected', identity: null, attemptsRemaining }
    }

    const outcome = await this.ensureCaptureStarted(sessionId)
    if (outcome.kind === 'identity_mismatch') {
      throw refusal('accounts.lane.login_identity_mismatch')
    }
    return {
      status: 'completed',
      identity: { email: outcome.email },
      attemptsRemaining: MAX_LOGIN_CODE_ATTEMPTS - session.attempts
    }
  }

  /** Pure, synchronous: the state-transition half of cancel (§sessionStateMachine). */
  cancelStateTransition(sessionId: string): void {
    cancelStateTransitionOp(this.sessions, sessionId)
  }

  /** The destructive half: sweeps the session's half-written `<laneAccountId>` directory. */
  cancelDestructive(sessionId: string): Promise<void> {
    return cancelDestructiveOp(this.sessions, sessionId)
  }

  /** Every in-flight session of `laneId` -> `cancelled`, synchronously (§fenceWiring). */
  cancelLaneLoginSessions(laneId: string): void {
    cancelLaneLoginSessionsOp(this.sessions, laneId)
  }

  /** The destructive half for every session `cancelLaneLoginSessions` just marked — run INSIDE
   * the wipe's own `serializeLaneWrite` turn, never concurrently with an admitted capture. */
  sweepCancelledLoginDirs(laneId: string): Promise<void> {
    return sweepCancelledLoginDirsOp(this.sessions, laneId)
  }

  /** Explicit `loginCancel` — one of the five cancellers, all one code path. */
  async cancel(sessionId: string): Promise<void> {
    this.cancelStateTransition(sessionId)
    await this.cancelDestructive(sessionId)
  }

  statusOf(sessionId: string): LaneLoginSessionStatus | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }
    return {
      sessionId: session.sessionId,
      laneId: session.laneId,
      owner: session.owner,
      state: session.state,
      expiresAt: session.expiresAt,
      attempts: session.attempts,
      identity: session.identity
    }
  }

  private hasInFlightSession(laneId: string): boolean {
    for (const session of this.sessions.values()) {
      if (
        session.laneId === laneId &&
        (session.state === 'live' || session.state === 'child-exited')
      ) {
        return true
      }
    }
    return false
  }

  private spawnAndAwaitUrl(session: Session): Promise<string> {
    const { handle, result, urlPromise } = spawnLaneLoginChild(session, LOGIN_TIMEOUT_MS)
    session.handle = handle
    session.exitPromise = result.then(
      ({ code }) => this.onChildSettled(session.sessionId, code),
      () => this.onChildSettled(session.sessionId, null)
    )
    return urlPromise
  }

  private onChildSettled(sessionId: string, _code: number | null): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.exited) {
      return
    }
    session.exited = true
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer)
      session.ttlTimer = null
    }
    // A crash before the prompt ever printed must not leave a buffered `submitCode` waiting
    // forever — it wakes here and refuses `login_session_unknown` on the `exited` re-check.
    flush(session.pasteReadyWaiters)
    if (session.state === 'live') {
      // §sessionStateMachine `child-exited`: neither reaped nor `captured` here — the tail
      // (I6, then the queue turn) still owns whether this session ever reaches `captured`.
      session.state = 'child-exited'
    }
  }

  private ensureCaptureStarted(sessionId: string): Promise<LaneLoginCaptureResult> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return Promise.resolve({ kind: 'identity_mismatch' })
    }
    if (!session.captureOncePromise) {
      session.captureOncePromise = captureLaneLogin({
        laneId: session.laneId,
        laneDir: session.laneDir,
        laneAccountId: session.laneAccountId,
        authDir: session.authDir,
        expectedEmail: session.expectedEmail,
        authState: this.authState,
        writer: this.writer,
        isStillCapturable: () => {
          const current = this.sessions.get(sessionId)
          return !!current && (current.state === 'live' || current.state === 'child-exited')
        },
        onCaptured: () => {
          const current = this.sessions.get(sessionId)
          if (current) {
            current.state = 'captured'
          }
        }
      }).then((outcome) => {
        const current = this.sessions.get(sessionId)
        if (current && outcome.kind === 'captured') {
          current.identity = { email: outcome.email }
        }
        return outcome
      })
    }
    return session.captureOncePromise
  }

  private onTtlExpired(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.state === 'captured' || session.state === 'cancelled') {
      return
    }
    this.cancelStateTransition(sessionId)
    void this.cancelDestructive(sessionId)
  }

  private awaitPasteReady(session: Session): Promise<void> {
    if (session.pasteReady) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      session.pasteReadyWaiters.push(resolve)
    })
  }

  private awaitPromptEdgeAfter(session: Session, baseline: number): Promise<void> {
    if (session.promptEdgeCount > baseline) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      session.promptEdgeWaiters.push(resolve)
    })
  }
}
