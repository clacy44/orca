import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { requireLaneWireService } from '../../lane-wire-service'
import { authorizeHostConsent } from '../../principal-consent-authority'
import {
  LaneLoginCancelParams,
  LaneLoginCancelInlineParams,
  LaneLoginStartInlineParams,
  LaneLoginStartParams,
  LaneLoginStatusParams,
  LaneLoginSubmitCodeInlineParams,
  LaneLoginSubmitCodeParams,
  LaneListAccountsInlineParams,
  LaneLogoutInlineParams,
  LaneRemoveAccountParams,
  LaneSelectAccountInlineParams,
  LaneSelectAccountParams
} from './claude-lane-login-params'

/**
 * The lane wire: the S9-L1 login quartet, selectAccount/removeAccount/logout, status and the
 * status stream (S9 §2b/§2c/§2d/§2l, rev 32's re-basing, S9-L1 §modules D/§rpcs).
 *
 * EVERY method here derives its lane from `ctx.pairedDeviceId → principalId` and from nothing
 * else. There is no lane or principal parameter on any of them, so there is nothing for one grant
 * to name in order to reach another's lane, and an anonymous local caller addresses no lane at
 * all. The login quartet's OWNERSHIP checks (which grant may see/touch which session) live in
 * `LaneLoginAuthority`, not here — this file only delegates.
 *
 * Rev 32 deletes `push`, `pullRotated` and `setDelegableAccounts` with the push model (§10(g));
 * `clear` is renamed `logout` (§3 row 2).
 */

const LaneUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1, 'Missing subscriptionId').max(256) })
  .strict()

export const CLAUDE_CREDENTIAL_LANE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.lane.loginStart',
    params: LaneLoginStartParams,
    handler: async (params, ctx) => {
      const result = await requireLaneWireService().loginAuthority.loginStart(
        ctx.pairedDeviceId,
        params.expectedEmail
      )
      return {
        loginSessionId: result.sessionId,
        authorizeUrl: result.authorizationUrl,
        expiresAt: result.expiresAt
      }
    }
  }),
  defineMethod({
    name: 'accounts.lane.loginSubmitCode',
    params: LaneLoginSubmitCodeParams,
    handler: async (params, ctx) =>
      requireLaneWireService().loginAuthority.loginSubmitCode(
        ctx.pairedDeviceId,
        params.loginSessionId,
        params.code
      )
  }),
  defineMethod({
    name: 'accounts.lane.loginCancel',
    params: LaneLoginCancelParams,
    handler: async (params, ctx) =>
      requireLaneWireService().loginAuthority.loginCancel(ctx.pairedDeviceId, params.loginSessionId)
  }),
  defineMethod({
    name: 'accounts.lane.loginStatus',
    params: LaneLoginStatusParams,
    handler: async (params, ctx) =>
      requireLaneWireService().loginAuthority.loginStatus(ctx.pairedDeviceId, params.loginSessionId)
  }),
  defineMethod({
    name: 'accounts.lane.selectAccount',
    params: LaneSelectAccountParams,
    handler: async (params, ctx) =>
      requireLaneWireService().accountAuthority.selectAccount(
        ctx.pairedDeviceId,
        params.laneAccountId
      )
  }),
  defineMethod({
    name: 'accounts.lane.removeAccount',
    params: LaneRemoveAccountParams,
    handler: async (params, ctx) =>
      requireLaneWireService().accountAuthority.removeAccount(
        ctx.pairedDeviceId,
        params.laneAccountId
      )
  }),
  defineMethod({
    name: 'accounts.lane.logout',
    params: null,
    handler: async (_params, ctx) =>
      requireLaneWireService().accountAuthority.logout(ctx.pairedDeviceId)
  }),
  // §modules E: the host-inline `orca lane login/logout/accounts/use` verbs run the SAME
  // authorities as the paired-grant methods above, through the SAME per-lane session map and
  // write queue — never a copy, never a parallel path. Every one is host-only
  // (`authorizeHostConsent` refuses any identified/paired socket, same door as `accounts.lane.wipe`
  // and the rest of `principal-lanes.ts`) and NONE may join `MOBILE_RPC_METHOD_ALLOWLIST`: each
  // takes a principalId directly rather than deriving one from `ctx.pairedDeviceId`, so a paired
  // caller reaching one would address an arbitrary lane by id.
  defineMethod({
    name: 'accounts.lane.loginStartInline',
    params: LaneLoginStartInlineParams,
    handler: async (params, ctx) => {
      requireHostCaller(ctx)
      const result = await requireLaneWireService().loginAuthority.loginStartInline(
        params.principalId,
        params.expectedEmail
      )
      return {
        loginSessionId: result.sessionId,
        authorizeUrl: result.authorizationUrl,
        expiresAt: result.expiresAt
      }
    }
  }),
  defineMethod({
    name: 'accounts.lane.loginSubmitCodeInline',
    params: LaneLoginSubmitCodeInlineParams,
    handler: async (params, ctx) => {
      requireHostCaller(ctx)
      return requireLaneWireService().loginAuthority.loginSubmitCodeInline(
        params.principalId,
        params.loginSessionId,
        params.code
      )
    }
  }),
  defineMethod({
    name: 'accounts.lane.loginCancelInline',
    params: LaneLoginCancelInlineParams,
    handler: async (params, ctx) => {
      requireHostCaller(ctx)
      return requireLaneWireService().loginAuthority.loginCancelInline(params.principalId)
    }
  }),
  defineMethod({
    name: 'accounts.lane.selectAccountInline',
    params: LaneSelectAccountInlineParams,
    handler: async (params, ctx) => {
      requireHostCaller(ctx)
      return requireLaneWireService().accountAuthority.selectAccountInline(
        params.principalId,
        params.laneAccountId
      )
    }
  }),
  defineMethod({
    name: 'accounts.lane.listAccountsInline',
    params: LaneListAccountsInlineParams,
    handler: async (params, ctx) => {
      requireHostCaller(ctx)
      return {
        accounts: requireLaneWireService().accountAuthority.listAccountsInline(params.principalId)
      }
    }
  }),
  defineMethod({
    name: 'accounts.lane.logoutInline',
    params: LaneLogoutInlineParams,
    handler: async (params, ctx) => {
      requireHostCaller(ctx)
      return requireLaneWireService().accountAuthority.logoutInline(params.principalId)
    }
  }),
  defineMethod({
    name: 'accounts.lane.status',
    params: null,
    handler: async (_params, ctx) => requireLaneWireService().authority.status(ctx.pairedDeviceId)
  }),
  defineStreamingMethod({
    name: 'accounts.lane.statusSubscribe',
    params: null,
    handler: async (_params, ctx, emit) => {
      const service = requireLaneWireService()
      const caller = service.authority.requireCaller(ctx.pairedDeviceId)
      await new Promise<void>((resolve) => {
        const subscriber = service.stream.subscribe(caller, ctx.connectionId ?? null, emit)
        registerLaneSubscriptionCleanup(ctx, subscriber.subscriptionId, () => {
          service.stream.unsubscribe(subscriber.subscriptionId)
          emit({ type: 'end' })
          resolve()
        })
        emit({
          type: 'ready',
          subscriptionId: subscriber.subscriptionId,
          status: service.authority.statusOf(caller)
        })
      })
    }
  }),
  defineMethod({
    name: 'accounts.lane.statusUnsubscribe',
    params: LaneUnsubscribeParams,
    handler: async (params, ctx) => {
      ctx.runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]

/** Host-only door for the six `*Inline` methods — identical shape to `principal-lanes.ts`'s
 * `withConsent`: refuses any identified (paired) socket, never silently. */
function requireHostCaller(ctx: RpcContext): void {
  authorizeHostConsent({ clientKind: ctx.clientKind })
}

function registerLaneSubscriptionCleanup(
  ctx: RpcContext,
  subscriptionId: string,
  cleanup: () => void
): void {
  ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
}
