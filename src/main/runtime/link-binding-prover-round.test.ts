// S10-16 C4: the verifier scan round, driven through the REAL DeviceRegistry/E2EE/environment-
// store fixtures (matching link-binding-handshake.test.ts's own C3 harness) against a FAKE
// responder — `runtime.callPinnedEnvironment` answers the exact wire shape a genuine peer
// answers with (array results, slotIndex attribution), computed via the SAME production MAC
// functions the real responder uses, so a "coalesced" saved environment (endpoint.deviceToken ===
// the verifier's own registry token for the link) is a genuine cryptographic match, not a stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DeviceRegistry } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import { createLinkBindingSelfView } from './device-registry-link-credential'
import { hashCallerCredential } from './principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from './orchestration/environment-transport'
import { SELECTOR_LABEL, PROOF_LABEL, linkBindingMac } from './orchestration/link-binding-proof'
import {
  LINK_BINDING_MAX_ROUNDS_PER_MIN,
  LINK_BINDING_UNPAIRED_PARK_ROUNDS,
  LINK_BINDING_SCAN_CONCURRENCY
} from './orchestration/link-binding-constants'
import { ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationError } from './orchestration/orchestration-error'
import { runOneRound, type CapabilityCache, type GuardedProbe } from './link-binding-prover-round'
import { createLinkBindingProver } from './link-binding-prover'
import type * as RuntimeEnvironmentStoreModule from '../../shared/runtime-environment-store'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

// F6: a controllable fault injection for `listEnvironments` — a real throw (store file present
// but corrupt/unreadable), distinct from the module's own legitimate empty-store return.
const environmentStoreFault = { throwing: false }
vi.mock('../../shared/runtime-environment-store', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeEnvironmentStoreModule>()
  return {
    ...actual,
    listEnvironments: (userDataPath: string) => {
      if (environmentStoreFault.throwing) {
        throw new Error('store unreadable')
      }
      return actual.listEnvironments(userDataPath)
    }
  }
})

describe('S10-16 C4: link-binding-prover-round / link-binding-prover', () => {
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

  // F1: a coalesced fixture with a DIFFERENT peer key than the describe-level `peerE2ee` — used
  // to simulate a second holder of the same link credential (T_in) answering from an environment
  // this host has never bound before.
  function saveMatchingEnvironmentWithKey(key: E2EEKeypair): string {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer-b.example:16768',
      deviceToken: linkToken,
      publicKeyB64: key.publicKeyB64
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

  it('a clean single-winner round writes ONE peer_link_bindings row and settles last_outcome=proven', async () => {
    saveMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    const outcome = await runOneRound(freshRoundArgs())
    expect(outcome.evaluatedLinkIds).toContain(linkId)
    const binding = db.getPeerLinkBinding(linkId)
    expect(binding).not.toBeNull()
    expect(binding?.state).toBe('confirmed')
    const attempt = db.getBindingAttempt(linkId)
    expect(attempt?.lastOutcome).toBe('proven')
    expect(attempt?.consecutiveNoWinner).toBe(0)
  })

  it('no matching environment -> unpaired; three attempted no-winner rounds park the link (R13.3)', async () => {
    saveNonMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    // R10-A excludes a candidate whose own next_attempt_after is still in the future — each round
    // writes a fresh backoff BEFORE dialing (R13.2), so successive rounds must advance `now` past
    // it (a real sweep tick or kick would do this naturally; here it is explicit).
    let now = Date.now()
    for (let i = 0; i < LINK_BINDING_UNPAIRED_PARK_ROUNDS - 1; i += 1) {
      await runOneRound(freshRoundArgs(undefined, undefined, now))
      expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unpaired')
      now += 120_000
    }
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unpaired_parked')
  })

  it('Ruling 23(e): a peer_duplicate outcome NEVER advances the park counter, across many rounds (design test 7, inverted)', async () => {
    saveNonMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ peerDuplicateSlots: [0] })
    )
    let now = Date.now()
    for (let i = 0; i < LINK_BINDING_UNPAIRED_PARK_ROUNDS + 2; i += 1) {
      await runOneRound(freshRoundArgs(undefined, undefined, now))
      expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('peer_duplicate')
      now += 120_000
    }
    expect(db.getBindingAttempt(linkId)?.consecutiveNoWinner).toBe(0)
    expect(db.getBindingAttempt(linkId)?.lastOutcome).not.toBe('unpaired_parked')
  })

  it('a stalled (busy in-flight) candidate is excluded from the park test — R10.2/L3', async () => {
    saveNonMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    const alwaysBusy: GuardedProbe = async () => 'busy'
    for (let i = 0; i < LINK_BINDING_UNPAIRED_PARK_ROUNDS + 2; i += 1) {
      await runOneRound(freshRoundArgs(alwaysBusy))
    }
    expect(db.getBindingAttempt(linkId)?.consecutiveNoWinner).toBe(0)
    expect(db.getBindingAttempt(linkId)?.lastOutcome).not.toBe('unpaired_parked')
  })

  it('link_store_empty maps to a scan fact of unavailable under normal backoff, and is not re-probed inside the TTL (sweep mode)', async () => {
    const envId = saveMatchingEnvironment()
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({
        throwWith: new OrchestrationError('link_store_empty', 'empty'),
        probeCallCounter: counter
      })
    )
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(1)
    const fact = db.getScanFact(linkId, envId)
    expect(fact?.outcome).toBe('unavailable')

    // A second sweep round, past R10-A's own backoff but well inside the fact's 24h TTL, still
    // does not re-probe — the live cached fact skips it (R12.1(1)).
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(1)
  })

  it('a cached fact never satisfies a contest_search round — the cache is bypassed entirely (R12.1(2))', async () => {
    // F2/Ruling 23(z): the fact cache is now GATED ON OUTCOME — only `no_match` (and
    // `unavailable`/`link_store_empty`, and `unsupported`) are TTL-cacheable; `proven` is
    // re-probed every round (R12.2's table: "every round — it is the winner"), so a `no_match`
    // fixture is what actually exercises R12.1(2)'s sweep-vs-contest_search cache distinction.
    saveNonMatchingEnvironment()
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ probeCallCounter: counter })
    )
    let now = Date.now()
    // Round 1 (sweep): no live fact yet -> one fresh scan-pass probe. No winner, so no R10-E
    // re-probe.
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(1)
    now += 120_000 // past R10-A's own backoff exclusion, still well inside the 24h fact TTL.
    // Round 2 (sweep): the fresh 'no_match' fact is live -> the scan pass is cache-skipped
    // entirely (F2: `no_match` is one of the three outcomes the TTL actually covers).
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(1)
    now += 120_000
    // Round 3 (contest_search): bypasses the cache entirely regardless of outcome -> one more
    // fresh scan-pass probe.
    await runOneRound(freshRoundArgs(undefined, undefined, now, 'contest_search'))
    expect(counter.count).toBe(2)
  })

  it('F2/Ruling 23(z): a PROVEN fact is re-probed every sweep round, never cache-skipped', async () => {
    saveMatchingEnvironment()
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ probeCallCounter: counter })
    )
    let now = Date.now()
    // Every round that selects a winner issues its own scan-pass probe PLUS R10-E's winner
    // re-probe — two `federatedLinkProbe` calls per winning round.
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(2)
    now += 120_000 // past R10-A's own backoff exclusion, still well inside the 24h fact TTL.
    // R12.2: `proven` is "re-probed: every round (it is the winner)" — the fact cache NEVER
    // skips it, regardless of the TTL. Two MORE calls (fresh scan pass + R10-E re-probe).
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(4)
  })

  it('credential-identical candidate environments collapse to the newest; the dropped one gets NO scan fact (Ruling 23(d)/23(e))', async () => {
    // Both environments carry the SAME endpoint deviceToken (the link's own token — a genuine
    // credential match, per the coalesced fixture above), so BOTH would be probed and BOTH would
    // match were the collapse not applied — R10-B's filter must reduce this to exactly one probe.
    const first = saveMatchingEnvironment()
    const second = saveMatchingEnvironment()
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ probeCallCounter: counter })
    )
    await runOneRound(freshRoundArgs())
    // Exactly one SCAN-PASS probe call for this page — the collapse reduced two credential-
    // identical candidates to one before the probe pass — plus R10-E's own winner re-probe.
    expect(counter.count).toBe(2)
    const firstFact = db.getScanFact(linkId, first)
    const secondFact = db.getScanFact(linkId, second)
    // Exactly one of the two has a scan fact (the survivor, 'proven'); the other has NONE — a
    // dropped duplicate is never probed and never gets a fact row (Ruling 23(d)).
    const facts = [firstFact, secondFact].filter((f) => f !== null)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.outcome).toBe('proven')
    // The dropped duplicate surfaces only via last_detail, never advancing the park counter
    // (Ruling 23(e)) — this round bound to the survivor, so consecutiveNoWinner stays 0.
    const attempt = db.getBindingAttempt(linkId)
    expect(attempt?.consecutiveNoWinner).toBe(0)
    expect(db.getPeerLinkBinding(linkId)?.environmentId).toBe(
      facts[0] === firstFact ? first : second
    )
  })

  it('F1/R11.4/Ruling 23(r): a valid proof for a link already bound elsewhere CONTESTS — the incumbent is never overwritten', async () => {
    const keyB = loadOrCreateE2EEKeypair(join(root, 'peer-userdata-b'))
    const envA = saveMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    const incumbent = db.getPeerLinkBinding(linkId)
    expect(incumbent?.environmentId).toBe(envA)
    expect(incumbent?.state).toBe('confirmed')

    // Exclude A so B is the round's sole (and thus |W|=1) winner — isolating R11.4's ACROSS-ROUND
    // incumbent check from R11.3's SAME-round >=2-winner contest (already unit-tested by
    // classifyLinkRound). B answers with a genuinely valid proof (it also knows T_in) but a
    // DIFFERENT peer key.
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
    saveMatchingEnvironmentWithKey(keyB)
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({ key: keyB }))
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now))

    const binding = db.getPeerLinkBinding(linkId)
    // The incumbent (A) is NEVER overwritten by B's valid-but-different-key proof.
    expect(binding?.environmentId).toBe(envA)
    expect(binding?.state).toBe('contested')
    expect(binding?.contestIncidentId).not.toBeNull()
    const attempt = db.getBindingAttempt(linkId)
    expect(attempt?.lastOutcome).toBe('contested')
    // R11.3 step 3: no backoff schedule — only proveNow re-arms a contested link.
    expect(attempt?.nextAttemptAfter).toBeNull()
  })

  it('F1(b): a contested link is excluded from the next automatic round', async () => {
    const keyB = loadOrCreateE2EEKeypair(join(root, 'peer-userdata-b'))
    const envA = saveMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
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
    saveMatchingEnvironmentWithKey(keyB)
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ key: keyB, probeCallCounter: counter })
    )
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('contested')
    const callsAfterContest = counter.count

    // A further round (well past any ordinary backoff) must not re-select this contested link.
    now += 3_600_000
    const outcome = await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(outcome.evaluatedLinkIds).not.toContain(linkId)
    expect(counter.count).toBe(callsAfterContest)
  })

  it('F2 negative: link_store_unreadable (a FAULT) is re-probed every round, never cache-skipped', async () => {
    saveMatchingEnvironment()
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({
        throwWith: new OrchestrationError('link_store_unreadable', 'broken'),
        probeCallCounter: counter
      })
    )
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(1)
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    // Unlike link_store_empty, an unreadable store is a FAULT — it must be re-probed every round.
    expect(counter.count).toBe(2)
  })

  it('F21/F2 negative: an unreachable scan fact is re-probed every round, never cache-skipped', async () => {
    saveMatchingEnvironment()
    const counter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({
        throwWith: new OrchestrationError('unreachable', 'peer down'),
        probeCallCounter: counter
      })
    )
    let now = Date.now()
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(1)
    now += 120_000
    await runOneRound(freshRoundArgs(undefined, undefined, now))
    expect(counter.count).toBe(2)
  })

  it('F6/Ruling 23(v): a local environment-store read failure is never an attempted round — the park counter never advances', async () => {
    saveNonMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(fakeResponder({}))
    environmentStoreFault.throwing = true
    let now = Date.now()
    try {
      for (let i = 0; i < LINK_BINDING_UNPAIRED_PARK_ROUNDS + 2; i += 1) {
        const outcome = await runOneRound(freshRoundArgs(undefined, undefined, now))
        expect(outcome.completeness).toBe('partial')
        now += 120_000
      }
    } finally {
      environmentStoreFault.throwing = false
    }
    expect(db.getBindingAttempt(linkId)?.consecutiveNoWinner).toBe(0)
    expect(db.getBindingAttempt(linkId)?.lastOutcome).not.toBe('unpaired_parked')
  })

  it('R10-E: a winning slot that survives the re-probe + confirm gets its binding written', async () => {
    saveMatchingEnvironment()
    const probeCounter = { count: 0 }
    const confirmCounter = { count: 0 }
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ probeCallCounter: probeCounter, confirmCallCounter: confirmCounter })
    )
    const outcome = await runOneRound(freshRoundArgs())
    expect(outcome.evaluatedLinkIds).toContain(linkId)
    // One probe for the round's own scan pass, ONE MORE for R10-E's winner re-probe (fresh
    // nonce/probeId), and exactly one batched confirm call.
    expect(probeCounter.count).toBe(2)
    expect(confirmCounter.count).toBe(1)
    expect(db.getPeerLinkBinding(linkId)).not.toBeNull()
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('proven')
  })

  it('R10-E: a refused confirm writes NO binding and records the outcome via the register vocabulary', async () => {
    saveMatchingEnvironment()
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ confirmAcknowledgeNone: true })
    )
    await runOneRound(freshRoundArgs())
    // Single-writer property preserved: NOTHING was written to peer_link_bindings.
    expect(db.getPeerLinkBinding(linkId)).toBeNull()
    const attempt = db.getBindingAttempt(linkId)
    expect(attempt?.lastOutcome).toBe('unreachable')
    expect(attempt?.lastDetail).toMatch(/^reconfirm_failed:/)
  })

  it('R10-E: a re-probe that throws (peer unreachable on the second dial) also writes NO binding', async () => {
    saveMatchingEnvironment()
    let calls = 0
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; params: unknown }
      if (a.method === 'orchestration.federatedLinkProbe') {
        calls += 1
        if (calls === 2) {
          throw new OrchestrationError('unreachable', 'peer went away')
        }
      }
      return fakeResponder({})(a)
    })
    await runOneRound(freshRoundArgs())
    expect(db.getPeerLinkBinding(linkId)).toBeNull()
    expect(db.getBindingAttempt(linkId)?.lastOutcome).toBe('unreachable')
  })

  it('R11.5/C-9: a probe advisory is recorded onto the bound link as a labelled remote claim, never last_outcome', async () => {
    saveMatchingEnvironment()
    const incidentId = randomBytes(16).toString('hex')
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      fakeResponder({ advisory: { kind: 'link_contested', incidentId } })
    )
    await runOneRound(freshRoundArgs())
    const attempt = db.getBindingAttempt(linkId)
    // The round still bound cleanly — the advisory never gates the round or last_outcome.
    expect(attempt?.lastOutcome).toBe('proven')
    expect(attempt?.lastAdvisory).toEqual({
      kind: 'peer_reports_contest',
      incidentId,
      environmentId: expect.any(String)
    })
    expect(attempt?.lastAdvisoryAt).not.toBeNull()
  })

  it('R10.1: a bounded worker pool never runs more than LINK_BINDING_SCAN_CONCURRENCY probes at once, and a slow candidate does not block the others', async () => {
    const envIds = Array.from({ length: LINK_BINDING_SCAN_CONCURRENCY + 2 }, () =>
      saveNonMatchingEnvironment()
    )
    let inFlight = 0
    let maxInFlight = 0
    const finishedOrder: string[] = []
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(async (args) => {
      const a = args as { method: string; params: unknown; selector?: string }
      if (a.method !== 'status.get') {
        return { capabilities: [] }
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // The FIRST environment probed is deliberately slow — it must not hold up the others.
      const isSlow = finishedOrder.length === 0 && inFlight === 1
      await new Promise((resolve) => setTimeout(resolve, isSlow ? 30 : 0))
      inFlight -= 1
      finishedOrder.push(String(a.selector))
      return { capabilities: [] }
    })
    await runOneRound(freshRoundArgs())
    expect(maxInFlight).toBeLessThanOrEqual(LINK_BINDING_SCAN_CONCURRENCY)
    expect(finishedOrder).toHaveLength(envIds.length)
    // The slow candidate did not finish first — the pool kept the other workers moving.
    expect(finishedOrder.at(0)).not.toBe(finishedOrder.at(-1))
  })
})

describe('S10-16 C4: createLinkBindingProver (R10.6 token bucket, R13.1 kick)', () => {
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

  it('scheduleBinding(inbound_contact) clamps next_attempt_after to the per-link floor and NEVER resets consecutive_failures', () => {
    db.putBindingAttempt(linkId)
    db.settleBindingAttempt(linkId, {
      lastAttemptAt: 0,
      lastRoundAt: 0,
      lastOutcome: 'unreachable',
      lastDetail: null,
      consecutiveFailures: 5,
      consecutiveNoWinner: 0,
      nextAttemptAfter: Date.now() + 10_000_000
    })
    const prover = createLinkBindingProver(runtime)
    prover.scheduleBinding(linkId, 'inbound_contact')
    const attempt = db.getBindingAttempt(linkId)
    // consecutive_failures is UNTOUCHED by the kick — its single writer is the round settle.
    expect(attempt?.consecutiveFailures).toBe(5)
    expect(attempt?.nextAttemptAfter).toBeLessThan(Date.now() + 10_000_000)
    prover.stop()
  })

  it('the round token bucket caps actual round starts at LINK_BINDING_MAX_ROUNDS_PER_MIN within one window', async () => {
    // One real candidate environment, so every round that actually STARTS makes at least one
    // `status.get` capability-check call — the mock (beforeEach) answers `capabilities: []`
    // (unsupported), which is enough to prove the round ran without needing a full responder.
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken: 'irrelevant-to-this-test',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-bucket-test', pairingCode: code })

    const prover = createLinkBindingProver(runtime)
    // Request far more round starts than the bucket's capacity, each request separated by a
    // 0ms timer-advance so a round that DID start gets to settle (roundInFlight clears) before
    // the next request — isolating the BUCKET as the constraint, not the single-round-in-flight
    // rule. The fake clock never advances, so the bucket never refills mid-loop.
    for (let i = 0; i < LINK_BINDING_MAX_ROUNDS_PER_MIN + 5; i += 1) {
      prover.requestRerun('sweep')
      await vi.advanceTimersByTimeAsync(0)
    }
    prover.stop()
    const mock = runtime.callPinnedEnvironment as unknown as { mock: { calls: unknown[][] } }
    expect(mock.mock.calls.length).toBeLessThanOrEqual(LINK_BINDING_MAX_ROUNDS_PER_MIN)
    expect(mock.mock.calls.length).toBeGreaterThan(0)
  })
})
