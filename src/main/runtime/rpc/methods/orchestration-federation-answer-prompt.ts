// S10-19 W-4: orchestration.federationAnswerPrompt — the choke's only caller. R21/R8.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
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
        return {
          available: false,
          reason: result.code,
          guidance: result.message,
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {})
        }
      }
      return { available: true, dispatchId: params.dispatchId, choice: params.choice }
    }
  })
]
