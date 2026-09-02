// S10-16 C4, R10.3/R10-C (design v6): one environment's probe within a round — the fact-cache
// skip, the capability check, selector construction and the RPC call. Split out of
// link-binding-prover-round.ts (plan §7.6 pattern) to stay under max-lines; settlement of the
// response lives in link-binding-prover-outcome.ts. `runOneRound` is the only caller.
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
  LINK_BINDING_REVERIFY_MS
} from './orchestration/link-binding-constants'
import { ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { LinkRoundWinner } from './orchestration/link-binding-classify'
import type { PageCandidateLink, RoundMode } from './orchestration/link-binding-schedule'
import {
  parseProbeResults,
  writeScanFact,
  settleProbeFailure,
  settleProbeResults,
  type ProbeOneEnvironmentResult
} from './link-binding-prover-outcome'

export type EnvCandidate = {
  environment: KnownRuntimeEnvironment
  endpoint: { id: string; deviceToken: string; publicKeyB64: string }
  environmentId: string
  createdAt: number
  peerCredentialFp: string
}

type CapabilityCacheEntry = { supported: boolean; expiresAt: number }
export type CapabilityCache = Map<string, CapabilityCacheEntry>

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
  // which can eventually park an already-bound link. The winner/duplicate shape is reconstructed
  // from purely LOCAL data (this candidate's own endpoint, pinned and unchanged — that is exactly
  // what "live" means here), never from the wire.
  if (mode === 'sweep' && page.length > 0) {
    const cached = page.map((link) => ({
      link,
      fact: db.getScanFact(link.linkDeviceId, environmentId)
    }))
    const allLive = cached.every(
      ({ link, fact }) =>
        fact !== null &&
        fact.environmentPairingRevision === expectedRevision &&
        fact.linkCredentialFp ===
          (selfView.registryCredentialFingerprint(link.linkDeviceId) ?? '') &&
        now - fact.observedAt < LINK_BINDING_REVERIFY_MS
    )
    if (allLive) {
      const winners: { linkDeviceId: string; winner: LinkRoundWinner }[] = []
      const duplicateLinkIds: string[] = []
      for (const { link, fact } of cached) {
        if (fact?.outcome === 'proven') {
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
        } else if (fact?.outcome === 'peer_duplicate') {
          duplicateLinkIds.push(link.linkDeviceId)
        }
      }
      return {
        winners,
        duplicateLinkIds,
        attemptedLinkIds: page.map((l) => l.linkDeviceId),
        fullyAttempted: true
      }
    }
  }

  const supported = await resolveCapability({
    runtime,
    environmentId,
    expectedRevision,
    now,
    capabilityCache
  })
  if (!supported) {
    for (const link of page) {
      writeScanFact(
        db,
        link.linkDeviceId,
        environmentId,
        'unsupported',
        expectedRevision,
        selfView,
        now
      )
    }
    return {
      winners: [],
      duplicateLinkIds: [],
      attemptedLinkIds: page.map((l) => l.linkDeviceId),
      fullyAttempted: true
    }
  }

  const probeId = randomHex(LINK_BINDING_HEX32_LENGTH / 2)
  const nonceH = randomHex(LINK_BINDING_NONCE_BYTES)
  const selectors: string[] = page.map(
    (link, idx) =>
      selfView.macWithRegistryToken(link.linkDeviceId, SELECTOR_LABEL, [
        probeId,
        nonceH,
        String(idx),
        String(roundEpoch),
        observedChannelFp,
        dstKeyFp
      ]) ?? randomHex(LINK_BINDING_NONCE_BYTES)
  )
  while (selectors.length < LINK_BINDING_PROBE_SLOTS) {
    selectors.push(randomHex(LINK_BINDING_NONCE_BYTES))
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
    return { winners: [], duplicateLinkIds: [], attemptedLinkIds: [], fullyAttempted: false }
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
      fullyAttempted: true
    }
  }
  return settleProbeResults({
    db,
    selfView,
    page,
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
    now
  })
}

async function resolveCapability(args: {
  runtime: OrcaRuntimeService
  environmentId: string
  expectedRevision: number
  now: number
  capabilityCache: CapabilityCache
}): Promise<boolean> {
  const { runtime, environmentId, expectedRevision, now, capabilityCache } = args
  const capKey = `${environmentId}:${expectedRevision}`
  const cached = capabilityCache.get(capKey)
  if (cached && cached.expiresAt > now) {
    return cached.supported
  }
  try {
    const result = await runtime.callPinnedEnvironment({
      selector: environmentId,
      method: 'status.get',
      params: undefined,
      timeoutMs: LINK_BINDING_RPC_BUDGET_MS,
      maxDurationMs: LINK_BINDING_RPC_BUDGET_MS,
      expectedEnvironmentPairingRevision: expectedRevision,
      requireOrchestrationContract: false
    })
    const capabilities = (result as { capabilities?: string[] } | null)?.capabilities ?? []
    const supported = capabilities.includes(ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY)
    capabilityCache.set(capKey, { supported, expiresAt: now + LINK_BINDING_CAPABILITY_TTL_MS })
    return supported
  } catch {
    capabilityCache.set(capKey, {
      supported: false,
      expiresAt: now + LINK_BINDING_CAPABILITY_TTL_MS
    })
    return false
  }
}
