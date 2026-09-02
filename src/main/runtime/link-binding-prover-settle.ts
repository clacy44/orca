// S10-16 C4, R11/R12.2/R13.3 (design v6): one link's round settle — R11's classification applied
// to the tallied winners/duplicates, the single-writer binding write, the contest write, and the
// R13.3 park counter. Split out of link-binding-prover-round.ts (plan §7.6 pattern) to stay under
// max-lines; `runOneRound` is the only caller.
import { randomBytes } from 'node:crypto'
import type { OrchestrationDb } from './orchestration/db'
import type { LinkBindingSelfView } from './device-registry-link-credential'
import { LINK_BINDING_PROTOCOL } from './orchestration/link-binding-proof'
import {
  LINK_BINDING_HEX32_LENGTH,
  LINK_BINDING_UNPAIRED_PARK_ROUNDS
} from './orchestration/link-binding-constants'
import { classifyLinkRound, type LinkRoundWinner } from './orchestration/link-binding-classify'
import { linkBindingIntervalMs } from './orchestration/link-binding-schedule'
import type { LinkBindingLastOutcome } from './orchestration/link-binding-attempts-store'

export function settleOneLink(args: {
  db: OrchestrationDb
  selfView: LinkBindingSelfView
  linkDeviceId: string
  grantClass: 'minted' | 'legacy_coalesced'
  winners: LinkRoundWinner[]
  peerDuplicateCount: number
  attempted: boolean
  now: number
}): void {
  const { db, selfView, linkDeviceId, grantClass, winners, peerDuplicateCount, attempted, now } =
    args
  const classification = classifyLinkRound(winners, peerDuplicateCount)
  const priorAttempt = db.getBindingAttempt(linkDeviceId)
  let lastOutcome: LinkBindingLastOutcome = priorAttempt?.lastOutcome ?? 'pending'
  let consecutiveNoWinner = priorAttempt?.consecutiveNoWinner ?? 0
  const consecutiveFailures = priorAttempt?.consecutiveFailures ?? 0
  let lastDetail: string | null = null

  if (
    classification.outcome === 'bind' ||
    classification.outcome === 'duplicate_environment' ||
    classification.outcome === 'multi_grant'
  ) {
    // R12.2's persisted vocabulary has no 'bind' member — a clean single-winner round is
    // recorded 'proven' ("it is the winner"); duplicate_environment/multi_grant keep their own
    // names, matching the CHECK in peer_link_attempts.last_outcome.
    lastOutcome = classification.outcome === 'bind' ? 'proven' : classification.outcome
    lastDetail = classification.detail
    consecutiveNoWinner = 0
    db.putPeerLinkBinding({
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
    })
  } else if (classification.outcome === 'contested') {
    lastOutcome = 'contested'
    lastDetail = classification.detail
    const incidentId = randomBytes(LINK_BINDING_HEX32_LENGTH / 2).toString('hex')
    db.contestPeerLinkBinding(linkDeviceId, now, incidentId, classification.detail)
  } else if (classification.outcome === 'peer_duplicate') {
    lastOutcome = 'peer_duplicate'
    // Ruling 23(e): R11.2's original "counts toward the park counter" clause is DELETED — a
    // peer-supplied word (design test 7, inverted) NEVER advances consecutive_no_winner, even
    // though R12.2's table still marks it `attempted: yes` for sweep-completeness bookkeeping.
    // consecutiveNoWinner is therefore left exactly at its prior value here — neither
    // incremented nor reset.
  } else {
    lastOutcome = 'unpaired'
    if (attempted) {
      consecutiveNoWinner += 1
    }
  }

  if (consecutiveNoWinner >= LINK_BINDING_UNPAIRED_PARK_ROUNDS) {
    lastOutcome = 'unpaired_parked'
  }

  db.settleBindingAttempt(linkDeviceId, {
    lastAttemptAt: now,
    lastRoundAt: now,
    lastOutcome,
    lastDetail,
    consecutiveFailures,
    consecutiveNoWinner,
    nextAttemptAfter: now + linkBindingIntervalMs(consecutiveFailures)
  })
}
