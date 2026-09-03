// S10-16 C4c: closes the C4b delta review (s10-16-review-C4b.md) under Ruling 23 Addendum 4 —
// split out of link-binding-prover-round-c4c.test.ts (Ruling 23 Addendum 6(ww)/review C4d
// finding 12: the 800-line TEST max-lines gate, no ratchet edit — a pure move, nothing dropped)
// purely to stay under that gate; this half is the PROVER-level describe block
// (createLinkBindingProver's scheduleBinding/arm/disarm/stop, never runOneRound directly).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import { createLinkBindingSelfView } from './device-registry-link-credential'
import {
  LINK_BINDING_UNPAIRED_PARK_ROUNDS,
  LINK_BINDING_STARTUP_DELAY_MS,
  LINK_BINDING_SWEEP_MS
} from './orchestration/link-binding-constants'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { createLinkBindingProver } from './link-binding-prover'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

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
    db.contestPeerLinkBinding(linkId, 0, 'incident-1', 'contest detail', {
      environmentId: 'env-x',
      boundEndpointId: 'ep-x',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1'
    })
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

  it("finding 3/Ruling 23 Addendum 4(bb), made discriminating by Ruling 23 Addendum 5(pp)/review C4c finding 5: a kick never runs the round's synchronous prefix on the caller's own stack", () => {
    // Review C4c finding 5: the ORIGINAL fixture saved no environment, so `callPinnedEnvironment`
    // was unreachable whether or not the round was deferred — the assertion below could not fail
    // on the pre-fix (synchronous-kick) code. A REACHABLE environment plus an overdue
    // `nextAttemptAfter` (the F19 test's own setup) makes the round's synchronous prefix actually
    // try to call it if `scheduleBinding` ever regresses to running the round on the caller's own
    // stack.
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken: 'irrelevant-to-this-test',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-bb-test', pairingCode: code })
    db.putBindingAttempt(linkId)
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

  it('C4d finding 2/Ruling 23 Addendum 6(ss): disarm() is NOT terminal — arm() after disarm() re-arms and rounds resume', async () => {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer-ss.example:16768',
      deviceToken: 'irrelevant-to-this-test',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-ss-rearm-test', pairingCode: code })
    const prover = createLinkBindingProver(runtime)
    const mock = runtime.callPinnedEnvironment as unknown as { mock: { calls: unknown[][] } }

    // `requestRerun` drives `attemptRound` directly — no sweep/startup timer scheduling involved
    // — isolating this test to exactly the property (ss) is about: whether `attemptRound` honours
    // `disarmed`, and whether `arm()` clears it.
    prover.requestRerun('sweep')
    await vi.advanceTimersByTimeAsync(0)
    const afterFirstRound = mock.mock.calls.length
    expect(afterFirstRound).toBeGreaterThan(0)

    prover.disarm()
    prover.requestRerun('sweep')
    await vi.advanceTimersByTimeAsync(0)
    // Disarmed: the second `requestRerun` started no round at all.
    expect(mock.mock.calls.length).toBe(afterFirstRound)

    // Clear the backoff the first round's own settle wrote — otherwise the link is excluded from
    // the SECOND round's candidate set on backoff grounds alone, which would mask the property
    // this test is actually about (arm() itself, not candidate selection).
    const attemptBeforeReArm = db.getBindingAttempt(linkId)
    if (attemptBeforeReArm) {
      db.settleBindingAttempt(linkId, {
        lastAttemptAt: attemptBeforeReArm.lastAttemptAt ?? Date.now(),
        lastRoundAt: attemptBeforeReArm.lastRoundAt ?? Date.now(),
        lastOutcome: attemptBeforeReArm.lastOutcome,
        lastDetail: attemptBeforeReArm.lastDetail,
        consecutiveFailures: attemptBeforeReArm.consecutiveFailures,
        consecutiveNoWinner: attemptBeforeReArm.consecutiveNoWinner,
        nextAttemptAfter: null
      })
    }
    const lastRoundAtBeforeReArm = db.getBindingAttempt(linkId)?.lastRoundAt

    // The bug this closes: `arm()` used to consult the SAME `stopped` flag `disarm()` set, so it
    // silently no-op'd forever. `arm()` is the real re-entry point now — it clears `disarmed`, so
    // the NEXT `requestRerun` actually starts a round again. Checked via the round's own DB write
    // (`lastRoundAt`), not the RPC call count — round 1 already cached this environment's
    // capability as unsupported, so a later round settles without re-dialling it, which is a
    // capability-cache effect, not evidence `arm()` failed to re-arm.
    vi.advanceTimersByTime(1)
    prover.arm()
    prover.requestRerun('sweep')
    await vi.advanceTimersByTimeAsync(0)
    expect(db.getBindingAttempt(linkId)?.lastRoundAt).toBeGreaterThan(lastRoundAtBeforeReArm ?? 0)
    prover.stop()
  })

  it('C4d finding 5/Ruling 23 Addendum 6(ss): stop() cancels every prover timer, including the kick timer', () => {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer-stop-kick.example:16768',
      deviceToken: 'irrelevant-to-this-test',
      publicKeyB64: peerE2ee.publicKeyB64
    })
    addEnvironmentFromPairingCode(userDataPath, { name: 'env-stop-kick-test', pairingCode: code })
    db.putBindingAttempt(linkId)
    db.settleBindingAttempt(linkId, {
      lastAttemptAt: 0,
      lastRoundAt: 0,
      lastOutcome: 'pending',
      lastDetail: null,
      consecutiveFailures: 0,
      consecutiveNoWinner: 0,
      nextAttemptAfter: Date.now() - 1_000
    })
    const baseline = vi.getTimerCount()
    const prover = createLinkBindingProver(runtime)
    // `scheduleBinding`'s leading-edge kick sets BOTH `kickRunTimer` (the deferred `setTimeout(…,
    // 0)` round start) and `kickTimer` (the debounce window) — before this fix, `stop()` cleared
    // only the latter, leaking `kickRunTimer` past `stop()`.
    prover.scheduleBinding(linkId, 'inbound_contact')
    expect(vi.getTimerCount()).toBeGreaterThan(baseline)
    prover.stop()
    expect(vi.getTimerCount()).toBe(baseline)
  })
})
