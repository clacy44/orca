// S10-16 C4a, R11.5/C-9 (design v6): the cross-host contest-advisory RECEIPT — this host's own
// record of a probed environment's self-reported `advisory` field. Split out to keep
// link-binding-prover-round.ts under the max-lines gate (Ruling 23(m): split, no baseline
// entry). `runOneRound` is the only caller.
//
// Storage (Ruling 19 P5): keyed on the ENVIRONMENT that supplied the advisory, not on any one
// round candidate — `findBindingsByEnvironment` finds which of THIS host's own links are
// currently bound to that environment, and the advisory is written onto each of those links'
// `peer_link_attempts` row (the only table that carries `last_advisory`). Never writes
// `last_outcome` — that column's single writer stays the round settle.
import type { OrchestrationDb } from './orchestration/db'
import type { ProbeAdvisory } from './link-binding-prover-outcome'
import { LINK_BINDING_RATE_WINDOW_MS } from './orchestration/link-binding-constants'

export function recordContestAdvisoryReceipt(
  db: OrchestrationDb,
  environmentId: string,
  advisory: ProbeAdvisory,
  now: number
): void {
  const bindings = db.findBindingsByEnvironment(environmentId)
  for (const binding of bindings) {
    const attempt = db.getBindingAttempt(binding.linkDeviceId)
    const existing = attempt?.lastAdvisory ?? null
    // R11.5/plan §C4 P-8: the writer refuses to overwrite an advisory of a DIFFERENT kind —
    // audit only, no state change. A `peer_reports_contest` advisory (this receipt's own kind,
    // never the wire's `link_contested`/`link_quarantined`, which is what the PEER found on ITS
    // side) may always refresh itself.
    if (existing && existing.kind !== 'peer_reports_contest') {
      // Ruling 23 Addendum 5(mm)/review C4c finding 4: peer-triggerable (the advisory's `kind`
      // is a peer-chosen field, and `authorship_unconfirmed` — written by C5's pump — is a
      // normal-operation value that trips this branch every round) — metered like every other
      // C4/C4a/C4b/C4c audit writer, `linkbind:<id>` subject key, `limit: 1` per
      // LINK_BINDING_RATE_WINDOW_MS.
      const gate = db.checkAndBumpRate({
        subjectKey: `linkbind:${binding.linkDeviceId}`,
        verb: 'linkBindingAdvisoryConflictAudit',
        windowMs: LINK_BINDING_RATE_WINDOW_MS,
        limit: 1
      })
      if (gate.allowed) {
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: environmentId,
          verb: 'linkBindingAdvisory',
          outcome: 'advisory_kind_conflict',
          reasonCode: JSON.stringify({ existing: existing.kind, incoming: 'peer_reports_contest' })
        })
      }
      continue
    }
    db.putLinkAdvisory(
      binding.linkDeviceId,
      { kind: 'peer_reports_contest', incidentId: advisory.incidentId, environmentId },
      now
    )
  }
}
