// S10-16 C4, R7.8/R10.3/R11 (design v6): response shape validation, the scan-fact writer, the
// R10.3 local-failure mapping and the per-environment proof-verification settle. Split out of
// link-binding-prover-probe.ts (plan §7.6 pattern) to stay under max-lines;
// `probeOneEnvironment` is the only caller.
import type { OrchestrationDb } from './orchestration/db'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { LinkBindingSelfView } from './device-registry-link-credential'
import {
  PROOF_LABEL,
  LINK_BINDING_HEX32_RE,
  LINK_BINDING_HEX64_RE,
  linkBindingMacEquals
} from './orchestration/link-binding-proof'
import { LINK_BINDING_PROBE_SLOTS } from './orchestration/link-binding-constants'
import type { LinkRoundWinner } from './orchestration/link-binding-classify'
import type { PageCandidateLink } from './orchestration/link-binding-schedule'
import type {
  ScanFactRow,
  LinkScanFactOutcome
} from './orchestration/link-binding-observations-store'

export type ProbeOneEnvironmentResult = {
  winners: { linkDeviceId: string; winner: LinkRoundWinner }[]
  duplicateLinkIds: string[]
  // every link this environment produced an outcome for (winner, duplicate, or no_match) —
  // R12.2's "attempted" column. A `busy` environment (never reached the wire) contributes none.
  attemptedLinkIds: string[]
  fullyAttempted: boolean
  // R11.5: this environment's validated advisory, if any — null on every path with no live wire
  // response (busy, local failure, unsupported, cached-fact skip) or a malformed/absent advisory.
  advisory: ProbeAdvisory | null
}

export type SlotProbeResult =
  | { slotIndex: number; matched: true; nonceP: string; proof: string }
  | { slotIndex: number; matched: false; reason: 'peer_duplicate' }

// R11.5/R7.8/C-9: the responder's cross-host contest-advisory RECEIPT. Validated the same way
// (closed `kind` enum, LINK_BINDING_HEX32_RE id) as every other response field — a malformed
// advisory is DROPPED, never a `protocol_violation` (an advisory can never fail a round).
export type ProbeAdvisory = { kind: 'link_contested' | 'link_quarantined'; incidentId: string }

export function parseProbeAdvisory(raw: unknown): ProbeAdvisory | null {
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const advisory = (raw as { advisory?: unknown }).advisory
  if (advisory === undefined || advisory === null || typeof advisory !== 'object') {
    return null
  }
  const a = advisory as Record<string, unknown>
  if (a.kind !== 'link_contested' && a.kind !== 'link_quarantined') {
    return null
  }
  if (typeof a.incidentId !== 'string' || !LINK_BINDING_HEX32_RE.test(a.incidentId)) {
    return null
  }
  return { kind: a.kind, incidentId: a.incidentId }
}

// R7.8: shape-validate the response before any MAC evaluation. A violation is `protocol_violation`
// for that environment, never a throw.
export function parseProbeResults(raw: unknown): SlotProbeResult[] | null {
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const results = (raw as { results?: unknown }).results
  if (!Array.isArray(results)) {
    return null
  }
  const out: SlotProbeResult[] = []
  let lastSlot = -1
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    if (typeof e.slotIndex !== 'number' || !Number.isInteger(e.slotIndex)) {
      return null
    }
    if (e.slotIndex < 0 || e.slotIndex >= LINK_BINDING_PROBE_SLOTS || e.slotIndex <= lastSlot) {
      return null
    }
    lastSlot = e.slotIndex
    if (e.matched === true) {
      if (typeof e.nonceP !== 'string' || typeof e.proof !== 'string') {
        return null
      }
      out.push({ slotIndex: e.slotIndex, matched: true, nonceP: e.nonceP, proof: e.proof })
    } else if (e.matched === false && e.reason === 'peer_duplicate') {
      out.push({ slotIndex: e.slotIndex, matched: false, reason: 'peer_duplicate' })
    } else {
      return null
    }
  }
  return out
}

export function writeScanFact(
  db: OrchestrationDb,
  linkDeviceId: string,
  environmentId: string,
  outcome: LinkScanFactOutcome,
  environmentPairingRevision: number,
  selfView: LinkBindingSelfView,
  now: number,
  // F9: the machinery-gap vocabulary (Ruling 23(x)) — the raw local/peer-self-report code behind
  // an `unavailable` outcome (`link_store_empty` / `link_store_unreadable` / `rate_limited` /
  // `runtime_rpc_queue_overloaded`), so C6 can render R21's distinct health words from stored
  // state instead of a collapsed `unavailable`. `null` for every other outcome.
  detail: string | null = null
): void {
  const linkCredentialFp = selfView.registryCredentialFingerprint(linkDeviceId)
  // F18: the device row vanished mid-round — refuse the write rather than pinning a scan fact to
  // an empty fingerprint (which would match any other failed read).
  if (linkCredentialFp === null) {
    return
  }
  const row: ScanFactRow = {
    linkDeviceId,
    environmentId,
    outcome,
    environmentPairingRevision,
    linkCredentialFp,
    detail,
    observedAt: now
  }
  db.putScanFact(row)
}

// R10.3: the full local error -> scan-fact mapping table, in one place. `runtime_environment_changed`
// (R4.7/sweep A-i) is a RETRY signal, never a failure bump — this round leaves the candidate
// un-probed (no scan fact, `attemptedLinkIds: []`) so the NEXT round tries it fresh, and never
// touches `consecutive_failures`.
export function settleProbeFailure(args: {
  db: OrchestrationDb
  selfView: LinkBindingSelfView
  page: PageCandidateLink[]
  environmentId: string
  expectedRevision: number
  error: unknown
  now: number
}): ProbeOneEnvironmentResult {
  const { db, selfView, page, environmentId, expectedRevision, error, now } = args
  const code = error instanceof Error && 'code' in error ? (error as { code: string }).code : null
  if (code === 'runtime_environment_changed') {
    return {
      winners: [],
      duplicateLinkIds: [],
      attemptedLinkIds: [],
      fullyAttempted: false,
      advisory: null
    }
  }
  // capability_unsupported / link_store_unreadable / link_store_empty / rate_limited /
  // runtime_rpc_queue_overloaded all map to `unavailable` — none of them are `unreachable`
  // (R10.3's table: a local resource fault or a truthful "broken"/"empty" self-report is never
  // reported as a remote outage).
  // Ruling 23 Addendum 5(ll) (settling C4c finding 3, ex-Ruling 23 Addendum 4(ee)): TWO
  // REGISTERS, no contradiction. THIS mapping is R10.3's own SCAN-FACT OUTCOME table —
  // `capability_unsupported` here settles `unavailable` (persisted, reported to the operator),
  // reached when `federatedLinkProbe` itself throws the code. It is independent of
  // `resolveCapability`'s CAPABILITY CACHE in link-binding-prover-probe.ts, which governs Ruling
  // 23(u) ("caches ONLY a genuine capability_unsupported") and only skips a redundant
  // `status.get` call — it never decides this outcome. `resolveCapability`'s OWN caller
  // (`probeOneEnvironment`'s `!capability.supported` branch, reached when `status.get` itself
  // throws or answers without the capability) now applies the SAME R10.3 mapping independently,
  // keyed on the `reason` `resolveCapability` returns — see the comment there.
  const isUnavailable =
    code === 'capability_unsupported' ||
    code === 'link_store_unreadable' ||
    code === 'link_store_empty' ||
    code === 'rate_limited' ||
    code === 'runtime_rpc_queue_overloaded'
  const outcome: LinkScanFactOutcome = isUnavailable
    ? 'unavailable'
    : code === 'method_not_found'
      ? 'unsupported'
      : 'unreachable'
  // F9/Ruling 23(x): carry the code itself into `detail` for `unavailable` so the machinery-gap
  // reason (empty store vs. unreadable store vs. transport/rate fault) survives to C6.
  const detail = isUnavailable ? code : null
  for (const link of page) {
    writeScanFact(
      db,
      link.linkDeviceId,
      environmentId,
      outcome,
      expectedRevision,
      selfView,
      now,
      detail
    )
  }
  return {
    winners: [],
    duplicateLinkIds: [],
    attemptedLinkIds: page.map((l) => l.linkDeviceId),
    fullyAttempted: true,
    advisory: null
  }
}

export function settleProbeResults(args: {
  db: OrchestrationDb
  selfView: LinkBindingSelfView
  page: PageCandidateLink[]
  // F13/R10.4: the per-probe shuffled slot->link map (link-binding-prover-probe.ts) — the ONLY
  // correct way to attribute a `slotIndex` back to a link once slot order no longer equals page
  // order. `page` is still needed for `attemptedLinkIds` and the no-match set.
  slotLinks: (PageCandidateLink | null)[]
  environmentId: string
  environment: KnownRuntimeEnvironment
  endpoint: { id: string; deviceToken: string; publicKeyB64: string }
  expectedRevision: number
  observedChannelFp: string
  dstKeyFp: string
  probeId: string
  nonceH: string
  roundEpoch: number
  parsed: SlotProbeResult[]
  advisory: ProbeAdvisory | null
  now: number
}): ProbeOneEnvironmentResult {
  const {
    db,
    selfView,
    page,
    slotLinks,
    environmentId,
    environment,
    endpoint,
    expectedRevision,
    observedChannelFp,
    dstKeyFp,
    probeId,
    nonceH,
    roundEpoch,
    parsed,
    advisory,
    now
  } = args
  const winners: { linkDeviceId: string; winner: LinkRoundWinner }[] = []
  const duplicateLinkIds: string[] = []
  const matchedLinkIds = new Set<string>()
  for (const result of parsed) {
    const link = slotLinks[result.slotIndex]
    if (!link) {
      continue
    }
    matchedLinkIds.add(link.linkDeviceId)
    if (!result.matched) {
      duplicateLinkIds.push(link.linkDeviceId)
      writeScanFact(
        db,
        link.linkDeviceId,
        environmentId,
        'peer_duplicate',
        expectedRevision,
        selfView,
        now
      )
      continue
    }
    const expectedProof = selfView.macWithRegistryToken(link.linkDeviceId, PROOF_LABEL, [
      probeId,
      nonceH,
      String(result.slotIndex),
      String(roundEpoch),
      observedChannelFp,
      dstKeyFp,
      result.nonceP
    ])
    if (
      expectedProof !== null &&
      LINK_BINDING_HEX64_RE.test(result.proof) &&
      linkBindingMacEquals(expectedProof, result.proof)
    ) {
      winners.push({
        linkDeviceId: link.linkDeviceId,
        winner: {
          environmentId,
          createdAt: environment.createdAt,
          boundEndpointId: endpoint.id,
          boundPairingRevision: expectedRevision,
          peerCredentialFp: observedChannelFp,
          peerKeyFingerprint: dstKeyFp
        }
      })
      writeScanFact(db, link.linkDeviceId, environmentId, 'proven', expectedRevision, selfView, now)
    } else {
      // F15: a shape-valid `matched: true` response whose MAC fails is a PROTOCOL violation, not
      // a transport failure — `unreachable` would let a peer choose to have itself diagnosed as a
      // network fault instead of a bogus proof.
      writeScanFact(
        db,
        link.linkDeviceId,
        environmentId,
        'protocol_violation',
        expectedRevision,
        selfView,
        now
      )
    }
  }
  const noMatch = page.filter((l) => !matchedLinkIds.has(l.linkDeviceId)).map((l) => l.linkDeviceId)
  for (const linkId of noMatch) {
    writeScanFact(db, linkId, environmentId, 'no_match', expectedRevision, selfView, now)
  }
  return {
    winners,
    duplicateLinkIds,
    attemptedLinkIds: page.map((l) => l.linkDeviceId),
    fullyAttempted: true,
    advisory
  }
}
