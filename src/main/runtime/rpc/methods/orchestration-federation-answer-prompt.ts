// S10-19 W-4: orchestration.federationAnswerPrompt — the choke's only caller. R21/R8.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { writeToPeerOwnedPane } from '../../peer-owned-pane-write'

const FederationAnswerPromptParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  choice: z.enum(['accept_trust', 'decline'])
})

export const ORCHESTRATION_FEDERATION_ANSWER_PROMPT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationAnswerPrompt',
    params: FederationAnswerPromptParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const result = await writeToPeerOwnedPane({
        ctx: { runtime, callerFingerprint: authenticatedCallerFingerprint ?? '' },
        dispatchId: params.dispatchId,
        choice: params.choice
      })
      if (result.refused) {
        // Review finding 9: §D maps the choke's refusal codes to error.code
        // forbidden/rate_limited/invalid_argument — the {available:false} shape stayed reserved
        // for profile_required/profile_scope_mismatch, neither of which this choke ever
        // produces, so every refusal here now throws with its own frozen wireCode.
        // W-5..W-7 review finding 4 (Ruling 24 addendum 4(dd)): the choke previously discarded
        // result.nextSteps entirely — every §9.1 refusal must carry effectsApplied:false and its
        // nextSteps, and this is the one caller that used to drop the field on the floor.
        throw new OrchestrationError(result.wireCode, result.message, {
          effectsApplied: false,
          nextSteps: result.nextSteps,
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {})
        })
      }
      return { available: true, dispatchId: params.dispatchId, choice: params.choice }
    }
  })
]
