// S10-2b: turns an `insertGatedMessage`/`purgeMessage`/`purgeThread` HARD refusal into the RPC
// error every send-shaped verb (send, broadcast, reply, ask) throws. Rule ids are surfaced —
// never matched text, offsets, or the literal an infra-allowlist entry matched (GATE §, ruling
// 6/9) — a refusal that echoed the match would republish the very thing it blocked into the
// sender's own transcript. Exact wording/`--acknowledge-gate` CLI ergonomics are S10-2c's; this
// is the typed error the RPC layer owes every caller in the meantime.
import { OrchestrationError } from './orchestration-error'
import type { GateVerdict } from '../../../shared/message-body-gate'

export function gateVerdictRefusalError(
  verdict: Extract<GateVerdict, { tier: 'hard' }>,
  refusalId: number
): OrchestrationError {
  return new OrchestrationError(
    'body_gate_refused',
    `Refused: this body matches the containment gate (rules: ${verdict.ruleIds.join(', ')}). ` +
      'It was not stored and nothing was delivered.',
    {
      ruleIds: verdict.ruleIds,
      refusalId,
      nextSteps: [
        'Rewrite as fix + verification + invariant, or send a one-line pass/fail verdict instead.',
        'If the detail genuinely must exist, re-send with --acknowledge-gate to store it flagged and audited.'
      ]
    }
  )
}
