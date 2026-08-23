import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { parseDelegableAccountInputs } from '../../lane-delegation-directory'
import { requireLaneWireService } from '../../lane-wire-service'

/**
 * The lane wire: push, pull, clear, status and the status stream (S9 §2b/§2c/§2d/§2l).
 *
 * EVERY method here derives its lane from `ctx.pairedDeviceId → principalId` and from nothing
 * else. There is no lane or principal parameter on any of them — `push`'s own schema is `strict`
 * and refuses an extra member outright — so there is nothing for one grant to name in order to
 * reach another's lane, and an anonymous local caller addresses no lane at all.
 *
 * Nothing here logs a payload: the two members `push` carries ARE the credential.
 */

const PullRotatedParams = z
  .object({
    knownRefreshTokenSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Invalid credential digest')
      .nullable()
      .default(null)
  })
  .strict()

const SetDelegableAccountsParams = z.object({ accounts: z.unknown() }).strict()

const LaneUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1, 'Missing subscriptionId').max(256) })
  .strict()

export const CLAUDE_CREDENTIAL_LANE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    // Why `unknown` rather than a zod schema on the wire boundary: every malformed shape must
    // reach the caller as `accounts.lane.push_malformed` with its complete sentence, not as a
    // generic invalid-params error the client has no string for (§3's Rule-3 row).
    name: 'accounts.lane.push',
    params: z.unknown(),
    handler: async (params, ctx) =>
      requireLaneWireService().authority.push(ctx.pairedDeviceId, params)
  }),
  defineMethod({
    name: 'accounts.lane.pullRotated',
    params: PullRotatedParams,
    handler: async (params, ctx) =>
      requireLaneWireService().authority.pullRotated(
        ctx.pairedDeviceId,
        params.knownRefreshTokenSha256
      )
  }),
  defineMethod({
    name: 'accounts.lane.clear',
    params: null,
    handler: async (_params, ctx) => requireLaneWireService().authority.clear(ctx.pairedDeviceId)
  }),
  defineMethod({
    name: 'accounts.lane.status',
    params: null,
    handler: async (_params, ctx) => requireLaneWireService().authority.status(ctx.pairedDeviceId)
  }),
  defineMethod({
    // §8 item 2's writer: the desktop→host delegable-list write §2l step 1 needs and rev 21 never
    // gave it. Authorized exactly as a push is — the designated grant only — and bounded here.
    name: 'accounts.lane.setDelegableAccounts',
    params: SetDelegableAccountsParams,
    handler: async (params, ctx) => {
      const service = requireLaneWireService()
      const caller = service.authority.requireCaller(ctx.pairedDeviceId)
      service.authority.assertDelegatedPusher(caller)
      const entries = parseDelegableAccountInputs(params.accounts)
      const delegable = service.delegation.setDelegableAccounts(caller.principalId, entries)
      return { delegable }
    }
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

function registerLaneSubscriptionCleanup(
  ctx: RpcContext,
  subscriptionId: string,
  cleanup: () => void
): void {
  ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
}
