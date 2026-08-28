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

/**
 * Host-inline params (§modules E): the CLI resolves `--person` to a principalId itself, over the
 * host-only door (`authorizeHostConsent`) rather than a paired grant's `pairedDeviceId`, so these
 * DO carry a principalId — unlike every schema above, which derives the lane from the caller and
 * would let one grant name another's lane if it carried one.
 */
const PrincipalIdParam = z.uuid('Invalid principalId')

export const LaneLoginStartInlineParams = z
  .object({
    principalId: PrincipalIdParam,
    expectedEmail: z.string().trim().min(1).max(254)
  })
  .strict()

export const LaneLoginSubmitCodeInlineParams = z
  .object({
    principalId: PrincipalIdParam,
    loginSessionId: z.string().min(1).max(256),
    code: z.string().min(1).max(128)
  })
  .strict()

export const LaneLoginCancelInlineParams = z
  .object({
    principalId: PrincipalIdParam
  })
  .strict()

export const LaneSelectAccountInlineParams = z
  .object({
    principalId: PrincipalIdParam,
    laneAccountId: z.string().min(1).max(256)
  })
  .strict()

export const LaneListAccountsInlineParams = z
  .object({
    principalId: PrincipalIdParam
  })
  .strict()

export const LaneLogoutInlineParams = z
  .object({
    principalId: PrincipalIdParam
  })
  .strict()
