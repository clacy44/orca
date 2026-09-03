// S10-16 C4c: closes the C4b delta review (s10-16-review-C4b.md) under Ruling 23 Addendum 4 —
// split out of link-binding-prover-round.test.ts (Ruling 23(m): a split is the only remedy for
// the 800-line TEST max-lines gate, no ratchet edit) purely to stay under that gate; it shares
// the exact same fixtures/harness (real DeviceRegistry/E2EE/environment-store, a FAKE responder
// using the SAME production MAC functions) as its sibling file — see that file's own header for
// the harness rationale.
//
// Ruling 23 Addendum 6(ww)/review C4d finding 12: this file's own PROVER-level describe block
// (createLinkBindingProver's scheduleBinding/arm/disarm/stop) was moved out to
// link-binding-prover-c4c.test.ts — a pure move, nothing dropped — to stay under the 800-line
// gate again; this file keeps only the ROUND-level describe block (runOneRound).
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
  LINK_BINDING_SCAN_CONCURRENCY
} from './orchestration/link-binding-constants'
import { ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationError } from './orchestration/orchestration-error'
import { runOneRound, type CapabilityCache, type GuardedProbe } from './link-binding-prover-round'
import {
  roundBudgetMs,
  RoundEpochCounter,
  RearmDebounce
} from './orchestration/link-binding-schedule'
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

  // Ruling 23 Addendum 5(jj)/review C4c finding 1: a genuine two-winner-same-round contest needs
  // TWO environments that both independently prove the SAME link credential (`linkToken`) from
  // DIFFERENT peer keys — but R10-B's credential collapse groups candidates by
  // `hashCallerCredential(deviceToken)`, so they must carry DIFFERENT `deviceToken`s to survive
  // as two separate probe targets. `fakeResponder` (below) hardcodes ONE `observedChannelFp`
  // (`hash(linkToken)`), which only matches a candidate whose OWN `deviceToken` is `linkToken` —
  // so this fixture needs its own responder, parameterised by the environment's real
  // `deviceToken`, computing exactly what `probeOneEnvironment` computes (F1: genuine crypto, no
  // stub return value).
  function saveEnvironmentKnowingCredential(deviceToken: string, key: E2EEKeypair): string {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: `ws://peer-${randomBytes(4).toString('hex')}.example:16768`,
      deviceToken,
      publicKeyB64: key.publicKeyB64
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: `env-${randomBytes(4).toString('hex')}`,
      pairingCode: code
    })
    return env.id
  }

  // Mirrors `fakeResponder`'s `orchestration.federatedLinkProbe`/`status.get` branches exactly,
  // but derives `observedChannelFp` from THIS environment's own `deviceToken` (never a hardcoded
  // `linkToken`) — so it verifies correctly against `probeOneEnvironment`'s real computation for
  // an UNCOLLAPSED candidate whose stored `deviceToken` differs from every other candidate's.
  function credentialResponder(deviceToken: string, key: E2EEKeypair) {
    return vi.fn(async (args: { method: string; params: unknown }) => {
      if (args.method === 'status.get') {
        return { capabilities: [ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY] }
      }
      if (args.method === 'orchestration.federatedLinkConfirm') {
        const p = args.params as { confirms: { slotIndex: number; confirm: string }[] }
        return {
          protocol: 'orca.link-binding.v1',
          acknowledged: p.confirms.map((c) => c.slotIndex)
        }
      }
      if (args.method === 'orchestration.federatedLinkProbe') {
        const p = args.params as {
          probeId: string
          nonceH: string
          epoch: number
          selectors: string[]
        }
        const observedChannelFp = hashCallerCredential(deviceToken)
        const dstKeyFp = fingerprintOrchestrationPeer(key.publicKeyB64)
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
            results.push({ slotIndex: s, matched: true, nonceP, proof })
          }
        }
        return { protocol: 'orca.link-binding.v1', results }
      }
      throw new Error(`unexpected method ${args.method}`)
    })
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
      capabilityCache: capabilityCache ?? new Map(),
      epochCounter: new RoundEpochCounter(),
      rearmDebounce: new RearmDebounce()
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

  it("Ruling 23 Addendum 6(ww)/review C4d finding 6: the round's own clock is anchored to `now`, not real wall-clock skew — a stale `now` alone no longer trips the budget cutoff", async () => {
    // R10.1/Ruling 23 Addendum 4(hh)/review C4b finding 14's ORIGINAL test forced the deadline
    // into the past by starting the round with `now` already stale relative to the real wall
    // clock, asserting an IMMEDIATE cutoff with zero real elapsed time — exactly the (oo)/finding
    // 6 bug (origin skew, not a genuine slow responder) that Ruling 23 Addendum 6(ww) closes.
    // Replaced (declared in the C4e commit body): `probePage`'s `clock` is now wired from
    // `runOneRound` as `now + (Date.now() - wallAtRoundStart)`, so `deadline` (`now +
    // roundBudgetMs`) and the cutoff check share ONE origin — a stale `now` no longer trips it on
    // its own; the sibling test below ("a GENUINELY slow first wave…") proves genuine elapsed
    // time still does.
    const envId = saveNonMatchingEnvironment()
    const calls = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      calls.count += 1
      return fakeResponder({})(args as { method: string; params: unknown })
    })
    const past = Date.now() - 10_000_000
    const outcome = await runOneRound(freshRoundArgs(undefined, undefined, past))
    // The candidate WAS dialled — no origin-skew cutoff — and the round completed normally. Two
    // calls (status.get's capability probe, then federatedLinkProbe itself) for the one
    // environment, an empty capability cache being the first-round default.
    expect(calls.count).toBe(2)
    expect(outcome.completeness).toBe('complete')
    expect(db.getScanFact(linkId, envId)).not.toBeNull()
  })

  it('Ruling 23 Addendum 5(oo)/review C4c finding 7: a GENUINELY slow first wave trips the round budget on a later candidate — one clock, not a pre-expired `now`', async () => {
    vi.useFakeTimers()
    try {
      // More candidates than the pool width — the (SCAN_CONCURRENCY + 1)-th only starts once one
      // of the first SCAN_CONCURRENCY workers frees up, which is exactly where genuinely elapsed
      // time (not a stale `now`) must be observed for the cutoff to fire correctly.
      const envIds = Array.from({ length: LINK_BINDING_SCAN_CONCURRENCY + 1 }, () =>
        saveNonMatchingEnvironment()
      )
      const dialled: string[] = []
      const budgetMs = roundBudgetMs(envIds.length)
      vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
        const a = args as { method: string; selector?: string }
        dialled.push(String(a.selector))
        // Every dial genuinely takes real (simulated) time on the SAME clock (`Date.now`,
        // fake-timer-driven) the round's deadline was computed from — past the budget itself, so
        // by the time any of the first-wave workers frees up, the deadline has GENUINELY elapsed.
        await new Promise((resolve) => setTimeout(resolve, budgetMs + 5_000))
        throw new OrchestrationError('unreachable', 'down')
      })
      const now = Date.now()
      const roundPromise = runOneRound(freshRoundArgs(undefined, undefined, now))
      await vi.advanceTimersByTimeAsync(budgetMs + 10_000)
      const outcome = await roundPromise
      expect(outcome.completeness).toBe('partial')
      // Exactly the pool width was dialled — the (SCAN_CONCURRENCY + 1)-th candidate's turn only
      // came after the budget had genuinely elapsed, so the cutoff correctly stopped it.
      expect(dialled).toHaveLength(LINK_BINDING_SCAN_CONCURRENCY)
    } finally {
      vi.useRealTimers()
    }
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

  it('Ruling 23 Addendum 5(jj)/review C4c finding 1: two winners with different key fingerprints and NO incumbent still write a contested row, excluded from the next round', async () => {
    const keyA = loadOrCreateE2EEKeypair(join(root, 'peer-userdata-a'))
    const keyB = loadOrCreateE2EEKeypair(join(root, 'peer-userdata-b'))
    const tokenA = 'shared-credential-token-a'
    const tokenB = 'shared-credential-token-b'
    const envA = saveEnvironmentKnowingCredential(tokenA, keyA)
    const envB = saveEnvironmentKnowingCredential(tokenB, keyB)
    const respA = credentialResponder(tokenA, keyA)
    const respB = credentialResponder(tokenB, keyB)
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; params: unknown; selector?: string }
      if (a.selector === envA) {
        return respA(a)
      }
      if (a.selector === envB) {
        return respB(a)
      }
      throw new Error(`unexpected selector ${String(a.selector)}`)
    })

    // No incumbent — this link has never had a `peer_link_bindings` row.
    expect(db.getPeerLinkBinding(linkId)).toBeNull()

    const now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))

    const binding = db.getPeerLinkBinding(linkId)
    expect(binding?.state).toBe('contested')
    expect(binding?.contestIncidentId).not.toBeNull()
    const incidentId = binding?.contestIncidentId
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('contested')
    // Exactly one contested audit row — one incident id.
    const auditRows = rawDb(db)
      .prepare(
        "SELECT reason_code FROM agent_audit WHERE verb = 'linkBinding' AND outcome = 'contested'"
      )
      .all() as { reason_code: string }[]
    expect(auditRows).toHaveLength(1)
    const reason = JSON.parse(auditRows[0]?.reason_code ?? '{}') as { incidentId?: string }
    expect(reason.incidentId).toBe(incidentId)

    // Excluded from the next round — `binding.state === 'contested'` now has a row to key on.
    const outcome = await runOneRound(freshRoundArgs(undefined, undefined, now + 3_600_000))
    expect(outcome.evaluatedLinkIds).not.toContain(linkId)
    // Unchanged by the exclusion — the row (and its incident id) is durable.
    expect(db.getPeerLinkBinding(linkId)?.contestIncidentId).toBe(incidentId)

    // Excluded from every kick too — `scheduleBinding` reads the same binding row.
    vi.useFakeTimers()
    const prover = createLinkBindingProver(runtime)
    const before = db.getBindingAttempt(linkId)
    prover.scheduleBinding(linkId, 'inbound_contact')
    expect(db.getBindingAttempt(linkId)).toEqual(before)
    await vi.advanceTimersByTimeAsync(20_000)
    prover.stop()
    vi.useRealTimers()
  })
})
