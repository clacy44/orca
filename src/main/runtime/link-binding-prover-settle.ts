// S10-16 C4, R11/R12.2/R13.3 (design v6) + Ruling 23 Addendum 3 (r)-(z): one link's round settle
// — R11's classification applied to the tallied winners/duplicates, R11.4's incumbent-vs-winner
// contest check, the single-writer binding write, the contest write, and the R13.3 park counter.
// Split out of link-binding-prover-round.ts (plan §7.6 pattern) to stay under max-lines;
// `runOneRound` is the only caller.
import { randomBytes } from 'node:crypto'
import type { OrchestrationDb } from './orchestration/db'
import type { LinkBindingSelfView } from './device-registry-link-credential'
import { LINK_BINDING_PROTOCOL } from './orchestration/link-binding-proof'
import {
  LINK_BINDING_HEX32_LENGTH,
  LINK_BINDING_UNPAIRED_PARK_ROUNDS,
  LINK_BINDING_RATE_WINDOW_MS,
  LOCAL_EVIDENCE_UNAVAILABLE_CODE
} from './orchestration/link-binding-constants'
import { classifyLinkRound, type LinkRoundWinner } from './orchestration/link-binding-classify'
import { linkBindingIntervalMs } from './orchestration/link-binding-schedule'
import type { LinkBindingLastOutcome } from './orchestration/link-binding-attempts-store'

// F9: the round's "worst" per-environment scan outcome, used ONLY when the round classified
// `unpaired` (no winner, no peer_duplicate claim) — so the settle records the actual machinery-
// gap diagnosis (`unavailable`/`unreachable`/`unsupported`/`protocol_violation`) instead of
// collapsing every failed round to the same `unpaired` word (review F9). Priority order matches
// the health-word precedence register (4.6): unavailable > unreachable > unsupported >
// protocol_violation.
const WORST_OUTCOME_PRIORITY: Partial<Record<string, number>> = {
  unavailable: 4,
  unreachable: 3,
  unsupported: 2,
  protocol_violation: 1
}

function worstEnvironmentOutcome(
  db: OrchestrationDb,
  linkDeviceId: string,
  environmentIds: readonly string[]
): LinkBindingLastOutcome | null {
  let best: { outcome: LinkBindingLastOutcome; rank: number } | null = null
  for (const environmentId of environmentIds) {
    const fact = db.getScanFact(linkDeviceId, environmentId)
    // v6 protocol M6: a candidate SKIPPED this round for a live cached fact is still "attempted,
    // carrying that fact's outcome" — so a cache-hit round's stored fact is exactly as valid
    // evidence as one freshly written this round. Ruling 23 Addendum 4(hh)/review C4b finding
    // 11: the CALLER (link-binding-prover-round.ts) scopes `environmentIds` to
    // `attemptedEnvironmentIds` — environments this round actually produced a fresh outcome for
    // — never the full collapsed candidate set, so a `busy`/`runtime_environment_changed`/
    // round-budget-cutoff environment (no scan fact written this round) can never leak a stale
    // fact in here.
    if (!fact) {
      continue
    }
    const rank = WORST_OUTCOME_PRIORITY[fact.outcome]
    if (rank === undefined) {
      continue
    }
    if (!best || rank > best.rank) {
      best = { outcome: fact.outcome as LinkBindingLastOutcome, rank }
    }
  }
  return best?.outcome ?? null
}

export function settleOneLink(args: {
  db: OrchestrationDb
  selfView: LinkBindingSelfView
  linkDeviceId: string
  grantClass: 'minted' | 'legacy_coalesced'
  winners: LinkRoundWinner[]
  peerDuplicateCount: number
  attempted: boolean
  // R10-E: whether THIS link's winning slot survived the winner re-probe + batched
  // federatedLinkConfirm (link-binding-prover-reconfirm.ts). Read ONLY for a bind-family
  // classification; F12/Ruling 23(y): defaults fail-CLOSED (`false`) for every other case, where
  // it is documented unread.
  reconfirmed: boolean
  now: number
  // F9: every environment this round considered (post-collapse) — used only to derive the worst
  // machinery-gap outcome for an `unpaired` round.
  environmentIds: readonly string[]
  // F10: the R10-B collapse's own diagnostic note ("one peer saved twice, the older copy was
  // never probed") for this round, if any — composed into THIS function's single lastDetail
  // write (as a fallback, when the branch below has no more specific detail of its own) instead
  // of a separate pre-write that settleBindingAttempt's later call unconditionally destroyed.
  collapseDetail: string | null
  // Ruling 23 Addendum 4(dd): this round never reached the wire — the LOCAL environment-store
  // read itself failed (link-binding-prover-round.ts's `readFailed` branch). Settles
  // `unavailable`/LOCAL_EVIDENCE_UNAVAILABLE_CODE unconditionally and returns before any other
  // branch runs; both park counters are left untouched (review C4b finding 5).
  localEvidenceUnavailable?: boolean
  // Ruling 28(a) (C8a): true only for the operator's forced link in a `proveNow` round — licenses
  // clearing an existing contest on a clean single-winner outcome (`resolvePeerLinkBindingContest`,
  // the ONE additional guarded write this clause adds, called only from this file). Defaults to
  // false for every caller predating C8a.
  forcedResolve?: boolean
}): void {
  const {
    db,
    selfView,
    linkDeviceId,
    grantClass,
    winners,
    peerDuplicateCount,
    attempted,
    reconfirmed,
    now,
    environmentIds,
    collapseDetail,
    localEvidenceUnavailable,
    forcedResolve = false
  } = args
  const priorAttempt = db.getBindingAttempt(linkDeviceId)
  if (localEvidenceUnavailable) {
    db.settleBindingAttempt(linkDeviceId, {
      lastAttemptAt: now,
      lastRoundAt: now,
      lastOutcome: 'unavailable',
      lastDetail: LOCAL_EVIDENCE_UNAVAILABLE_CODE,
      consecutiveFailures: priorAttempt?.consecutiveFailures ?? 0,
      consecutiveNoWinner: priorAttempt?.consecutiveNoWinner ?? 0,
      nextAttemptAfter: now + linkBindingIntervalMs(priorAttempt?.consecutiveFailures ?? 0)
    })
    return
  }
  const classification = classifyLinkRound(winners, peerDuplicateCount)
  const priorBinding = db.getPeerLinkBinding(linkDeviceId)
  let lastOutcome: LinkBindingLastOutcome = priorAttempt?.lastOutcome ?? 'pending'
  let consecutiveNoWinner = priorAttempt?.consecutiveNoWinner ?? 0
  let consecutiveFailures = priorAttempt?.consecutiveFailures ?? 0
  let lastDetail: string | null = null
  // F1/Ruling 23(r): a contested round is EXCLUDED from automatic scheduling — no backoff, only
  // `proveNow` re-arms it (R11.3 step 3). Every other branch keeps the ordinary backoff curve.
  let isContested = false

  // Ruling 23 Addendum 4(ff): every audit writer C4/C4a/C4b added goes through the D3 pattern
  // (orchestration-link-binding-pending.ts's `refuseIfQuarantined`/`refuseIfRateLimited`) —
  // `limit: 1` per LINK_BINDING_RATE_WINDOW_MS per verb per link, so a peer alternating between
  // two live grants (finding 7's `multi_grant` shape) cannot mint an unbounded `agent_audit`
  // stream by flipping the round's winner every kick.
  function meteredAudit(verb: string, write: () => void): void {
    const gate = db.checkAndBumpRate({
      subjectKey: `linkbind:${linkDeviceId}`,
      verb,
      windowMs: LINK_BINDING_RATE_WINDOW_MS,
      limit: 1
    })
    if (gate.allowed) {
      write()
    }
  }

  function writeContest(detail: string, incumbentEnvironmentId: string | null): void {
    // Ruling 23 Addendum 5(jj)/review C4c finding 1: `writeContest` is only ever called from a
    // branch classifyLinkRound reached with `winners.length >= 1` (bind-family or `contested`),
    // so a first winner always exists here. Ruling 23 Addendum 6(vv)/review C4d findings 7/8:
    // the row's identity columns must be DETERMINISTIC, never "whichever finished first" —
    // winners are ordered by (peerCredentialFp, peerKeyFingerprint) ascending before the first is
    // taken. Its host-derived fields seed the row when the write's UPSERT finds none (R11.3's
    // canonical no-incumbent case); when a row already exists (the bind-family incumbent-mismatch
    // branch), the UPDATE half of the upsert never touches these columns.
    const orderedWinners = [...winners].sort((a, b) => {
      if (a.peerCredentialFp !== b.peerCredentialFp) {
        return a.peerCredentialFp < b.peerCredentialFp ? -1 : 1
      }
      return a.peerKeyFingerprint < b.peerKeyFingerprint ? -1 : 1
    })
    const firstWinner = orderedWinners[0]
    const linkCredentialFp = selfView.registryCredentialFingerprint(linkDeviceId)
    // (vv): a winner missing any host-derived identity field is a protocol_violation outcome —
    // no `?? ''` fallback ever writes a junk contested row (the same shape F18 removed from
    // `writeScanFact`).
    if (
      !firstWinner ||
      !firstWinner.environmentId ||
      !firstWinner.boundEndpointId ||
      !firstWinner.peerCredentialFp ||
      !firstWinner.peerKeyFingerprint ||
      !linkCredentialFp
    ) {
      lastOutcome = 'protocol_violation'
      lastDetail = detail
      return
    }
    lastOutcome = 'contested'
    lastDetail = detail
    isContested = true
    const incidentId = randomBytes(LINK_BINDING_HEX32_LENGTH / 2).toString('hex')
    // (vv): the contest-resolution verb re-proves; it never trusts a contested row's
    // environment_id (C7 carries the verb — this row's identity is the round's first winner by
    // construction, not necessarily the true claimant).
    db.contestPeerLinkBinding(linkDeviceId, now, incidentId, detail, {
      environmentId: firstWinner.environmentId,
      boundEndpointId: firstWinner.boundEndpointId,
      boundPairingRevision: firstWinner.boundPairingRevision,
      linkCredentialFp,
      peerCredentialFp: firstWinner.peerCredentialFp,
      peerKeyFingerprint: firstWinner.peerKeyFingerprint,
      grantClass,
      scanCompleteness: attempted ? 'complete' : 'partial',
      proofProtocol: LINK_BINDING_PROTOCOL
    })
    // Ruling 23 Addendum 6(rr)/review C4d finding 1: the contest audit is a SECURITY EVENT — one
    // row per (link, contest incident id) — written DIRECTLY, never through the window meter
    // (`meteredAudit` stays for the rebound writer only, below).
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: linkDeviceId,
      verb: 'linkBinding',
      outcome: 'contested',
      reasonCode: JSON.stringify({ incidentId, incumbentEnvironmentId })
    })
  }

  if (
    classification.outcome === 'bind' ||
    classification.outcome === 'duplicate_environment' ||
    classification.outcome === 'multi_grant'
  ) {
    // F1/R11.4/Ruling 23(r): read the INCUMBENT before any bind-family write. A live incumbent
    // (not revoked) whose peerKeyFingerprint differs from this round's winner is a second holder
    // of the link credential — contest, never overwrite. The single writer's ONE contest path
    // (this function) is also the only place that reads the incumbent for this purpose.
    if (
      !forcedResolve &&
      priorBinding &&
      priorBinding.state !== 'revoked' &&
      priorBinding.peerKeyFingerprint !== classification.winner.peerKeyFingerprint
    ) {
      writeContest(
        JSON.stringify({
          incumbentEnvironmentId: priorBinding.environmentId,
          incumbentPeerKeyFingerprint: priorBinding.peerKeyFingerprint,
          challengerEnvironmentId: classification.winner.environmentId,
          challengerPeerKeyFingerprint: classification.winner.peerKeyFingerprint
        }),
        priorBinding.environmentId
      )
    } else if (reconfirmed === false) {
      // R10-E: the winner re-probe/confirm failed (fresh proof did not re-verify, or the peer's
      // federatedLinkConfirm never acknowledged this link's slot) — single-writer property
      // preserved: NOTHING is written to peer_link_bindings. Recorded with the register's own
      // vocabulary, exactly as a failed probe would be, and counted toward the park predicate
      // like any other no-surviving-winner round. F4/Ruling 23(t): this IS this host's own dial
      // failing after a proof matched, so it backs off like `unreachable`/`unavailable`.
      lastOutcome = 'unreachable'
      lastDetail = `reconfirm_failed:${classification.winner.environmentId}`
      // F3/Ruling 23(e)/(s): `reconfirmed` is derived from the PEER's own `acknowledged` array —
      // a peer that proves it holds T_in and then declines to acknowledge the confirm must never
      // be able to drive this host's own park counter. consecutive_no_winner is left untouched,
      // exactly as the `peer_duplicate` branch below. consecutive_failures IS this host's own
      // dial-outcome counter (R13.2/Ruling 23(t)) and increments as any `unreachable` does.
      consecutiveFailures += 1
    } else {
      // R12.2's persisted vocabulary has no 'bind' member — a clean single-winner round is
      // recorded 'proven' ("it is the winner"); duplicate_environment/multi_grant keep their own
      // names, matching the CHECK in peer_link_attempts.last_outcome.
      lastOutcome = classification.outcome === 'bind' ? 'proven' : classification.outcome
      lastDetail = classification.detail
      consecutiveNoWinner = 0
      consecutiveFailures = 0
      const freshRow: Parameters<OrchestrationDb['putPeerLinkBinding']>[0] = {
        linkDeviceId,
        environmentId: classification.winner.environmentId,
        boundEndpointId: classification.winner.boundEndpointId,
        boundPairingRevision: classification.winner.boundPairingRevision,
        linkCredentialFp: selfView.registryCredentialFingerprint(linkDeviceId) ?? '',
        peerCredentialFp: classification.winner.peerCredentialFp,
        peerKeyFingerprint: classification.winner.peerKeyFingerprint,
        grantClass,
        scanCompleteness: attempted ? 'complete' : 'partial',
        proofProtocol: LINK_BINDING_PROTOCOL,
        provedAt: now,
        lastVerifiedAt: now
      }
      // Ruling 28(a): a forced (proveNow) round with a currently-contested incumbent and exactly
      // one clean winner CLEARS the contest — the ONE path licensed to do so
      // (`putPeerLinkBinding`'s own upsert structurally refuses to, by design, for every other
      // caller). Recorded with its own audit outcome, directly (a security-relevant state
      // transition, like the contest write itself — never through `meteredAudit`).
      if (forcedResolve && priorBinding?.state === 'contested') {
        const resolvedIncidentId = priorBinding.contestIncidentId
        db.resolvePeerLinkBindingContest(freshRow)
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: linkDeviceId,
          verb: 'linkBinding',
          outcome: 'link_contest_resolved',
          reasonCode: JSON.stringify({
            incidentId: resolvedIncidentId,
            environmentId: classification.winner.environmentId
          })
        })
      } else {
        // F8/R11.3: a rebind that replaces a binding naming a DIFFERENT environment is audited.
        // Finding 7: metered (see `meteredAudit`) — a peer holding two live grants to the same
        // key can otherwise flip `winner.environmentId` every round and mint one rebound row per
        // kick.
        if (priorBinding && priorBinding.environmentId !== classification.winner.environmentId) {
          meteredAudit('linkBindingReboundAudit', () => {
            db.writeAgentAudit({
              agentId: null,
              actorPaneKey: null,
              actorHostId: linkDeviceId,
              verb: 'linkBinding',
              outcome: 'link_binding_rebound',
              reasonCode: JSON.stringify({
                fromEnvironmentId: priorBinding.environmentId,
                toEnvironmentId: classification.winner.environmentId
              })
            })
          })
        }
        db.putPeerLinkBinding(freshRow)
      }
    }
  } else if (classification.outcome === 'contested') {
    // R11.3: two-or-more winners THIS round with different key fingerprints — refuse both.
    writeContest(classification.detail, priorBinding?.environmentId ?? null)
  } else if (classification.outcome === 'peer_duplicate') {
    lastOutcome = 'peer_duplicate'
    // Ruling 23(e)/(s): R11.2's original "counts toward the park counter" clause is DELETED — a
    // peer-supplied word (design test 7, inverted) NEVER advances consecutive_no_winner, even
    // though R12.2's table still marks it `attempted: yes` for sweep-completeness bookkeeping.
    // consecutiveNoWinner is therefore left exactly at its prior value here — neither
    // incremented nor reset. consecutiveFailures is likewise untouched (Ruling 23(t) names only
    // unreachable/unavailable outcomes).
  } else {
    // F9: derive the actual worst per-environment outcome instead of collapsing every no-winner,
    // no-peer_duplicate round to a bare 'unpaired' — the wrong-machine diagnosis R10.3 exists to
    // prevent.
    const worst = worstEnvironmentOutcome(db, linkDeviceId, environmentIds)
    lastOutcome = worst ?? 'unpaired'
    if (attempted) {
      consecutiveNoWinner += 1
    }
    // F4/Ruling 23(t): consecutive_failures increments only when the no-winner round's own cause
    // was THIS host's dial (unreachable/unavailable) — never for a bare absence of any candidate
    // (no environments at all -> stays 'unpaired') nor for unsupported/protocol_violation, which
    // are the peer's own diagnostic gaps, not a dial failure.
    if (worst === 'unreachable' || worst === 'unavailable') {
      consecutiveFailures += 1
    }
  }

  if (!isContested && consecutiveNoWinner >= LINK_BINDING_UNPAIRED_PARK_ROUNDS) {
    lastOutcome = 'unpaired_parked'
  }

  // F10: the collapse note survives ONLY when this round's own outcome carries no more specific
  // detail of its own — never overwrites a contest/rebind/reconfirm-failure detail.
  if (lastDetail === null && collapseDetail !== null) {
    lastDetail = collapseDetail
  }

  db.settleBindingAttempt(linkDeviceId, {
    lastAttemptAt: now,
    lastRoundAt: now,
    lastOutcome,
    lastDetail,
    consecutiveFailures,
    consecutiveNoWinner,
    // F1/(r): a contested link is excluded from every automatic round until `proveNow` clears it
    // (R11.3 step 3) — null, never a backoff timestamp.
    nextAttemptAfter: isContested ? null : now + linkBindingIntervalMs(consecutiveFailures)
  })
}
