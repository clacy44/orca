// S10-21b B6 (design §2.12, Ruling 34 Addendum 6(1), closes N1) — `propose`'s inbound
// era-adoption + seq reset. Split into its own module rather than folded into
// pact-federated-emit.ts (an EMIT-side file) because this is the one piece of INBOUND apply
// logic the design places in this commit's scope explicitly (README OPEN item 3 / chair answer
// 3): commit 8's `applyInboundPactVerb` dispatcher calls this function for its `propose` case
// rather than re-deriving the era-adoption/seq-reset logic. If that split proves unworkable at
// commit 8's implementation time, commit 8 returns the finding — no unilateral merge of the
// propose inbound apply into either commit.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { SAFE_INT_MAX } from './pact-federated-inbound-gates'

// v2's defect (design §2.12): a receiver whose thread has never seen a pact has
// `pact_era = 0`; the proposer's first `propose` necessarily arrives with `era: 1`. Every OTHER
// verb requires era equality and refuses `pact_era_mismatch` on mismatch — but `propose` must
// ADOPT the sender's era instead of checking it, because there is no prior era to check against
// on a first propose, and a re-propose after release simply becomes the new shared era.
//
// This function performs ONLY the era-adoption + seq-reset half of the inbound `propose` apply
// (`threads.pact_era = pact.era`, `pact_local_seq = 0`, `pact_peer_seq = 0`) — it does not run
// any of the gates (identity, id grammar, dedupe, `requireNoEngagedPactWithPeer`'s federated
// arm, the fence) that commit 8's `applyInboundPactVerb` dispatcher owns for `propose` like
// every other verb. The caller is responsible for wrapping this in its own `BEGIN IMMEDIATE`
// transaction alongside those gates and the `pact_steps` ledger write for the inbound propose.
// A-F9/B-F7: the caller MUST call this from inside its own `BEGIN IMMEDIATE` (moved there by the
// apply — a pre-transaction call left a propose that then failed with the era already moved and
// both seqs zeroed against no written pact). The adopted era is capped so `era + 1` (this host's
// own next local propose after adopting) stays inside the id-grammar bound gate 7 enforces
// (`SAFE_INT_MAX`) — refused here rather than later at the peer's own grammar gate, which would
// otherwise strand the pact permanently (the peer refuses `invalid_argument`, terminal, with no
// repair verb able to move the era back down).
export function adoptEraOnInboundPropose(
  db: Database.Database,
  pact: { id: string },
  inbound: { era: number }
): void {
  if (inbound.era >= SAFE_INT_MAX - 1) {
    throw new OrchestrationError(
      'invalid_argument',
      `The relayed pact era ${inbound.era} is too close to the grammar's bound to adopt.`,
      { reasonCode: 'malformed_relay_id' }
    )
  }
  db.prepare(
    `UPDATE threads SET pact_era = ?, pact_local_seq = 0, pact_peer_seq = 0 WHERE id = ?`
  ).run(inbound.era, pact.id)
}
