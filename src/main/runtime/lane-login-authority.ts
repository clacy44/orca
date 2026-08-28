import {
  ClaudeLaneRefusal,
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES,
  isClaudeLaneRefusal
} from '../../shared/claude-lane-refusals'
import type { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import type {
  LaneLoginSessionStatus,
  LaneLoginSubmitCodeResult
} from '../claude-accounts/lane-login-session'
import type { LaneStatusFrame } from './lane-status-stream'
import type { LaneWireCaller, LaneWirePrincipals } from './lane-wire-authority'

/**
 * The host side of the S9-L1 login quartet (§modules D, §3 row 1/2).
 *
 * Bindings, all enforced HERE and nowhere else:
 *  (i-a) the lane has a designation at all — `no_login_device_designated` otherwise.
 *  (i-b) THIS caller is the designated grant — `login_not_designated` otherwise. A host-inline
 *        caller (the CLI's `orca lane login`, S9-L2) is exempt from (i-a)/(i-b): it takes
 *        `{ kind: 'host-inline' }` and is checked by `loginStartInline` below instead.
 *  (ii)  the URL rides ONLY the `loginStart` reply on the requesting connection — the status frame
 *        every OTHER grant of the principal sees (`login-started`) carries no URL field, by the
 *        wire type's own construction, not by a redaction step here that could be skipped.
 *  (iii) submit/cancel/status only from the SAME grant that started a GRANT-owned session — never
 *        the designated grant in general, and never any grant at all for a host-inline session.
 *  (iv)  every property `loginStatus` returns belongs to that one session's own state.
 *
 * A caller who fails (iii) gets `login_session_unknown` — the identical refusal an unknown id
 * gets — never a distinguishing "forbidden": telling grant B that grant A's session EXISTS is
 * already a leak (§5 "grant B cannot see A's URL / submit A's code").
 */
export type LaneLoginAuthorityOptions = {
  principals: LaneWirePrincipals
  coordinator: LaneCredentialCoordinator
  publish: (laneId: string, frame: LaneStatusFrame) => void
}

export class LaneLoginAuthority {
  constructor(private readonly options: LaneLoginAuthorityOptions) {}

  async loginStart(
    pairedDeviceId: string | null | undefined,
    expectedEmail: string
  ): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: number }> {
    const caller = this.requireCaller(pairedDeviceId)
    this.requireDesignatedCaller(caller)
    const laneDir = this.requireProvisionedLaneDir(caller.principalId)
    const started = await this.start(caller.principalId, laneDir, expectedEmail, {
      kind: 'grant',
      deviceId: caller.deviceId
    })
    return started
  }

  /** E's host-inline exemption (§6 SLICE RECONCILIATION): exempt from (i-a)/(i-b)/(ii) only. */
  async loginStartInline(
    principalId: string,
    expectedEmail: string
  ): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: number }> {
    const laneDir = this.requireProvisionedLaneDir(principalId)
    return this.start(principalId, laneDir, expectedEmail, { kind: 'host-inline' })
  }

  /** Host-inline `submitCode` — the CLI's own invocation, never a grant. Same
   * (iii)/(iv)-shaped ownership check as `loginSubmitCode`, on the `host-inline` owner kind. */
  async loginSubmitCodeInline(
    principalId: string,
    sessionId: string,
    code: string
  ): Promise<LaneLoginSubmitCodeResult> {
    const status = this.requireOwnedInlineSession(principalId, sessionId)
    try {
      const result = await this.options.coordinator.loginSessions.submitCode(sessionId, code)
      if (result.status === 'completed' && result.identity) {
        this.options.publish(status.laneId, {
          type: 'login-completed',
          loginSessionId: sessionId,
          identity: result.identity
        })
      }
      return result
    } catch (error) {
      this.publishFailureIfRefusal(status.laneId, sessionId, error)
      throw error
    }
  }

  /**
   * Host-inline `--cancel`: a fresh CLI invocation holds no sessionId of its own, so this looks
   * up the lane's in-flight host-inline session rather than taking one as a param — symmetric
   * with the ownership shape everywhere else here: only the entry point that started a session
   * may end it, so a grant-started session is `login_session_unknown` to this path too.
   */
  async loginCancelInline(principalId: string): Promise<{ cancelled: true }> {
    const status = this.options.coordinator.loginSessions.statusOfLane(principalId)
    if (!status || status.owner.kind !== 'host-inline') {
      throw refusal('accounts.lane.login_session_unknown')
    }
    await this.options.coordinator.loginSessions.cancel(status.sessionId)
    this.options.publish(principalId, {
      type: 'login-failed',
      loginSessionId: status.sessionId,
      code: 'accounts.lane.login_cancelled',
      message: CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.login_cancelled']
    })
    return { cancelled: true }
  }

  async loginSubmitCode(
    pairedDeviceId: string | null | undefined,
    sessionId: string,
    code: string
  ): Promise<LaneLoginSubmitCodeResult> {
    const caller = this.requireCaller(pairedDeviceId)
    const status = this.requireOwnedGrantSession(caller, sessionId)
    try {
      const result = await this.options.coordinator.loginSessions.submitCode(sessionId, code)
      if (result.status === 'completed' && result.identity) {
        this.options.publish(status.laneId, {
          type: 'login-completed',
          loginSessionId: sessionId,
          identity: result.identity
        })
      }
      return result
    } catch (error) {
      this.publishFailureIfRefusal(status.laneId, sessionId, error)
      throw error
    }
  }

  async loginCancel(
    pairedDeviceId: string | null | undefined,
    sessionId: string
  ): Promise<{ cancelled: true }> {
    const caller = this.requireCaller(pairedDeviceId)
    const status = this.requireOwnedGrantSession(caller, sessionId)
    await this.options.coordinator.loginSessions.cancel(sessionId)
    this.options.publish(status.laneId, {
      type: 'login-failed',
      loginSessionId: sessionId,
      code: 'accounts.lane.login_cancelled',
      message: CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.login_cancelled']
    })
    return { cancelled: true }
  }

  loginStatus(
    pairedDeviceId: string | null | undefined,
    sessionId: string
  ): LaneLoginSessionStatus {
    const caller = this.requireCaller(pairedDeviceId)
    return this.requireOwnedGrantSession(caller, sessionId)
  }

  private async start(
    laneId: string,
    laneDir: string,
    expectedEmail: string,
    owner: { kind: 'grant'; deviceId: string } | { kind: 'host-inline' }
  ): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: number }> {
    const started = await this.options.coordinator.loginSessions.start({
      laneId,
      laneDir,
      expectedEmail,
      owner
    })
    // (ii): this frame is the ONLY thing every other grant of the principal sees — no URL field.
    this.options.publish(laneId, {
      type: 'login-started',
      loginSessionId: started.sessionId,
      expiresAt: started.expiresAt
    })
    return {
      sessionId: started.sessionId,
      authorizationUrl: started.authorizationUrl,
      expiresAt: started.expiresAt
    }
  }

  private requireCaller(pairedDeviceId: string | null | undefined): LaneWireCaller {
    if (!pairedDeviceId) {
      throw unidentifiedCaller()
    }
    const principalId = this.options.principals.principalOf(pairedDeviceId)
    if (!principalId) {
      throw unidentifiedCaller()
    }
    return { deviceId: pairedDeviceId, principalId }
  }

  private requireDesignatedCaller(caller: LaneWireCaller): void {
    const designated = this.options.principals.delegatedGrantIdOf(caller.principalId)
    if (!designated) {
      throw refusal('accounts.lane.no_login_device_designated')
    }
    if (designated !== caller.deviceId) {
      throw refusal('accounts.lane.login_not_designated')
    }
  }

  private requireProvisionedLaneDir(principalId: string): string {
    const laneDir = this.options.coordinator.store.resolveLaneDir(principalId)
    if (!laneDir) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.not_provisioned',
        'This person has no Claude credential lane on this host, so there is nowhere to load their account. Create the lane in Orca on the host machine first.'
      )
    }
    return laneDir
  }

  /** (iii)/(iv): unknown id, another lane's session, a host-inline session, or another grant's
   * session all collapse to the SAME refusal — never distinguishing "forbidden" from "unknown". */
  private requireOwnedGrantSession(
    caller: LaneWireCaller,
    sessionId: string
  ): LaneLoginSessionStatus {
    const status = this.options.coordinator.loginSessions.statusOf(sessionId)
    if (
      !status ||
      status.laneId !== caller.principalId ||
      status.owner.kind !== 'grant' ||
      status.owner.deviceId !== caller.deviceId
    ) {
      throw refusal('accounts.lane.login_session_unknown')
    }
    return status
  }

  /** The inline mirror of `requireOwnedGrantSession`: unknown id, another lane's session, or a
   * grant-owned session all collapse to the same refusal — never distinguishing "forbidden". */
  private requireOwnedInlineSession(
    principalId: string,
    sessionId: string
  ): LaneLoginSessionStatus {
    const status = this.options.coordinator.loginSessions.statusOf(sessionId)
    if (!status || status.laneId !== principalId || status.owner.kind !== 'host-inline') {
      throw refusal('accounts.lane.login_session_unknown')
    }
    return status
  }

  private publishFailureIfRefusal(laneId: string, sessionId: string, error: unknown): void {
    if (!isClaudeLaneRefusal(error)) {
      return
    }
    this.options.publish(laneId, {
      type: 'login-failed',
      loginSessionId: sessionId,
      code: error.code,
      message: error.message
    })
  }
}

function refusal(
  code: Exclude<keyof typeof CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES, 'accounts.lane.login_cancelled'>
): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(code, CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES[code])
}

function unidentifiedCaller(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.caller_unidentified',
    'Orca could not tell which person this request came from, so it addressed no Claude credential lane. Run this from a device that is paired with this host and linked to a person.'
  )
}
