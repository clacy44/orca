// S10-16 C4a, R10.1 (design v6): the round's own probe-pass fan-out — a bounded worker pool over
// this round's candidate environments, plus the per-link aggregation of what each environment's
// probe produced (winners, duplicates, attempted-ness, and any R11.5 advisory). Split out of
// link-binding-prover-round.ts (Ruling 23(m): split, no baseline entry) — `runOneRound` is the
// only caller.
import type { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationDb } from './orchestration/db'
import type { LinkBindingSelfView } from './device-registry-link-credential'
import { LINK_BINDING_SCAN_CONCURRENCY } from './orchestration/link-binding-constants'
import type { LinkRoundWinner } from './orchestration/link-binding-classify'
import type { PageCandidateLink, RoundMode } from './orchestration/link-binding-schedule'
import {
  probeOneEnvironment,
  type EnvCandidate,
  type GuardedProbe,
  type CapabilityCache
} from './link-binding-prover-probe'
import type { ProbeAdvisory } from './link-binding-prover-outcome'

export type ProbePageResult = {
  winnersByLink: Map<string, LinkRoundWinner[]>
  peerDuplicateCountByLink: Map<string, number>
  attemptedEnvironmentCount: Map<string, number>
  // Review C4b finding 11: the set of environments this round actually produced a fresh outcome
  // for — excludes anything skipped by the in-flight guard, a `runtime_environment_changed`
  // retry signal, or (R10.1) the round budget below. `worstEnvironmentOutcome` (settle.ts) must
  // scope to exactly this set, never to every collapsed candidate.
  attemptedEnvironmentIds: Set<string>
  anyPartial: boolean
  advisoryByEnvironment: Map<string, ProbeAdvisory>
}

export async function probePage(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  selfView: LinkBindingSelfView
  page: PageCandidateLink[]
  mode: RoundMode
  now: number
  roundEpoch: number
  guardedProbe: GuardedProbe
  capabilityCache: CapabilityCache
  environments: EnvCandidate[]
  // R10.1/Ruling 23 Addendum 4(hh): a wall-clock cutoff (now + roundBudgetMs) — a worker that
  // would start a new environment probe past this point stops instead, and the round ends
  // `partial`. An in-flight probe already dispatched is never aborted (cancellation is
  // R4.6/R10.2's own client-level `maxDurationMs`, not this budget).
  deadline: number
}): Promise<ProbePageResult> {
  const {
    runtime,
    db,
    selfView,
    page,
    mode,
    now,
    roundEpoch,
    guardedProbe,
    capabilityCache,
    environments,
    deadline
  } = args
  const winnersByLink = new Map<string, LinkRoundWinner[]>()
  const peerDuplicateCountByLink = new Map<string, number>()
  const attemptedEnvironmentCount = new Map<string, number>()
  const attemptedEnvironmentIds = new Set<string>()
  const advisoryByEnvironment = new Map<string, ProbeAdvisory>()
  let anyPartial = false

  // R10.1: a bounded worker pool, not chunked batches — a slow candidate never holds up the
  // other LINK_BINDING_SCAN_CONCURRENCY-1 workers waiting for its own batch to drain; the next
  // candidate starts the instant any worker's current probe settles. The per-purpose in-flight
  // registry (R10.2, `guardedProbe`) still bounds concurrency per environment independently of
  // this pool's width.
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < environments.length) {
      if (Date.now() > deadline) {
        anyPartial = true
        return
      }
      const candidate = environments[nextIndex]
      nextIndex += 1
      if (!candidate) {
        continue
      }
      const result = await probeOneEnvironment({
        runtime,
        db,
        selfView,
        candidate,
        page,
        mode,
        now,
        roundEpoch,
        guardedProbe,
        capabilityCache
      })
      for (const win of result.winners) {
        const arr = winnersByLink.get(win.linkDeviceId) ?? []
        arr.push(win.winner)
        winnersByLink.set(win.linkDeviceId, arr)
      }
      for (const linkId of result.duplicateLinkIds) {
        peerDuplicateCountByLink.set(linkId, (peerDuplicateCountByLink.get(linkId) ?? 0) + 1)
      }
      for (const linkId of result.attemptedLinkIds) {
        attemptedEnvironmentCount.set(linkId, (attemptedEnvironmentCount.get(linkId) ?? 0) + 1)
      }
      if (result.attemptedLinkIds.length > 0) {
        attemptedEnvironmentIds.add(candidate.environmentId)
      }
      if (!result.fullyAttempted) {
        anyPartial = true
      }
      if (result.advisory) {
        advisoryByEnvironment.set(candidate.environmentId, result.advisory)
      }
    }
  }
  const poolWidth = Math.min(LINK_BINDING_SCAN_CONCURRENCY, environments.length)
  await Promise.all(Array.from({ length: poolWidth }, () => worker()))

  return {
    winnersByLink,
    peerDuplicateCountByLink,
    attemptedEnvironmentCount,
    attemptedEnvironmentIds,
    anyPartial,
    advisoryByEnvironment
  }
}
