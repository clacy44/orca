// S10-21b B8 (design §2.4, §4.2 gates 6/9) — the pact-envelope half of `orchestration.federatedSend`:
// the wire schema, gate 6 (identity outcome must be `imported`)/gate 9 (route), the dispatch into
// `db.applyInboundPactVerb`, and firing the wake it describes. Split out of
// orchestration-federated-peer-send.ts (which stays the plain-mail handler) per the max-lines
// ratchet — called from there only when `params.pact` is present; every existing plain-mail path
// is untouched.
import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { isHostMessageId } from '../../orchestration/orchestration-id-grammar'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type {
  ApplyInboundPactVerbArgs,
  InboundPactWake
} from '../../orchestration/pact-federated-inbound-apply'
import { wakePactThread, wakePactThreadBoth, wakeTurnArrived } from './orchestration-pact-wake'
import type { RemoteIdentityImport } from '../../orchestration/federated-sender-identity'

// The pact envelope (design §2.4). `resync`/`resyncRequest` are mutually exclusive (never both
// present); `seq` is the sender's own `pact_local_seq`, except `gap_notice` (`pact_local_seq + 1`).
export const FederatedPactParams = z.object({
  verb: z.enum([
    'propose',
    'accept',
    'decline',
    'step',
    'pause',
    'resume',
    'release',
    'rebind_party',
    'resync',
    'resync_request',
    'gap_notice'
  ]),
  seq: z.number().int().nonnegative(),
  era: z.number().int().nonnegative(),
  stepsTotal: z.number().int().positive().nullable().optional(),
  ordinal: z.number().int().nonnegative().optional(),
  reasonCode: z.string().max(64).optional(),
  rebind: z.object({ oldAgentId: z.string() }).optional(),
  resyncRequest: z.object({ nonce: z.string().max(64) }).optional(),
  resync: z
    .object({
      nonce: z.string().max(64),
      localSeq: z.number().int().nonnegative(),
      ordinal: z.number().int().nonnegative(),
      state: z.enum(['proposed', 'engaged', 'released']),
      turnHeldBySender: z.boolean(),
      pauseEpoch: z.number().int().nonnegative(),
      senderReleased: z.boolean()
    })
    .optional()
})

export type FederatedPactEnvelope = z.infer<typeof FederatedPactParams>

// Called only when `params.pact` is present; `imported` is whatever gate 5 (identity import)
// already computed — this owns gate 6 (strict outcome) onward.
export function handleInboundPactEnvelope(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  pairedDeviceId: string,
  toAgentId: string,
  args: { messageId: string; threadId: string | undefined; body: string | undefined },
  pact: FederatedPactEnvelope,
  imported: RemoteIdentityImport
): { accepted: true; messageId: string; threadId: string } {
  // Gate 6 (design §4.2) — a pact envelope requires the STRICT identity outcome; `capped`/
  // `absent`/`invalid` refuse `pact_identity_unmirrored` (amendment 9/A6) rather than falling
  // through to the tolerant unattributed-mail path.
  if (imported.outcome !== 'imported') {
    throw new OrchestrationError(
      'pact_identity_unmirrored',
      'Refused: the pact sender identity could not be mirrored on this host.'
    )
  }
  if (!isHostMessageId(args.messageId)) {
    throw new OrchestrationError(
      'invalid_argument',
      'The relayed message id is not a valid message id.'
    )
  }
  // Gate 9 — route. Gates 1-5 never call getRoutableLinkBinding for the general mail path (only
  // the reply-continuation heuristic does); a pact envelope needs its own explicit check.
  if (!getRoutableLinkBinding(db, runtime, pairedDeviceId)) {
    throw new OrchestrationError('pact_no_route', 'Refused: this link is not currently routable.', {
      nextSteps: ['this is retryable once the link is routable again']
    })
  }
  const applyArgs: ApplyInboundPactVerbArgs = {
    pairedDeviceId,
    senderAgentId: imported.row.remote_agent_id,
    senderEnvironmentId: imported.row.environment_id,
    messageId: args.messageId,
    peerThreadId: args.threadId ?? null,
    toAgentId,
    body: args.body,
    pact
  }
  const result = db.applyInboundPactVerb(applyArgs)
  fireInboundPactWake(runtime, result.wake)
  runtime.getLinkBindingProver().scheduleBinding(pairedDeviceId, 'inbound_contact')
  return { accepted: true, messageId: result.messageId, threadId: result.threadId }
}

// Fires the wake `applyInboundPactVerb` described, AFTER its transaction committed (settle's own
// precedent: the db-layer method never imports OrcaRuntimeService).
function fireInboundPactWake(runtime: OrcaRuntimeService, wake: InboundPactWake): void {
  if (wake.kind === 'proposed') {
    wakePactThread(runtime, wake.toAgentId, wake.threadId, 'proposed', [
      `orca agents pact --accept --on ${wake.threadId}`
    ])
  } else if (wake.kind === 'accepted') {
    wakePactThread(runtime, wake.proposerAgentId, wake.threadId, 'accepted', [])
    wakeTurnArrived(runtime, wake.proposerAgentId, wake.threadId)
  } else if (wake.kind === 'declined') {
    wakePactThread(runtime, wake.otherLocal, wake.threadId, 'declined', [])
  } else if (wake.kind === 'released') {
    wakePactThreadBoth(runtime, wake.threadId, wake.bothParties, 'released', [])
  } else if (wake.kind === 'stepArrived' && wake.otherLocal) {
    runtime.notifyMessageArrived(`agent:${wake.otherLocal}`, 'status', wake.threadId, 'pact_step')
  } else if (wake.kind === 'pauseOrResume') {
    wakePactThreadBoth(
      runtime,
      wake.threadId,
      wake.bothParties,
      wake.verb === 'pause' ? 'paused' : 'resumed',
      []
    )
  } else if (wake.kind === 'gapNotice') {
    wakePactThreadBoth(runtime, wake.threadId, wake.bothParties, 'gap_notice', [])
  }
}
