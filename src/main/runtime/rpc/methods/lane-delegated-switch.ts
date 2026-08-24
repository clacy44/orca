import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { requireLaneWireService } from '../../lane-wire-service'

/**
 * §2l step 2: the phone asks; the host validates the opaque token against the caller's OWN
 * principal's delegable list and forwards to the designated desktop. It returns `pending` — the
 * host genuinely does not know the outcome yet — and the phone learns it from the lane status
 * stream, never from a return value.
 */
const RequestSwitchParams = z
  .object({
    delegatedAccountId: z.string().min(1, 'Missing delegatedAccountId').max(128)
  })
  .strict()

export const LANE_DELEGATED_SWITCH_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.lane.requestSwitch',
    params: RequestSwitchParams,
    handler: async (params, ctx) =>
      requireLaneWireService().switches.requestSwitch(ctx.pairedDeviceId, params.delegatedAccountId)
  })
]
