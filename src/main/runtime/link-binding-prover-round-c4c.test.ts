// S10-16 C4c: closes the C4b delta review (s10-16-review-C4b.md) under Ruling 23 Addendum 4 —
// split out of link-binding-prover-round.test.ts (Ruling 23(m): a split is the only remedy for
// the 800-line TEST max-lines gate, no ratchet edit) purely to stay under that gate; it shares
// the exact same fixtures/harness (real DeviceRegistry/E2EE/environment-store, a FAKE responder
// using the SAME production MAC functions) as its sibling file — see that file's own header for
// the harness rationale.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import { DeviceRegistry } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import { createLinkBindingSelfView } from './device-registry-link-credential'
import { hashCallerCredential } from './principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'
import { SELECTOR_LABEL, PROOF_LABEL, linkBindingMac } from './orchestration/link-binding-proof'
import {
  LINK_BINDING_UNPAIRED_PARK_ROUNDS,
  LINK_BINDING_PARK_REARM_MS,
  LINK_BINDING_STARTUP_DELAY_MS,
  LINK_BINDING_SWEEP_MS
} from './orchestration/link-binding-constants'
import { ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationError } from './orchestration/orchestration-error'
import { runOneRound, type CapabilityCache, type GuardedProbe } from './link-binding-prover-round'
import { createLinkBindingProver } from './link-binding-prover'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

// Raw sqlite access for asserting agent_audit rows directly — matches the pattern in
// agent-thread-succession.test.ts.
function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('S10-16 C4c: review C4b closure — round-level (Ruling 23 Addendum 4)', () => {
  let root: string
  let userDataPath: string
  let deviceRegistry: DeviceRegistry
  let e2ee: E2EEKeypair
  // The environment's own public key is a DIFFERENT host's key (the peer H is proving against) —
  // never H's own. Reusing e2ee.publicKeyB64 here would make R10-B's loopback filter exclude
  // every fixture environment (it is keyed on the SAME check the round itself runs).
  let peerE2ee: E2EEKeypair
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let linkId: string
  let linkToken: string

  function saveMatchingEnvironment(): string {
    // "Coalesced": this saved environment's own endpoint deviceToken is EXACTLY the verifier's
    // registry token for the link — the property that makes T_in known to both sides (R6).
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken: linkToken,
      publicKeyB64: peerE2ee.publicKeyB64
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: `env-${randomBytes(4).toString('hex')}`,
      pairingCode: code
    })
    return env.id
  }

  function saveNonMatchingEnvironment(): string {
    // A distinct deviceToken per call — R10-B's credential collapse groups candidate
    // environments by peer_credential_fp (derived from this token), so callers that need
    // MULTIPLE surviving (uncollapsed) candidates must vary it.
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://other.example:16768',
      deviceToken: `not-the-link-token-${randomBytes(8).toString('hex')}`,
      publicKeyB64: peerE2ee.publicKeyB64
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: `env-${randomBytes(4).toString('hex')}`,
      pairingCode: code
    })
    return env.id
  }

  // Fakes the responder side of `orchestration.federatedLinkProbe`, using the SAME production
  // MAC functions probe.ts uses, so a match is a genuine cryptographic verification, not a stub
  // return value. `overrides.throwWith` simulates a peer refusal; `overrides.supported=false`
  // simulates an old peer with no link-binding capability.
  function fakeResponder(overrides: {
    throwWith?: OrchestrationError
    supported?: boolean
    probeCallCounter?: { count: number }
    confirmCallCounter?: { count: number }
    // Answers `peer_duplicate` for every slotIndex named here, instead of a real proof.
    peerDuplicateSlots?: number[]
    // R10-E: a well-behaved peer acknowledges every confirm slot it is sent by default — set
    // this to simulate a refused/empty confirm (the R10-E failure path).
    confirmAcknowledgeNone?: boolean
    confirmThrowWith?: OrchestrationError
    // C-9/R11.5: attaches this advisory to every `orchestration.federatedLinkProbe` answer.
    advisory?: { kind: 'link_contested' | 'link_quarantined'; incidentId: string }
    // F1: the E2EE key this fake responder answers as — defaults to the describe-level `peerE2ee`.
    // Lets a test simulate a SECOND distinct peer key answering the same link credential.
    key?: E2EEKeypair
  }) {
    return vi.fn(async (args: { method: string; params: unknown }) => {
      if (args.method === 'status.get') {
        return {
          capabilities:
            overrides.supported === false ? [] : [ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY]
        }
      }
      if (args.method === 'orchestration.federatedLinkConfirm') {
        if (overrides.confirmCallCounter) {
          overrides.confirmCallCounter.count += 1
        }
        if (overrides.confirmThrowWith) {
          throw overrides.confirmThrowWith
        }
        const p = args.params as { confirms: { slotIndex: number; confirm: string }[] }
        return {
          protocol: 'orca.link-binding.v1',
          acknowledged: overrides.confirmAcknowledgeNone ? [] : p.confirms.map((c) => c.slotIndex)
        }
      }
      if (args.method === 'orchestration.federatedLinkProbe') {
        if (overrides.probeCallCounter) {
          overrides.probeCallCounter.count += 1
        }
        if (overrides.throwWith) {
          throw overrides.throwWith
        }
        const p = args.params as {
          probeId: string
          nonceH: string
          epoch: number
          selectors: string[]
        }
        if (overrides.peerDuplicateSlots) {
          // F13/R10.4: slot order is shuffled per probe (Fisher-Yates, `Math.random`-driven) — a
          // fixture that fabricates a duplicate claim independent of any real MAC match (the
          // responder's `peer_duplicate` answer is trusted without verification on this host, by
          // design — F12) still needs to name a REAL slot index. Callers pin `Math.random` (see
          // the test below) so the shuffle is the identity permutation and slot i === page[i].
          return {
            protocol: 'orca.link-binding.v1',
            results: overrides.peerDuplicateSlots.map((slotIndex) => ({
              slotIndex,
              matched: false,
              reason: 'peer_duplicate'
            }))
          }
        }
        const observedChannelFp = hashCallerCredential(linkToken)
        const dstKeyFp = fingerprintOrchestrationPeer((overrides.key ?? peerE2ee).publicKeyB64)
        const results: unknown[] = []
        for (let s = 0; s < p.selectors.length; s += 1) {
          const expected = linkBindingMac(linkToken, SELECTOR_LABEL, [
            p.probeId,
            p.nonceH,
            String(s),
            String(p.epoch),
            observedChannelFp,
            dstKeyFp
          ])
          if (expected === p.selectors[s]) {
            const nonceP = randomBytes(32).toString('hex')
            const proof = linkBindingMac(linkToken, PROOF_LABEL, [
              p.probeId,
              p.nonceH,
              String(s),
              String(p.epoch),
              observedChannelFp,
              dstKeyFp,
              nonceP
            ])
            results.push({
              slotIndex: s,
              matched: true,
              nonceP,
              proof,
              observedChannelFp,
              peerKeyFingerprint: dstKeyFp
            })
          }
        }
        return {
          protocol: 'orca.link-binding.v1',
          results,
          ...(overrides.advisory ? { advisory: overrides.advisory } : {})
        }
      }
      throw new Error(`unexpected method ${args.method}`)
    })
  }

  const passthroughGuardedProbe: GuardedProbe = (_envId, _maxMs, run) => run()

  function freshRoundArgs(
    guardedProbe?: GuardedProbe,
    capabilityCache?: CapabilityCache,
    now?: number,
    mode: 'sweep' | 'contest_search' = 'sweep'
  ) {
    return {
      runtime,
      mode,
      now: now ?? Date.now(),
      wanted: new Set<string>(),
      guardedProbe: guardedProbe ?? passthroughGuardedProbe,
      capabilityCache: capabilityCache ?? new Map()
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-link-binding-prover-round-'))
    userDataPath = join(root, 'userdata')
    appState.userData = userDataPath
    deviceRegistry = new DeviceRegistry(userDataPath)
    const link = deviceRegistry.mintPendingDevice('home', 'runtime')
    linkId = link.deviceId
    linkToken = link.token
    deviceRegistry.updateLastSeen(linkId) // R10-A requires lastSeenAt !== 0 to be a candidate.
    e2ee = loadOrCreateE2EEKeypair(userDataPath)
    peerE2ee = loadOrCreateE2EEKeypair(join(root, 'peer-userdata'))
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.setLinkBindingSelfView(
      createLinkBindingSelfView(deviceRegistry, () => e2ee.publicKeyB64)
    )
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('F13/R10.4/review C4b finding 13&15: slot order is shuffled per probe — a single link is not pinned to one stable slot index across rounds', async () => {
    saveMatchingEnvironment()
    const seenSlots = new Set<number>()
    const baseResponder = fakeResponder({})
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; params: unknown }
      const answer = await baseResponder(a)
      if (a.method === 'orchestration.federatedLinkProbe') {
        const r = answer as { results: { slotIndex: number }[] }
        for (const entry of r.results) {
          seenSlots.add(entry.slotIndex)
        }
      }
      return answer
    })
    let now = Date.now()
    // A 'proven' fact is re-probed every sweep round (never cache-skipped) — 2 probe calls/round
    // (scan pass + R10-E re-probe), 20 rounds = 40 samples of the shuffle.
    for (let i = 0; i < 20; i += 1) {
      await runOneRound(freshRoundArgs(undefined, undefined, now))
      now += 120_000
    }
    // Landing on the SAME slot all 40 times has probability (1/8)^39 — more than one distinct
    // slot index is observed.
    expect(seenSlots.size).toBeGreaterThan(1)
  })

  it('F5/Ruling 23(u)/review C4b finding 8: a shared CapabilityCache never caches a rate-limited status.get failure across rounds', async () => {
    const envId = saveMatchingEnvironment()
    const statusCalls = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string }
      if (a.method === 'status.get') {
        statusCalls.count += 1
        throw new OrchestrationError('rate_limited', 'too fast')
      }
      throw new Error(`unexpected method ${a.method}`)
    })
    const sharedCache: CapabilityCache = new Map()
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, sharedCache, now))
    expect(statusCalls.count).toBe(1)
    expect(db.getScanFact(linkId, envId)?.outcome).toBe('unavailable')
    expect(db.getScanFact(linkId, envId)?.detail).toBe('rate_limited')
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, sharedCache, now))
    // The SAME CapabilityCache instance is reused across rounds — round 2 must still call
    // status.get (never cached as `unsupported`, which would suppress the call entirely).
    expect(statusCalls.count).toBe(2)
    expect(db.getScanFact(linkId, envId)?.outcome).toBe('unavailable')
    expect(db.getScanFact(linkId, envId)?.detail).toBe('rate_limited')
  })

  it('review C4b finding 11/Ruling 23 Addendum 4(hh): worstEnvironmentOutcome scopes to environments actually attempted THIS round — a busy environment cannot leak a stale fact in', async () => {
    const envX = saveNonMatchingEnvironment()
    const envY = saveNonMatchingEnvironment()
    let now = Date.now()
    // Round 1: envX -> unavailable(rate_limited) [HIGHER WORST_OUTCOME_PRIORITY rank than
    // unreachable], envY -> unreachable.
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; selector?: string }
      if (a.method === 'status.get') {
        return { capabilities: [ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY] }
      }
      if (a.method === 'orchestration.federatedLinkProbe') {
        if (a.selector === envX) {
          throw new OrchestrationError('rate_limited', 'slow')
        }
        throw new OrchestrationError('unreachable', 'down')
      }
      throw new Error('unexpected')
    })
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(db.getScanFact(linkId, envX)?.outcome).toBe('unavailable')
    expect(db.getScanFact(linkId, envY)?.outcome).toBe('unreachable')

    // Round 2: envX is BUSY (in-flight guard) — no fresh fact is written for it this round;
    // envY answers unreachable again.
    now += 120_000
    const busyForX: GuardedProbe = async (environmentId, _maxDurationMs, run) => {
      if (environmentId === envX) {
        return 'busy'
      }
      return run()
    }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string }
      if (a.method === 'status.get') {
        return { capabilities: [ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY] }
      }
      if (a.method === 'orchestration.federatedLinkProbe') {
        throw new OrchestrationError('unreachable', 'down')
      }
      throw new Error('unexpected')
    })
    await runOneRound(freshRoundArgs(busyForX, undefined, now))
    // Fixed behavior: the worst outcome is derived ONLY from envY's fresh 'unreachable' fact —
    // envX's stale round-1 'unavailable' fact (a higher rank) must never leak in.
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unreachable')
  })

  it('F18/review C4b finding 18: a link device row vanishing mid-round refuses the scan-fact write rather than pinning it to an empty fingerprint', async () => {
    const envId = saveMatchingEnvironment()
    const baseResponder = fakeResponder({})
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; params: unknown }
      if (a.method === 'orchestration.federatedLinkProbe') {
        // Simulate the device row vanishing (re-pair/removal) DURING this round's own RPC call —
        // the candidate list was already built at round start.
        deviceRegistry.removeDevice(linkId)
      }
      return baseResponder(a)
    })
    await runOneRound(freshRoundArgs())
    expect(db.getScanFact(linkId, envId)).toBeNull()
  })

  it('F15/review C4b finding 18: a shape-valid matched:true response with a BAD proof is protocol_violation, never unreachable', async () => {
    const envId = saveMatchingEnvironment()
    const baseResponder = fakeResponder({})
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; params: unknown }
      const answer = await baseResponder(a)
      if (a.method === 'orchestration.federatedLinkProbe') {
        const r = answer as {
          protocol: string
          results: { slotIndex: number; matched: boolean; proof?: string }[]
        }
        return {
          ...r,
          results: r.results.map((entry) =>
            entry.matched ? { ...entry, proof: 'f'.repeat(64) } : entry
          )
        }
      }
      return answer
    })
    await runOneRound(freshRoundArgs())
    expect(db.getScanFact(linkId, envId)?.outcome).toBe('protocol_violation')
    expect(db.getPeerLinkBinding(linkId)).toBeNull()
  })

  it('F8/R11.3/review C4b finding 18: a same-key rebind writes a link_binding_rebound audit row naming both environments', async () => {
    const envA = saveMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(db.getPeerLinkBinding(linkId)?.environmentId).toBe(envA)

    db.putContainment({
      subjectKind: 'environment',
      subjectId: envA,
      action: 'scan_exclude',
      reasonCode: 'test',
      reasonText: null,
      detail: null,
      createdAt: now,
      expiresAt: null
    })
    const envB = saveMatchingEnvironment()
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    const binding = db.getPeerLinkBinding(linkId)
    expect(binding?.environmentId).toBe(envB)
    expect(binding?.state).toBe('confirmed')
    const auditRows = rawDb(db)
      .prepare(
        "SELECT reason_code FROM agent_audit WHERE verb = 'linkBinding' AND outcome = 'link_binding_rebound'"
      )
      .all() as { reason_code: string }[]
    expect(auditRows).toHaveLength(1)
    const reason = JSON.parse(auditRows[0]?.reason_code ?? '{}') as {
      fromEnvironmentId?: string
      toEnvironmentId?: string
    }
    expect(reason.fromEnvironmentId).toBe(envA)
    expect(reason.toEnvironmentId).toBe(envB)
  })

  it('finding 7/Ruling 23 Addendum 4(ff): repeated rebounds within one rate window are metered to ONE agent_audit row', async () => {
    const envA = saveMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    const envB = saveMatchingEnvironment()

    db.putContainment({
      subjectKind: 'environment',
      subjectId: envA,
      action: 'scan_exclude',
      reasonCode: 'test',
      reasonText: null,
      detail: null,
      createdAt: now,
      expiresAt: null
    })
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now)) // rebind A -> B, audit row #1
    expect(db.getPeerLinkBinding(linkId)?.environmentId).toBe(envB)

    db.liftContainment('environment', envA, 'scan_exclude', now)
    db.putContainment({
      subjectKind: 'environment',
      subjectId: envB,
      action: 'scan_exclude',
      reasonCode: 'test',
      reasonText: null,
      detail: null,
      createdAt: now,
      expiresAt: null
    })
    now += 120_000
    // The metering key is real wall-clock time (checkAndBumpRate uses Date.now(), not the
    // round's synthetic `now`) — this call lands milliseconds after the first in REAL time, well
    // inside the same LINK_BINDING_RATE_WINDOW_MS window regardless of `now`'s advance.
    await runOneRound(freshRoundArgs(undefined, undefined, now)) // rebind B -> A, audit row METERED OUT
    expect(db.getPeerLinkBinding(linkId)?.environmentId).toBe(envA)

    const auditRows = rawDb(db)
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_audit WHERE verb = 'linkBinding' AND outcome = 'link_binding_rebound'"
      )
      .get() as { n: number }
    expect(auditRows.n).toBe(1)
  })

  it('R10.1/Ruling 23 Addendum 4(hh)/review C4b finding 14: a round that exceeds its budget ends partial', async () => {
    // roundBudgetMs(1) = ceil(1/SCAN_CONCURRENCY) * CANDIDATE_BUDGET_MS, always > 0 — the test
    // forces the deadline into the PAST by starting the round with `now` already stale relative
    // to the real wall clock, so the worker pool's very first deadline check trips before any
    // candidate is dialled.
    const envId = saveNonMatchingEnvironment()
    const calls = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      calls.count += 1
      return fakeResponder({})(args as { method: string; params: unknown })
    })
    const past = Date.now() - 10_000_000
    const outcome = await runOneRound(freshRoundArgs(undefined, undefined, past))
    expect(outcome.completeness).toBe('partial')
    // No environment was actually dialled — the round-budget cutoff fired before the first probe.
    expect(calls.count).toBe(0)
    expect(db.getScanFact(linkId, envId)).toBeNull()
  })

  it('finding 4/Ruling 23 Addendum 4(cc): the register-timer fallback re-arms a park that never receives inbound contact, after LINK_BINDING_PARK_REARM_MS', async () => {
    saveNonMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    let now = Date.now()
    for (let i = 0; i < LINK_BINDING_UNPAIRED_PARK_ROUNDS; i += 1) {
      await runOneRound(freshRoundArgs(undefined, undefined, now))
      now += 120_000
    }
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unpaired_parked')
    const parkedAt = db.getBindingAttempt(linkId)?.lastAttemptAt ?? 0

    // Well short of the fallback threshold — no scheduleBinding call is ever made (simulating a
    // link that never contacts again) — the park holds.
    now = parkedAt + LINK_BINDING_PARK_REARM_MS - 1_000
    let outcome = await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(outcome.evaluatedLinkIds).not.toContain(linkId)
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unpaired_parked')

    // Past the fallback threshold — the ROUND ITSELF re-arms the park (the register-timer
    // fallback, distinct from scheduleBinding's first-inbound-contact immediate re-arm) and
    // evaluates the link again this same round.
    now = parkedAt + LINK_BINDING_PARK_REARM_MS + 1_000
    outcome = await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(outcome.evaluatedLinkIds).toContain(linkId)
  })
})

describe('S10-16 C4c: review C4b closure — prover-level (Ruling 23 Addendum 4)', () => {
  let root: string
  let userDataPath: string
  let deviceRegistry: DeviceRegistry
  let e2ee: E2EEKeypair
  let peerE2ee: E2EEKeypair
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let linkId: string

  beforeEach(() => {
    vi.useFakeTimers()
    root = mkdtempSync(join(tmpdir(), 'orca-link-binding-prover-'))
    userDataPath = join(root, 'userdata')
    appState.userData = userDataPath
    deviceRegistry = new DeviceRegistry(userDataPath)
    const link = deviceRegistry.mintPendingDevice('home', 'runtime')
    linkId = link.deviceId
    deviceRegistry.updateLastSeen(linkId)
    e2ee = loadOrCreateE2EEKeypair(userDataPath)
    peerE2ee = loadOrCreateE2EEKeypair(join(root, 'peer-userdata'))
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.setLinkBindingSelfView(
      createLinkBindingSelfView(deviceRegistry, () => e2ee.publicKeyB64)
    )
    vi.spyOn(runtime, 'callPinnedEnvironment').mockResolvedValue({ capabilities: [] })
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('finding 2/Ruling 23 Addendum 4(aa): scheduleBinding is a total no-op for a contested link — no schedule write, no wanted, no kick', async () => {
    db.putPeerLinkBinding({
      linkDeviceId: linkId,
      environmentId: 'env-x',
      boundEndpointId: 'ep-x',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    db.contestPeerLinkBinding(linkId, 0, 'incident-1', 'contest detail')
    const before = db.getBindingAttempt(linkId)
    const prover = createLinkBindingProver(runtime)
    prover.scheduleBinding(linkId, 'inbound_contact')
    // No schedule write — putBindingAttempt/settleBindingAttempt were never reached.
    expect(db.getBindingAttempt(linkId)).toEqual(before)
    // No kick — even well past the debounce window, no round ever started.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(runtime.callPinnedEnvironment).not.toHaveBeenCalled()
    prover.stop()
  })

  it("finding 3/Ruling 23 Addendum 4(bb): a kick never runs the round's synchronous prefix on the caller's own stack", () => {
    db.putBindingAttempt(linkId)
    const prover = createLinkBindingProver(runtime)
    prover.scheduleBinding(linkId, 'inbound_contact')
    // Synchronously, immediately after scheduleBinding returns — R8.6: no round has started yet.
    expect(runtime.callPinnedEnvironment).not.toHaveBeenCalled()
    prover.stop()
  })

  it('F19: the leading-edge kick debounce suppresses a second round start within LINK_BINDING_KICK_DEBOUNCE_MS', async () => {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken: 'irrelevant-to-this-test',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-debounce-test', pairingCode: code })
    db.putBindingAttempt(linkId)
    // Already overdue — scheduleBindingPatch's floor-clamp takes min(current, floor), so this
    // stays in the past and the link is not excluded from its own kicked round's candidate list.
    db.settleBindingAttempt(linkId, {
      lastAttemptAt: 0,
      lastRoundAt: 0,
      lastOutcome: 'pending',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: Date.now() - 1_000
    })
    const prover = createLinkBindingProver(runtime)
    const mock = runtime.callPinnedEnvironment as unknown as { mock: { calls: unknown[][] } }
    prover.scheduleBinding(linkId, 'inbound_contact')
    await vi.advanceTimersByTimeAsync(50) // let the deferred (setTimeout 0) round fire and settle
    const firstCount = mock.mock.calls.length
    expect(firstCount).toBeGreaterThan(0)
    prover.scheduleBinding(linkId, 'inbound_contact') // still inside the debounce window
    await vi.advanceTimersByTimeAsync(50)
    expect(mock.mock.calls.length).toBe(firstCount)
    prover.stop()
  })

  it('finding 4/Ruling 23 Addendum 4(cc): the FIRST inbound contact after a park re-arms IMMEDIATELY — no elapsed-time gate', () => {
    db.putBindingAttempt(linkId)
    db.settleBindingAttempt(linkId, {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'unpaired_parked',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: LINK_BINDING_UNPAIRED_PARK_ROUNDS,
      nextAttemptAfter: null
    })
    const prover = createLinkBindingProver(runtime)
    // No time advance at all — the prior `>= LINK_BINDING_PARK_REARM_MS` gate would have refused
    // this (finding 4's original bug); the fix re-arms on the very next inbound contact.
    prover.scheduleBinding(linkId, 'inbound_contact')
    const attempt = db.getBindingAttempt(linkId)
    expect(attempt?.lastOutcome).toBe('pending')
    expect(attempt?.consecutiveNoWinner).toBe(0)
    prover.stop()
  })

  it('finding 16/R13 trigger table: an environment-set change re-arms parked links', async () => {
    const code1 = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer1.example:16768',
      deviceToken: 'irrelevant-1',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-digest-1', pairingCode: code1 })
    db.putBindingAttempt(linkId)
    db.settleBindingAttempt(linkId, {
      lastAttemptAt: Date.now(),
      lastRoundAt: Date.now(),
      lastOutcome: 'unpaired_parked',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: LINK_BINDING_UNPAIRED_PARK_ROUNDS,
      nextAttemptAfter: null
    })
    const prover = createLinkBindingProver(runtime)
    prover.arm()
    // First tick (the startup timer): no baseline digest exists yet, so this ONLY establishes
    // one — it must never fire a spurious re-arm on its own.
    await vi.advanceTimersByTimeAsync(LINK_BINDING_STARTUP_DELAY_MS)
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unpaired_parked')

    const code2 = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer2.example:16768',
      deviceToken: 'irrelevant-2',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-digest-2', pairingCode: code2 })
    // Next sweep tick: the digest changed — the park is re-armed BEFORE this tick's own round
    // runs, so it is no longer `unpaired_parked` by the time this settles.
    await vi.advanceTimersByTimeAsync(LINK_BINDING_SWEEP_MS)
    expect(db.getBindingAttempt(linkId)?.lastOutcome).not.toBe('unpaired_parked')
    prover.stop()
  })

  it('finding 14/R13.4: sweep-owned deletion purges bindings/attempts for a link no longer in the device registry', async () => {
    const orphanId = 'orphan-device-id'
    db.putPeerLinkBinding({
      linkDeviceId: orphanId,
      environmentId: 'env-orphan',
      boundEndpointId: 'ep-orphan',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    db.putBindingAttempt(orphanId)
    expect(db.getPeerLinkBinding(orphanId)).not.toBeNull()

    const prover = createLinkBindingProver(runtime)
    prover.arm()
    await vi.advanceTimersByTimeAsync(LINK_BINDING_STARTUP_DELAY_MS)
    expect(db.getPeerLinkBinding(orphanId)).toBeNull()
    expect(db.getBindingAttempt(orphanId)).toBeNull()
    prover.stop()
  })
})
