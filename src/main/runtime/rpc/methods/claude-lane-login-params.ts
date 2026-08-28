import { z } from 'zod'

/**
 * Zod params for the S9-L1 login quartet plus selectAccount/removeAccount (S9-L1 §modules D).
 *
 * Every schema is `.strict()` and carries no lane or principal field — the lane is
 * `principalOf(ctx.pairedDeviceId)` and nothing else, so there is nothing here for one grant to
 * name in order to reach another's lane. Shapes match `shared/claude-lane-login-rpc.ts` (L2's
 * already-merged client contract) exactly.
 */

export const LaneLoginStartParams = z
  .object({
    // Required (§3 row 1): an optional expectation would make I6 skippable at the caller's choice.
    expectedEmail: z.string().trim().min(1).max(254)
  })
  .strict()

export const LaneLoginSubmitCodeParams = z
  .object({
    loginSessionId: z.string().min(1).max(256),
    code: z.string().min(1).max(128)
  })
  .strict()

export const LaneLoginCancelParams = z
  .object({
    loginSessionId: z.string().min(1).max(256)
  })
  .strict()

export const LaneLoginStatusParams = z
  .object({
    loginSessionId: z.string().min(1).max(256)
  })
  .strict()

export const LaneSelectAccountParams = z
  .object({
    laneAccountId: z.string().min(1).max(256)
  })
  .strict()

export const LaneRemoveAccountParams = z
  .object({
    laneAccountId: z.string().min(1).max(256)
  })
  .strict()
