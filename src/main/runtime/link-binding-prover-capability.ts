// S10-16 C4d, R10.3 (design v6) + Ruling 23 Addendum 5(qq): the capability check + cache, split
// out of link-binding-prover-probe.ts (Ruling 23(m) pattern: probe.ts is the file that grows —
// review C4c finding 8/Ruling 23 Addendum 5(qq) — so this is new code, not a move: the cache's
// `reason` field and the `CapabilityResolution` split are C4d additions, closing review C4c
// finding 3/Ruling 23 Addendum 5(ll)). `probeOneEnvironment` is the only caller.
import type { OrcaRuntimeService } from './orca-runtime'
import {
  LINK_BINDING_RPC_BUDGET_MS,
  LINK_BINDING_CAPABILITY_TTL_MS
} from './orchestration/link-binding-constants'
import { ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

// Ruling 23 Addendum 5(ll): `reason` rides the cache too, so a cache HIT reports the same
// `'absent'`/`'peer_self_view'` distinction a cache MISS would have derived fresh — a peer's
// `capability_unsupported` self-report must keep writing `unavailable`/capability_unsupported
// scan facts for the life of the cache entry, not just on the round that first observed it.
type CapabilityCacheEntry = {
  supported: boolean
  expiresAt: number
  reason: 'absent' | 'peer_self_view' | null
}
export type CapabilityCache = Map<string, CapabilityCacheEntry>

// Ruling 23 Addendum 5(ll): the reason `resolveCapability` reported `supported: false` — needed
// only by the caller's scan-fact write (`'absent'` -> `'unsupported'`, `'peer_self_view'` ->
// `'unavailable'`/`capability_unsupported`). `null` whenever `supported` is `true`.
export type CapabilityResolution = {
  supported: boolean
  reason: 'absent' | 'peer_self_view' | null
}

export async function resolveCapability(args: {
  runtime: OrcaRuntimeService
  environmentId: string
  expectedRevision: number
  now: number
  capabilityCache: CapabilityCache
}): Promise<CapabilityResolution> {
  const { runtime, environmentId, expectedRevision, now, capabilityCache } = args
  const capKey = `${environmentId}:${expectedRevision}`
  const cached = capabilityCache.get(capKey)
  if (cached && cached.expiresAt > now) {
    // The cache carries `reason` alongside `supported` (see the type above) so a cache HIT
    // reports the same distinction a cache MISS would have derived fresh.
    return { supported: cached.supported, reason: cached.reason }
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
    const reason: CapabilityResolution['reason'] = supported ? null : 'absent'
    capabilityCache.set(capKey, {
      supported,
      reason,
      expiresAt: now + LINK_BINDING_CAPABILITY_TTL_MS
    })
    return { supported, reason }
  } catch (error) {
    // F5/Ruling 23(u): only a GENUINE capability-unsupported answer (an old peer that does not
    // recognise the method) is cached. Every other error (transport, rate limit, local queue
    // saturation) is peer/network-attributable, is never a capability answer, and must never be
    // cached — it is rethrown so the caller routes it through settleProbeFailure's full mapping.
    // Ruling 23 Addendum 5(ll) (settling C4c finding 3, ex-Ruling 23 Addendum 4(ee)): TWO
    // REGISTERS, no contradiction. THIS branch governs the CAPABILITY CACHE (clause (u): "caches
    // ONLY a genuine capability_unsupported") — caching `method_not_found`/`capability_unsupported`
    // here only skips a redundant `status.get` call next round; the cache never distinguishes WHY
    // a capability is absent. The persisted SCAN-FACT outcome is the caller's own decision
    // (`probeOneEnvironment`'s `!capability.supported` branch), keyed on the `reason` this
    // function returns: `method_not_found` is `'absent'` (never propagated as a wire code —
    // `unsupported`); `capability_unsupported` is `'peer_self_view'` (the peer's own self-report
    // — `unavailable`, matching `settleProbeFailure`'s identical mapping for the same code thrown
    // by the probe RPC itself, in link-binding-prover-outcome.ts). Both registers stand; this is
    // not a code change to either.
    const code = error instanceof Error && 'code' in error ? (error as { code: string }).code : null
    if (code === 'method_not_found' || code === 'capability_unsupported') {
      const reason: CapabilityResolution['reason'] =
        code === 'capability_unsupported' ? 'peer_self_view' : 'absent'
      capabilityCache.set(capKey, {
        supported: false,
        reason,
        expiresAt: now + LINK_BINDING_CAPABILITY_TTL_MS
      })
      return { supported: false, reason }
    }
    capabilityCache.delete(capKey)
    throw error
  }
}
