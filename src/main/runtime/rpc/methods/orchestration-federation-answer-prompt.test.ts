// S10-19 W-4 review finding 9: a choke refusal must carry §D's frozen wire code so a home can
// tell rate_limited from forbidden from invalid_argument by error.code — the {available:false}
// envelope is gone; every refusal throws.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { ORCHESTRATION_FEDERATION_ANSWER_PROMPT_METHODS } from './orchestration-federation-answer-prompt'

const method = ORCHESTRATION_FEDERATION_ANSWER_PROMPT_METHODS[0]

describe('S10-19 W-4 review finding 9: orchestration.federationAnswerPrompt refusal wire codes', () => {
  it('a refusal throws OrchestrationError with the choke refusal code as error.code', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      // No attachment row at all — peerOwnedAttachmentOrRefusal's ownership check refuses.
      await expect(
        method.handler({ dispatchId: 'disp_missing', choice: 'accept_trust' }, {
          runtime,
          authenticatedCallerFingerprint: 'fp_peer'
        } as never)
      ).rejects.toMatchObject({
        code: expect.any(String)
      })
      try {
        await method.handler({ dispatchId: 'disp_missing', choice: 'accept_trust' }, {
          runtime,
          authenticatedCallerFingerprint: 'fp_peer'
        } as never)
        expect.unreachable('expected a throw')
      } catch (error) {
        expect(error).toBeInstanceOf(OrchestrationError)
        const wireCode = (error as OrchestrationError).code
        expect(['forbidden', 'rate_limited', 'invalid_argument']).toContain(wireCode)
      }
    } finally {
      db.close()
    }
  })

  it('the handler forwards retryAfterMs as error.data when the refusal carries one', async () => {
    const peerWrite = await import('../../peer-owned-pane-write')
    vi.spyOn(peerWrite, 'writeToPeerOwnedPane').mockResolvedValue({
      refused: true,
      code: 'rate_limited',
      wireCode: 'rate_limited',
      message: 'Too many prompt answers.',
      retryAfterMs: 5000,
      nextSteps: []
    })
    try {
      const runtime = new OrcaRuntimeService()
      await expect(
        method.handler({ dispatchId: 'disp_rate', choice: 'accept_trust' }, {
          runtime,
          authenticatedCallerFingerprint: 'fp_peer'
        } as never)
      ).rejects.toMatchObject({
        code: 'rate_limited',
        data: { retryAfterMs: 5000 }
      })
    } finally {
      vi.restoreAllMocks()
    }
  })
})
