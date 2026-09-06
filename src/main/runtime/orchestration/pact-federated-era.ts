// S10-21b B6 (design §2.12, Ruling 34 Addendum 6(1), closes N1) — `propose`'s inbound
// era-adoption + seq reset. Split into its own module rather than folded into
// pact-federated-emit.ts (an EMIT-side file) because this is the one piece of INBOUND apply
// logic the design places in this commit's scope explicitly (README OPEN item 3 / chair answer
// 3): commit 8's `applyInboundPactVerb` dispatcher calls this function for its `propose` case
// rather than re-deriving the era-adoption/seq-reset logic. If that split proves unworkable at
// commit 8's implementation time, commit 8 returns the finding — no unilateral merge of the
// propose inbound apply into either commit.
import type Database from '../../sqlite/sync-database'

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
export function adoptEraOnInboundPropose(
  db: Database.Database,
  pact: { id: string },
  inbound: { era: number }
): void {
  db.prepare(
    `UPDATE threads SET pact_era = ?, pact_local_seq = 0, pact_peer_seq = 0 WHERE id = ?`
  ).run(inbound.era, pact.id)
}
