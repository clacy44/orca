// S10-16 C4, R10.3/R10-C (design v6): one environment's probe within a round — the fact-cache
// skip, selector construction and the RPC call. Split out of link-binding-prover-round.ts (plan
// §7.6 pattern) to stay under max-lines; settlement of the response lives in
// link-binding-prover-outcome.ts, and (Ruling 23 Addendum 5(qq)) the capability check/cache
// lives in link-binding-prover-capability.ts. `runOneRound` is the only caller.
import { randomBytes } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationDb } from './orchestration/db'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { hashCallerCredential } from './principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'
import type { LinkBindingSelfView } from './device-registry-link-credential'
import { LINK_BINDING_PROTOCOL, SELECTOR_LABEL } from './orchestration/link-binding-proof'
import {
  LINK_BINDING_PROBE_SLOTS,
  LINK_BINDING_NONCE_BYTES,
  LINK_BINDING_HEX32_LENGTH,
  LINK_BINDING_RPC_BUDGET_MS,
  LINK_BINDING_CAPABILITY_TTL_MS,
  LINK_BINDING_REVERIFY_MS,
  LINK_STORE_EMPTY_CODE
} from './orchestration/link-binding-constants'
import type { PageCandidateLink, RoundMode } from './orchestration/link-binding-schedule'
import {
  parseProbeResults,
  parseProbeAdvisory,
  writeScanFact,
  settleProbeFailure,
  settleProbeResults,
  type ProbeOneEnvironmentResult
} from './link-binding-prover-outcome'
import {
  resolveCapability,
  type CapabilityCache,
  type CapabilityResolution
} from './link-binding-prover-capability'

// Ruling 23 Addendum 5(qq): the capability cache/check moved to link-binding-prover-capability.ts
// (probe.ts is the file that grows — review C4c finding 8) — re-exported here so every existing
// importer (`link-binding-prover-round.ts`, `link-binding-prover-scan.ts`) keeps working unchanged.
export type { CapabilityCache }

export type EnvCandidate = {
  environment: KnownRuntimeEnvironment
  endpoint: { id: string; deviceToken: string; publicKeyB64: string }
  environmentId: string
  createdAt: number
  peerCredentialFp: string
}

// R10.2: the per-purpose in-flight guard, injected — link-binding-prover.ts owns the real
// registry; a test can inject a fake that always/never reports 'busy'.
export type GuardedProbe = <T>(
  environmentId: string,
  maxDurationMs: number,
  run: () => Promise<T>
) => Promise<T | 'busy'>

export type { ProbeOneEnvironmentResult }

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export async function probeOneEnvironment(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  selfView: LinkBindingSelfView
  candidate: EnvCandidate
  page: PageCandidateLink[]
  mode: RoundMode
  now: number
  roundEpoch: number
  guardedProbe: GuardedProbe
  capabilityCache: CapabilityCache
}): Promise<ProbeOneEnvironmentResult> {
  const {
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
  } = args
  const { environment, endpoint, environmentId } = candidate
  const expectedRevision = environment.pairingRevision ?? environment.createdAt
  const observedChannelFp = hashCallerCredential(endpoint.deviceToken)
  const dstKeyFp = fingerprintOrchestrationPeer(endpoint.publicKeyB64)

  // R12.1(2): a contest_search round bypasses the fact cache entirely — sweep mode uses it.
  // v6 protocol M6: a candidate skipped for a live cached fact is `attempted`, CARRYING THAT
  // FACT'S OUTCOME — never a bare no-op. Without this, a link this host already proved (or that
  // already reported peer_duplicate) would read as a fresh `unpaired` on every cache-hit round,
  // which can eventually park an already-bound link. Under F2/Ruling 23(z)'s outcome-keyed skip
  // below, `allLive` can only be true when every cached fact is `no_match`,
  // `unavailable`(`link_store_empty`) or `unsupported` — none of which is `proven` or
  // `peer_duplicate` — so a live-fact-skipped round never contributes a winner or a duplicate
  // claim (review C4b finding 10; the prior winner/duplicate reconstruction here was dead code).
  if (mode === 'sweep' && page.length > 0) {
    const cached = page.map((link) => ({
      link,
      fact: db.getScanFact(link.linkDeviceId, environmentId)
    }))
    // F2/Ruling 23(z): the skip is keyed on the fact's OUTCOME (R12.2's per-outcome re-probe
    // column) — never a blanket "any live fact skips". Only `no_match` and `unavailable` with the
    // `link_store_empty` reason are TTL'd on LINK_BINDING_REVERIFY_MS; `unsupported` is TTL'd on
    // the shorter LINK_BINDING_CAPABILITY_TTL_MS. Every other outcome (`proven`, `peer_duplicate`,
    // `protocol_violation`, `unavailable` for any other reason, `unreachable`) re-probes every
    // round — a single transient fault must never freeze the environment out of the scan.
    const allLive = cached.every(({ link, fact }) => {
      if (fact === null) {
        return false
      }
      if (fact.environmentPairingRevision !== expectedRevision) {
        return false
      }
      if (
        fact.linkCredentialFp !== (selfView.registryCredentialFingerprint(link.linkDeviceId) ?? '')
      ) {
        return false
      }
      if (fact.outcome === 'no_match') {
        return now - fact.observedAt < LINK_BINDING_REVERIFY_MS
      }
      if (fact.outcome === 'unavailable' && fact.detail === LINK_STORE_EMPTY_CODE) {
        return now - fact.observedAt < LINK_BINDING_REVERIFY_MS
      }
      if (fact.outcome === 'unsupported') {
        return now - fact.observedAt < LINK_BINDING_CAPABILITY_TTL_MS
      }
      return false
    })
    if (allLive) {
      // No `winners`/`duplicateLinkIds` to reconstruct — see the comment above `allLive`.
      return {
        winners: [],
        duplicateLinkIds: [],
        attemptedLinkIds: page.map((l) => l.linkDeviceId),
        fullyAttempted: true,
        advisory: null
      }
    }
  }

  let capability: CapabilityResolution
  try {
    capability = await resolveCapability({
      runtime,
      environmentId,
      expectedRevision,
      now,
      capabilityCache
    })
  } catch (error) {
    // F5/Ruling 23(u): a transport/rate/queue failure during the capability check is NOT a
    // capability answer — route it through the same local-failure mapping the probe RPC uses
    // (unavailable(transport) etc.), and never cache it as `unsupported`.
    return settleProbeFailure({ db, selfView, page, environmentId, expectedRevision, error, now })
  }
  if (!capability.supported) {
    // Ruling 23 Addendum 5(ll)/review C4c finding 3: two registers, settled concretely. The
    // capability CACHE (below, `resolveCapability`) stores `false` for both an `'absent'`
    // capability (a successful `status.get` whose list omits it, or `method_not_found`) and a
    // `'peer_self_view'` one (the peer THREW `capability_unsupported`) — either way, redundant
    // `status.get` calls next round are skipped. The persisted SCAN FACT differs by reason: an
    // absent capability writes R10.3's `'unsupported'`; a peer self-report writes R10.3's
    // `'unavailable'` outcome with `detail = 'capability_unsupported'`, matching the identical
    // code's mapping in `settleProbeFailure` below for the RPC-level throw of the same code.
    const outcome = capability.reason === 'peer_self_view' ? 'unavailable' : 'unsupported'
    const detail = capability.reason === 'peer_self_view' ? 'capability_unsupported' : null
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

  const probeId = randomHex(LINK_BINDING_HEX32_LENGTH / 2)
  const nonceH = randomHex(LINK_BINDING_NONCE_BYTES)
  // F13/R10.4: slot order within the probe is shuffled per probe (Fisher-Yates over the `k` real
  // slots plus the padding) — without this, a page whose order is stable across rounds (the
  // common case under LINK_BINDING_PROBE_SLOTS) hands a responder a STABLE per-link slot index,
  // review C4b finding 13. `slotOrder[i]` is the wire slot this page's i-th link is assigned;
  // `slotLinks` is its inverse, threaded through to `settleProbeResults` so slot->link
  // attribution survives the shuffle.
  const slotOrder = fisherYatesSlotOrder(LINK_BINDING_PROBE_SLOTS)
  const slotLinks: (PageCandidateLink | null)[] = Array.from(
    { length: LINK_BINDING_PROBE_SLOTS },
    () => null
  )
  const selectors: string[] = Array.from({ length: LINK_BINDING_PROBE_SLOTS })
  page.forEach((link, i) => {
    const slot = slotOrder[i]
    if (slot === undefined) {
      return
    }
    slotLinks[slot] = link
    selectors[slot] =
      selfView.macWithRegistryToken(link.linkDeviceId, SELECTOR_LABEL, [
        probeId,
        nonceH,
        String(slot),
        String(roundEpoch),
        observedChannelFp,
        dstKeyFp
      ]) ?? randomHex(LINK_BINDING_NONCE_BYTES)
  })
  for (let s = 0; s < LINK_BINDING_PROBE_SLOTS; s += 1) {
    if (selectors[s] === undefined) {
      selectors[s] = randomHex(LINK_BINDING_NONCE_BYTES)
    }
  }

  let guarded: unknown
  try {
    guarded = await guardedProbe(environmentId, LINK_BINDING_RPC_BUDGET_MS, () =>
      runtime.callPinnedEnvironment({
        selector: environmentId,
        method: 'orchestration.federatedLinkProbe',
        params: { protocol: LINK_BINDING_PROTOCOL, probeId, nonceH, epoch: roundEpoch, selectors },
        timeoutMs: LINK_BINDING_RPC_BUDGET_MS,
        maxDurationMs: LINK_BINDING_RPC_BUDGET_MS,
        expectedEnvironmentPairingRevision: expectedRevision,
        requireOrchestrationContract: false
      })
    )
  } catch (error) {
    return settleProbeFailure({ db, selfView, page, environmentId, expectedRevision, error, now })
  }
  if (guarded === 'busy') {
    // R10.2/L3: this host's own scheduling — excluded from R13.3's attempted/park test entirely.
    return {
      winners: [],
      duplicateLinkIds: [],
      attemptedLinkIds: [],
      fullyAttempted: false,
      advisory: null
    }
  }

  const parsed = parseProbeResults(guarded)
  if (parsed === null) {
    for (const link of page) {
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
    return {
      winners: [],
      duplicateLinkIds: [],
      attemptedLinkIds: page.map((l) => l.linkDeviceId),
      fullyAttempted: true,
      advisory: null
    }
  }
  return settleProbeResults({
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
    advisory: parseProbeAdvisory(guarded),
    now
  })
}

// R10.4: Fisher-Yates over `n` positions — the shuffled permutation of slot indices this probe
// assigns, in page order (`result[i]` is the wire slot the i-th real link/padding entry lands
// on).
// R10.4: exported for the R10-E winner re-probe (Ruling 23 Addendum 5(pp)/
// link-binding-prover-reconfirm.ts), which is a probe and shares this exact shuffle.
export function fisherYatesSlotOrder(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = order[i]
    order[i] = order[j] as number
    order[j] = tmp as number
  }
  return order
}
