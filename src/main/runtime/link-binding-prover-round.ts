// S10-16 C4, R10/R11/R12/R13 (design v6): one verifier scan round — candidates -> page -> (per
// environment, link-binding-prover-probe.ts) capability -> probe -> classify -> settle. Lives
// beside link-binding-prover.ts (not under `orchestration/`) because it needs
// `OrcaRuntimeService`'s RPC surface (`callPinnedEnvironment`, `linkBindingSelfView`), matching
// where `orca-runtime.ts`'s own federation-relay sync logic lives.
import type { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationDb } from './orchestration/db'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  resolvePreferredEndpoint,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { hashCallerCredential } from './principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'
import { LINK_BINDING_PARK_REARM_MS } from './orchestration/link-binding-constants'
import { resolveUserDataPath } from './rpc/methods/orchestration-link-binding-pending'
import { CONFIRM_LABEL } from './orchestration/link-binding-proof'
import {
  collapseCredentialIdenticalCandidates,
  classifyLinkRound
} from './orchestration/link-binding-classify'
import {
  selectRoundPage,
  deriveRoundEpoch,
  linkBindingIntervalMs,
  roundBudgetMs,
  type PageCandidateLink,
  type RoundMode
} from './orchestration/link-binding-schedule'
import type { EnvCandidate, GuardedProbe, CapabilityCache } from './link-binding-prover-probe'
import { settleOneLink } from './link-binding-prover-settle'
import { reconfirmWinners, type ReconfirmCandidate } from './link-binding-prover-reconfirm'
import { recordContestAdvisoryReceipt } from './link-binding-prover-advisory'
import { probePage } from './link-binding-prover-scan'

export { CONFIRM_LABEL }
export type { GuardedProbe, CapabilityCache }

export type RoundOutcome = {
  completeness: 'complete' | 'partial'
  evaluatedLinkIds: readonly string[]
}

type LinkMeta = { grantClass: 'minted' | 'legacy_coalesced' }

export async function runOneRound(args: {
  runtime: OrcaRuntimeService
  mode: RoundMode
  now: number
  wanted: ReadonlySet<string>
  guardedProbe: GuardedProbe
  capabilityCache: CapabilityCache
}): Promise<RoundOutcome> {
  const { runtime, mode, now, wanted, guardedProbe, capabilityCache } = args
  const db = runtime.getOrchestrationDb()
  const selfView = runtime.linkBindingSelfView
  const ownKeyFp = selfView?.ownKeyFingerprint() ?? null
  if (!selfView || ownKeyFp === null) {
    return { completeness: 'partial', evaluatedLinkIds: [] }
  }

  // R10-A: candidate links.
  const linkCandidates: PageCandidateLink[] = []
  const linkMeta = new Map<string, LinkMeta>()
  for (const link of selfView.listRuntimeLinkCandidates()) {
    if (db.isPeerLinkQuarantined(link.deviceId)) {
      continue
    }
    const binding = db.getPeerLinkBinding(link.deviceId)
    if (binding?.revokedAt != null) {
      continue
    }
    let attempt = db.getBindingAttempt(link.deviceId)
    if (attempt?.lastOutcome === 'unpaired_parked') {
      // Ruling 23 Addendum 4(cc)/R13.3: the FIRST inbound contact after a park re-arms
      // immediately (link-binding-prover.ts's `scheduleBinding`, ungated); this is the REGISTER-
      // TIMER FALLBACK for a park that never receives contact — the sweep round itself re-arms
      // once LINK_BINDING_PARK_REARM_MS has elapsed since the park write (review C4b finding 4).
      const rearmDue = now - (attempt.lastAttemptAt ?? 0) >= LINK_BINDING_PARK_REARM_MS
      if (!rearmDue) {
        continue
      }
      db.settleBindingAttempt(link.deviceId, {
        lastAttemptAt: attempt.lastAttemptAt ?? now,
        lastRoundAt: attempt.lastRoundAt ?? now,
        lastOutcome: 'pending',
        lastDetail: attempt.lastDetail ?? null,
        consecutiveFailures: attempt.consecutiveFailures ?? 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: attempt.nextAttemptAfter ?? null
      })
      attempt = db.getBindingAttempt(link.deviceId)
    }
    // F1(b)/Ruling 23 Addendum 4(aa): a contested link never re-enters an automatic round — only
    // `proveNow` (which clears the contest) can. Keyed on the BINDING row's own `state`, never on
    // `peer_link_attempts` (a table the unshipped-v40 repair is licensed to drop and recreate,
    // review C4b finding 1) — the binding row is `A2_NEVER_DROPPED_TABLES`, so this exclusion
    // survives that repair even when the attempts row does not. Its next_attempt_after is null
    // (settle.ts), so without this exclusion a re-created attempts row would sit forever eligible
    // on the backoff check below.
    if (binding?.state === 'contested') {
      continue
    }
    if (attempt?.nextAttemptAfter != null && attempt.nextAttemptAfter > now) {
      continue
    }
    linkCandidates.push({
      linkDeviceId: link.deviceId,
      pairedAt: link.pairedAt,
      lastRoundAt: attempt?.lastRoundAt ?? null
    })
    linkMeta.set(link.deviceId, { grantClass: link.grantClass })
  }
  const page = selectRoundPage(linkCandidates, wanted)
  if (page.length === 0) {
    return { completeness: 'complete', evaluatedLinkIds: [] }
  }

  const maxLastRoundAt = linkCandidates.reduce((m, c) => Math.max(m, c.lastRoundAt ?? 0), 0)
  const roundEpoch = deriveRoundEpoch(maxLastRoundAt, now)

  // R13.2: backoff/last_attempt_at/last_round_at written BEFORE the first socket opens.
  for (const link of page) {
    db.putBindingAttempt(link.linkDeviceId)
    const attempt = db.getBindingAttempt(link.linkDeviceId)
    db.settleBindingAttempt(link.linkDeviceId, {
      lastAttemptAt: now,
      lastRoundAt: now,
      lastOutcome: attempt?.lastOutcome ?? 'pending',
      lastDetail: attempt?.lastDetail ?? null,
      consecutiveFailures: attempt?.consecutiveFailures ?? 0,
      consecutiveNoWinner: attempt?.consecutiveNoWinner ?? 0,
      nextAttemptAfter: now + linkBindingIntervalMs(attempt?.consecutiveFailures ?? 0)
    })
  }

  // F6/Ruling 23(v): a local environment-store read failure is never an attempted round — R13.4's
  // "a failed read is never evidence of absence" applied one layer up. Distinguished from a
  // legitimately empty store (which DOES probe normally and finds zero candidates) by
  // `readFailed`.
  const { candidates: envCandidates, readFailed } = buildEnvironmentCandidates(db, ownKeyFp)
  if (readFailed) {
    // Ruling 23 Addendum 4(dd): a local store read failure is a FAULT ON THIS HOST, never
    // evidence about the peer — settle it as `unavailable`/LOCAL_EVIDENCE_UNAVAILABLE_CODE, never
    // the wrong-machine `unpaired` diagnosis (review C4b finding 5).
    for (const link of page) {
      const meta = linkMeta.get(link.linkDeviceId)
      settleOneLink({
        db,
        selfView,
        linkDeviceId: link.linkDeviceId,
        grantClass: meta?.grantClass ?? 'legacy_coalesced',
        winners: [],
        peerDuplicateCount: 0,
        attempted: false,
        reconfirmed: false,
        now,
        environmentIds: [],
        collapseDetail: null,
        localEvidenceUnavailable: true
      })
    }
    return { completeness: 'partial', evaluatedLinkIds: page.map((p) => p.linkDeviceId) }
  }

  // R10-B (v6/M2): collapse credential-identical candidates to the newest, for the probe pass.
  // Ruling 23(d): the dropped record writes NO scan fact — only `last_detail`, and it does NOT
  // advance the park counter (Ruling 23(e) — it carries no outcome for R13.3's predicate).
  const collapsed = collapseCredentialIdenticalCandidates(envCandidates)
  // F10: composed into the settle's own single lastDetail write (below) rather than a separate
  // pre-write settleBindingAttempt call — the prior code's separate write was unconditionally
  // overwritten by settleOneLink's own write later in the SAME round (review F10).
  const collapseDetail =
    collapsed.dropped.length > 0
      ? `duplicate_environment:${collapsed.dropped
          .map((d) => `${d.environmentId}->${d.survivorEnvironmentId}`)
          .join(',')}`
      : null
  // R10.1/Ruling 23 Addendum 4(hh): the round's own budget, wired — a round that exceeds it ends
  // `partial` rather than running unbounded (review C4b finding 14).
  const roundDeadline = now + roundBudgetMs(collapsed.kept.length)

  const {
    winnersByLink,
    peerDuplicateCountByLink,
    attemptedEnvironmentCount,
    attemptedEnvironmentIds,
    anyPartial,
    advisoryByEnvironment
  } = await probePage({
    runtime,
    db,
    selfView,
    page,
    mode,
    now,
    roundEpoch,
    guardedProbe,
    capabilityCache,
    environments: collapsed.kept,
    deadline: roundDeadline
  })
  // Review C4b finding 11: `worstEnvironmentOutcome` (settle.ts) must read only facts this round
  // actually attempted — an environment skipped this round (busy, runtime_environment_changed,
  // or cut off by the round budget) contributes no fresh fact and must not leak a stale one in.
  const environmentIds = [...attemptedEnvironmentIds]

  // Ruling 23 Addendum 4(gg): the incumbent-vs-winner comparison happens BEFORE the R10-E winner
  // re-probe — a challenger contested against the incumbent is never sent a confirm; the round
  // records the contest and moves on (review C4b finding 17).
  const reconfirmCandidates: ReconfirmCandidate[] = []
  for (const link of page) {
    const winners = winnersByLink.get(link.linkDeviceId) ?? []
    const classification = classifyLinkRound(
      winners,
      peerDuplicateCountByLink.get(link.linkDeviceId) ?? 0
    )
    if (
      classification.outcome === 'bind' ||
      classification.outcome === 'duplicate_environment' ||
      classification.outcome === 'multi_grant'
    ) {
      const priorBinding = db.getPeerLinkBinding(link.linkDeviceId)
      const contestedByIncumbent =
        priorBinding !== null &&
        priorBinding.state !== 'revoked' &&
        priorBinding.peerKeyFingerprint !== classification.winner.peerKeyFingerprint
      if (!contestedByIncumbent) {
        reconfirmCandidates.push({
          linkDeviceId: link.linkDeviceId,
          winner: classification.winner
        })
      }
    }
  }
  const reconfirmed = await reconfirmWinners({
    runtime,
    selfView,
    guardedProbe,
    roundEpoch,
    candidates: reconfirmCandidates
  })

  for (const link of page) {
    const meta = linkMeta.get(link.linkDeviceId)
    settleOneLink({
      db,
      selfView,
      linkDeviceId: link.linkDeviceId,
      grantClass: meta?.grantClass ?? 'legacy_coalesced',
      winners: winnersByLink.get(link.linkDeviceId) ?? [],
      peerDuplicateCount: peerDuplicateCountByLink.get(link.linkDeviceId) ?? 0,
      attempted: (attemptedEnvironmentCount.get(link.linkDeviceId) ?? 0) >= collapsed.kept.length,
      // F12/Ruling 23(y): fail-CLOSED default — a bind-family classification with no entry in the
      // reconfirm map (today the map is total over the candidates; a future caller change must
      // not silently skip R10-E's re-probe).
      reconfirmed: reconfirmed.get(link.linkDeviceId) ?? false,
      now,
      environmentIds,
      collapseDetail
    })
  }

  // R11.5: applied AFTER the settle loop above — a same-round winner's peer_link_bindings row
  // must already exist (findBindingsByEnvironment reads it) for the receipt on that environment
  // to have anywhere to attach to. Never gates the round, never touches last_outcome.
  for (const [environmentId, advisory] of advisoryByEnvironment) {
    recordContestAdvisoryReceipt(db, environmentId, advisory, now)
  }

  return {
    completeness: anyPartial ? 'partial' : 'complete',
    evaluatedLinkIds: page.map((p) => p.linkDeviceId)
  }
}

function buildEnvironmentCandidates(
  db: OrchestrationDb,
  ownKeyFp: string
): { candidates: EnvCandidate[]; readFailed: boolean } {
  const userDataPath = resolveUserDataPath()
  let allEnvironments: KnownRuntimeEnvironment[]
  // F6/Ruling 23(v): a THROW (a store file present but unreadable/corrupt) is a FAULT, never
  // evidence of an empty candidate set — distinguished from `listEnvironments`' own legitimate
  // `{environments:[]}` empty-store return, which is NOT a read failure.
  try {
    allEnvironments = listEnvironments(userDataPath)
  } catch {
    return { candidates: [], readFailed: true }
  }
  const envCandidates: EnvCandidate[] = []
  for (const environment of allEnvironments) {
    const endpoint = resolvePreferredEndpoint(environment)
    if (!endpoint) {
      continue
    }
    if (fingerprintOrchestrationPeer(endpoint.publicKeyB64) === ownKeyFp) {
      continue
    }
    const exclude = db.getContainment('environment', environment.id, 'scan_exclude')
    if (exclude && exclude.liftedAt === null) {
      continue
    }
    envCandidates.push({
      environment,
      endpoint,
      environmentId: environment.id,
      createdAt: environment.createdAt,
      peerCredentialFp: hashCallerCredential(endpoint.deviceToken)
    })
  }
  return { candidates: envCandidates, readFailed: false }
}
