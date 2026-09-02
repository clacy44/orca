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
    const attempt = db.getBindingAttempt(link.deviceId)
    if (attempt?.lastOutcome === 'unpaired_parked') {
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

  const envCandidates = buildEnvironmentCandidates(db, ownKeyFp)
  // R10-B (v6/M2): collapse credential-identical candidates to the newest, for the probe pass.
  // Ruling 23(d): the dropped record writes NO scan fact — only `last_detail`, and it does NOT
  // advance the park counter (Ruling 23(e) — it carries no outcome for R13.3's predicate).
  const collapsed = collapseCredentialIdenticalCandidates(envCandidates)
  if (collapsed.dropped.length > 0) {
    recordCollapsedDuplicates(db, page, collapsed.dropped, now)
  }

  const {
    winnersByLink,
    peerDuplicateCountByLink,
    attemptedEnvironmentCount,
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
    environments: collapsed.kept
  })

  // R10-E: re-probe + batched confirm every bind-family winner BEFORE any peer_link_bindings
  // write — gathered across the whole page so links that won the SAME environment share one
  // re-probe + one confirm call (link-binding-prover-reconfirm.ts).
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
      reconfirmCandidates.push({
        linkDeviceId: link.linkDeviceId,
        winner: classification.winner
      })
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
      reconfirmed: reconfirmed.get(link.linkDeviceId) ?? null,
      now
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

function buildEnvironmentCandidates(db: OrchestrationDb, ownKeyFp: string): EnvCandidate[] {
  const userDataPath = resolveUserDataPath()
  let allEnvironments: KnownRuntimeEnvironment[]
  try {
    allEnvironments = listEnvironments(userDataPath)
  } catch {
    allEnvironments = []
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
  return envCandidates
}

function recordCollapsedDuplicates(
  db: OrchestrationDb,
  page: PageCandidateLink[],
  dropped: { environmentId: string; survivorEnvironmentId: string }[],
  now: number
): void {
  const byDetail = dropped.map((d) => `${d.environmentId}->${d.survivorEnvironmentId}`).join(',')
  for (const link of page) {
    const attempt = db.getBindingAttempt(link.linkDeviceId)
    db.settleBindingAttempt(link.linkDeviceId, {
      lastAttemptAt: now,
      lastRoundAt: now,
      lastOutcome: attempt?.lastOutcome ?? 'pending',
      lastDetail: `duplicate_environment:${byDetail}`,
      consecutiveFailures: attempt?.consecutiveFailures ?? 0,
      consecutiveNoWinner: attempt?.consecutiveNoWinner ?? 0,
      nextAttemptAfter: attempt?.nextAttemptAfter ?? null
    })
  }
}
