import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { requireLaneWireService } from '../../lane-wire-service'

/**
 * The lane wire: logout, status and the status stream (S9 §2b/§2c/§2d/§2l, rev 32's re-basing).
 *
 * EVERY method here derives its lane from `ctx.pairedDeviceId → principalId` and from nothing
 * else. There is no lane or principal parameter on any of them, so there is nothing for one grant
 * to name in order to reach another's lane, and an anonymous local caller addresses no lane at
 * all.
 *
 * Rev 32 deletes `push`, `pullRotated` and `setDelegableAccounts` with the push model (§10(g));
 * `clear` is renamed `logout` (§3 row 2). S9-L1's login quartet and `selectAccount`/`removeAccount`
 * are not yet wired into this tree's host RPC surface.
 */

const LaneUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1, 'Missing subscriptionId').max(256) })
  .strict()

export const CLAUDE_CREDENTIAL_LANE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.lane.logout',
    params: null,
    handler: async (_params, ctx) => requireLaneWireService().authority.logout(ctx.pairedDeviceId)
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

function registerLaneSubscriptionCleanup(
  ctx: RpcContext,
  subscriptionId: string,
  cleanup: () => void
): void {
  ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
}
