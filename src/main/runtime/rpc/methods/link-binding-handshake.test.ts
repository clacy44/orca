// S10-16 C3: the responder half of the proof protocol (R7/R8/R9), exercised through the REAL
// `orchestration.federatedLinkProbe`/`federatedLinkConfirm` handlers via a paired-runtime ctx —
// the exact shape a genuine relay call arrives with (`pairedDeviceId` set, `clientKind:'runtime'`,
// `authenticatedCallerFingerprint` set), the same convention orchestration-federated-peer-ask.test
// .ts's two-runtime harness uses for its own worker side.
//
// Scoping note (forced deviation, recorded in the C3 return): this commit lands ONLY the
// responder (P). The verifier (H) — the round that builds a probe, validates slotIndex discipline
// before any MAC (R7.8), and pages candidates (R10.4) — is `link-binding-prover-round.ts`, a C4
// file that does not exist yet. Design-doc test numbers 11 (slot discipline), 18 (old-peer
// capability skip) and 51 (`link-bind --wait`) are verifier/CLI-side and are NOT exercisable
// against C3's tree; they are re-asserted when C4/C7 land the code they test. This file covers
// every C3-scoped design-doc test number that IS backed by production code here: 1 (relay
// closes at the responder), 3 (wrong peer ⇒ empty), 7 (peer_duplicate), 12 (replayed confirm),
// 13 (probeId reuse), 14 (per-link pending cap eviction), 15 (unattested/mobile refusal), 16
// (null self-view ⇒ capability_unsupported) — plus the store-empty/unreadable split (P6), the
// quarantine gate (R3), the rate limit (R7.3 step 3), slot batching/attribution, and the no-
// key-material-in-response assertion the plan's Gate-1 checklist calls for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeCryptoModule from 'node:crypto'

// Review F4: `vi.spyOn(require('node:crypto'), 'timingSafeEqual')` never intercepts this
// module's own `import { timingSafeEqual } from 'node:crypto'` under this Vitest config's SSR
// transform (confirmed empirically in link-binding-proof.test.ts's own F4(c) fix — the spy
// never fires, for a valid compare either) and `vi.spyOn(<namespace import>, …)` throws (ESM
// namespaces are non-configurable). `vi.mock` rewrites the module graph itself, so every
// importer in this file's dependency tree — this test file AND the handler under test —
// resolves the SAME wrapped export.
const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCryptoModule>()
  return {
    ...actual,
    timingSafeEqual: (...args: Parameters<typeof actual.timingSafeEqual>) => {
      timingSafeEqualSpy(...args)
      return actual.timingSafeEqual(...args)
    }
  }
})

import { randomBytes } from 'node:crypto'
import { DeviceRegistry } from '../../device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from '../../e2ee-keypair'
import { createLinkBindingSelfView } from '../../device-registry-link-credential'
import { hashCallerCredential } from '../../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from '../../orchestration/environment-transport'
import {
  LINK_BINDING_PROTOCOL,
  SELECTOR_LABEL,
  linkBindingMac,
  linkBindingMacEquals
} from '../../orchestration/link-binding-proof'
import {
  LINK_BINDING_PENDING_PER_LINK,
  LINK_BINDING_RATE_LIMIT
} from '../../orchestration/link-binding-constants'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_LINK_BINDING_PEER_METHODS } from './orchestration-link-binding-peer'
import { addEnvironmentFromPairingCode } from '../../../../shared/runtime-environment-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { admitRuntimePeerMethod } from '../../runtime-peer-rpc-allowlist'
import { mapRuntimeError } from '../errors'
import { LinkBindingCapError } from '../../orchestration/link-binding-store'
import { ORCHESTRATION_FEDERATED_PEER_SEND_METHODS } from './orchestration-federated-peer-send'
import { ORCHESTRATION_FEDERATED_PEER_ASK_METHODS } from './orchestration-federated-peer-ask'
import type { RpcContext, RpcEnvelopeMeta } from '../core'

const appState = { userData: '' }

vi.mock('electron', () => ({
  app: { getPath: () => appState.userData }
}))

function method(name: string) {
  const found = ORCHESTRATION_LINK_BINDING_PEER_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
  const m = method(name)
  const parsed = m.params ? m.params.parse(params) : undefined
  return m.handler(parsed, context)
}

// Review F11: "at least the probe/confirm positive and negative cases" must go through the REAL
// dispatcher (admitRuntimePeerMethod, THEN the handler, THEN mapRuntimeError) rather than
// `m.handler` directly — `call()` above skips both the allowlist and the error-mapping layer, so
// `errors.ts`'s three new registrations (link_binding_conflict/link_store_unreadable/
// link_store_empty) had no test at all. This mirrors runtime-rpc.ts's own two-step dispatch
// (admission, then handler) without pulling in the full WS server.
// C3a delta Q5: mirrors runtime-rpc.ts's own condition (`:2001`) for WHEN the gate runs at all —
// `device.scope === 'runtime' && accessProfile === 'peer'`. A mobile-scope or full-profile caller
// never reaches `admitRuntimePeerMethod` in production; it goes straight to the handler, gated
// only by the handler's own lane check (`clientKind !== 'runtime'`). Defaults match every
// pre-existing call site in this file (a genuine peer probe/confirm caller) so none of them
// change behaviour.
async function dispatchPeer(
  name: string,
  params: Record<string, unknown>,
  context: RpcContext,
  admission: { scope: 'runtime' | 'mobile'; accessProfile: 'peer' | 'full' } = {
    scope: 'runtime',
    accessProfile: 'peer'
  }
) {
  const meta: RpcEnvelopeMeta = { runtimeId: 'test-runtime' }
  if (admission.scope === 'runtime' && admission.accessProfile === 'peer') {
    const admitted = await admitRuntimePeerMethod({
      runtime: context.runtime,
      callerFingerprint:
        typeof context.authenticatedCallerFingerprint === 'string'
          ? context.authenticatedCallerFingerprint
          : '',
      params,
      method: name
    })
    if (admitted.refused) {
      throw {
        code: admitted.wireCode,
        message: admitted.message,
        ...(admitted.retryAfterMs !== undefined ? { retryAfterMs: admitted.retryAfterMs } : {})
      }
    }
  }
  const m = method(name)
  const parsed = m.params ? m.params.parse(params) : undefined
  try {
    return await m.handler(parsed, context)
  } catch (e) {
    const failure = mapRuntimeError('dispatch-test-id', meta, e)
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- mirrors RpcFailure.error
    throw {
      code: failure.error.code,
      message: failure.error.message,
      ...(failure.error.data !== undefined ? { data: failure.error.data } : {})
    }
  }
}

const HOME_LINK_FINGERPRINT = 'fp_home_link'

function hex64(): string {
  return randomBytes(32).toString('hex')
}

function probeId(): string {
  return randomBytes(16).toString('hex')
}

// The 8 padding selectors design's R7.1 requires — uniformly indistinguishable from a real one.
function paddingSelectors(count: number): string[] {
  return Array.from({ length: count }, () => hex64())
}

describe('S10-16 C3: link-binding responder (federatedLinkProbe/federatedLinkConfirm)', () => {
  let root: string
  let userDataPath: string
  let deviceRegistry: DeviceRegistry
  let e2ee: E2EEKeypair
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  // The RPC transport-layer credential H presents when calling P — shared between P's registry
  // row for the caller and H's own saved-environment endpoint (never modeled here — H is
  // simulated by hand-computing what a real verifier would compute).
  let channelToken: string
  let homeLinkDeviceId: string

  function pairedCtx(overrides: Partial<RpcContext> = {}): RpcContext {
    return {
      runtime,
      pairedDeviceId: homeLinkDeviceId,
      clientKind: 'runtime',
      authenticatedCallerFingerprint: HOME_LINK_FINGERPRINT,
      ...overrides
    }
  }

  function observedChannelFp(): string {
    return hashCallerCredential(channelToken)
  }

  function dstKeyFp(): string {
    return fingerprintOrchestrationPeer(e2ee.publicKeyB64)
  }

  function saveCandidateEnvironment(deviceToken: string, publicKeyB64 = e2ee.publicKeyB64): string {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://peer.example:16768',
      deviceToken,
      publicKeyB64
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: `env-${randomBytes(4).toString('hex')}`,
      pairingCode: code
    })
    return env.id
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-link-binding-handshake-'))
    userDataPath = join(root, 'userdata')
    appState.userData = userDataPath
    deviceRegistry = new DeviceRegistry(userDataPath)
    const link = deviceRegistry.mintPendingDevice('home', 'runtime')
    channelToken = link.token
    homeLinkDeviceId = link.deviceId
    e2ee = loadOrCreateE2EEKeypair(userDataPath)
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

  function buildProbe(realSlot: number, tIn: string, epoch = 0) {
    const id = probeId()
    const nonceH = hex64()
    const selectors = paddingSelectors(8)
    selectors[realSlot] = linkBindingMac(tIn, SELECTOR_LABEL, [
      id,
      nonceH,
      String(realSlot),
      String(epoch),
      observedChannelFp(),
      dstKeyFp()
    ])
    return { protocol: LINK_BINDING_PROTOCOL, probeId: id, nonceH, epoch, selectors }
  }

  // ---- design test 15: unattested/mobile/fallback ⇒ refused ------------------------------

  it('test 15: refuses a local (non-paired) caller', async () => {
    const params = buildProbe(0, 'secret')
    await expect(
      call('orchestration.federatedLinkProbe', params, { runtime })
    ).rejects.toMatchObject({ code: 'unauthenticated_lane' })
  })

  it('test 15: refuses a mobile-scope caller', async () => {
    const params = buildProbe(0, 'secret')
    await expect(
      call('orchestration.federatedLinkProbe', params, pairedCtx({ clientKind: 'mobile' }))
    ).rejects.toMatchObject({ code: 'unauthenticated_lane' })
  })

  it('test 15: refuses the authenticated_transport fallback fingerprint', async () => {
    const params = buildProbe(0, 'secret')
    await expect(
      call(
        'orchestration.federatedLinkProbe',
        params,
        pairedCtx({
          authenticatedCallerFingerprint: hashCallerCredential('authenticated_transport')
        })
      )
    ).rejects.toMatchObject({ code: 'unauthenticated_lane' })
  })

  // ---- design test 16: null self-view ⇒ capability_unsupported --------------------------

  it('test 16: refuses capability_unsupported when the self-view is not armed', async () => {
    runtime.setLinkBindingSelfView(null)
    const params = buildProbe(0, 'secret')
    await expect(
      call('orchestration.federatedLinkProbe', params, pairedCtx())
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
  })

  // ---- R12.1(1)/P6: store precondition, split into two outcomes -------------------------

  it('refuses link_store_empty when this host has no saved environments', async () => {
    const params = buildProbe(0, 'secret')
    await expect(
      call('orchestration.federatedLinkProbe', params, pairedCtx())
    ).rejects.toMatchObject({ code: 'link_store_empty' })
  })

  it('refuses link_store_unreadable when the environment store throws', async () => {
    // Point userData at a path whose environments file cannot be a valid JSON store (a
    // directory in its place forces a read failure).
    mkdirSync(join(userDataPath, 'orca-environments.json'))
    const params = buildProbe(0, 'secret')
    await expect(
      call('orchestration.federatedLinkProbe', params, pairedCtx())
    ).rejects.toMatchObject({ code: 'link_store_unreadable' })
  })

  // ---- design test 1: relay attack closes at the responder, before any disclosure -------

  it('test 1: a relayed probe (wrong observedChannelFp) returns EMPTY results, no disclosure', async () => {
    const tIn = 'the-shared-secret'
    saveCandidateEnvironment(tIn)
    // A second, genuinely-registered link — the hostile-but-paired relay A. A real relay forwards
    // H's probe bytes verbatim over ITS OWN link, so P computes observedChannelFp from A's
    // credential, not H's — the closure happens here, not by A being unregistered.
    const attacker = deviceRegistry.mintPendingDevice('attacker', 'runtime')
    const id = probeId()
    const nonceH = hex64()
    const selectors = paddingSelectors(8)
    // Built exactly as H would build it for its OWN honest channel to P.
    selectors[0] = linkBindingMac(tIn, SELECTOR_LABEL, [
      id,
      nonceH,
      '0',
      '0',
      observedChannelFp(), // H's real channel fp — NOT what A's relay presents
      dstKeyFp()
    ])
    const result = (await call(
      'orchestration.federatedLinkProbe',
      { protocol: LINK_BINDING_PROTOCOL, probeId: id, nonceH, epoch: 0, selectors },
      // The relay: same bytes, A's OWN paired identity.
      pairedCtx({
        pairedDeviceId: attacker.deviceId,
        authenticatedCallerFingerprint: 'fp_attacker'
      })
    )) as { results: unknown[] }
    expect(result.results).toEqual([])
  })

  // ---- design test 3: wrong peer ⇒ empty -------------------------------------------------

  it('test 3: a peer holding no matching selector answers with empty results, no throw', async () => {
    saveCandidateEnvironment('some-other-secret-this-peer-holds')
    const params = buildProbe(0, 'a-secret-this-peer-does-not-hold')
    const result = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: unknown[]
    }
    expect(result.results).toEqual([])
  })

  // ---- positive round-trip: probe -> confirm ----------------------------------------------

  it('positive proof round-trip: probe matches, confirm verifies and acknowledges (real dispatcher)', async () => {
    const tIn = 'matching-secret'
    const environmentId = saveCandidateEnvironment(tIn)
    const params = buildProbe(2, tIn)
    const probeResult = (await dispatchPeer(
      'orchestration.federatedLinkProbe',
      params,
      pairedCtx()
    )) as {
      protocol: string
      results: (
        | {
            slotIndex: number
            matched: true
            nonceP: string
            proof: string
            peerKeyFingerprint: string
          }
        | { slotIndex: number; matched: false }
      )[]
    }
    expect(probeResult.protocol).toBe(LINK_BINDING_PROTOCOL)
    expect(probeResult.results).toHaveLength(1)
    const matched = probeResult.results[0]
    expect(matched).toBeDefined()
    if (!matched || matched.matched !== true) {
      throw new Error('expected a matched slot')
    }
    expect(matched.slotIndex).toBe(2)
    expect(matched.peerKeyFingerprint).toBe(fingerprintOrchestrationPeer(e2ee.publicKeyB64))

    // The verifier recomputes proof itself and compares (never trusts the peer's echo) — verify
    // this handler's returned proof is exactly the MAC the design specifies.
    const expectedProof = linkBindingMac(tIn, 'orca.link-binding.v1/proof', [
      params.probeId,
      params.nonceH,
      '2',
      '0',
      observedChannelFp(),
      dstKeyFp(),
      matched.nonceP
    ])
    expect(matched.proof).toBe(expectedProof)

    const confirmMac = linkBindingMac(tIn, 'orca.link-binding.v1/confirm', [
      params.probeId,
      params.nonceH,
      '2',
      '0',
      observedChannelFp(),
      dstKeyFp(),
      matched.nonceP
    ])
    const confirmResult = (await dispatchPeer(
      'orchestration.federatedLinkConfirm',
      {
        protocol: LINK_BINDING_PROTOCOL,
        probeId: params.probeId,
        confirms: [{ slotIndex: 2, confirm: confirmMac }]
      },
      pairedCtx()
    )) as { protocol: string; acknowledged: number[] }
    expect(confirmResult.acknowledged).toEqual([2])

    // R7.5: a confirm writes NO binding row and NO scan fact — only the observation.
    expect(db.getPeerLinkBinding(homeLinkDeviceId)).toBeNull()
    expect(db.getScanFact(homeLinkDeviceId, environmentId)).toBeNull()
    const observations = db.listConfirmObservations(homeLinkDeviceId)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ kind: 'peer_confirmed', environmentId })
  })

  it('wrong MAC is refused: a confirm with an incorrect value is not acknowledged (real dispatcher)', async () => {
    const tIn = 'matching-secret-2'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const probeResult = (await dispatchPeer(
      'orchestration.federatedLinkProbe',
      params,
      pairedCtx()
    )) as {
      results: { slotIndex: number; matched: true; nonceP: string }[]
    }
    expect(probeResult.results).toHaveLength(1)
    await expect(
      dispatchPeer(
        'orchestration.federatedLinkConfirm',
        {
          protocol: LINK_BINDING_PROTOCOL,
          probeId: params.probeId,
          confirms: [{ slotIndex: 0, confirm: 'f'.repeat(64) }]
        },
        pairedCtx()
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })
    // Review F3: a total miss must NOT consume the pending record — still there for a genuine
    // confirm on the same probeId.
    const confirmMac = linkBindingMac(tIn, 'orca.link-binding.v1/confirm', [
      params.probeId,
      params.nonceH,
      '0',
      '0',
      observedChannelFp(),
      dstKeyFp(),
      probeResult.results[0]!.nonceP
    ])
    const retry = (await dispatchPeer(
      'orchestration.federatedLinkConfirm',
      {
        protocol: LINK_BINDING_PROTOCOL,
        probeId: params.probeId,
        confirms: [{ slotIndex: 0, confirm: confirmMac }]
      },
      pairedCtx()
    )) as { acknowledged: number[] }
    expect(retry.acknowledged).toEqual([0])
  })

  // ---- malformed hex refused BEFORE decode, never reaches timingSafeEqual ----------------

  it('malformed-hex confirm is refused before any decode (timingSafeEqual never reached)', async () => {
    const tIn = 'matching-secret-3'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const probeResult = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: { slotIndex: number; matched: true }[]
    }
    expect(probeResult.results).toHaveLength(1)
    timingSafeEqualSpy.mockClear()
    // Review F4(b): the previous version went through `call()`, whose own `m.params.parse`
    // (LINK_BINDING_HEX64_RE, identical to the handler's own guard) rejects malformed hex
    // before the handler ever runs — `.rejects.toBeTruthy()` was matching the ZodError, not
    // exercising the handler's own guard, and passed even with the handler deleted. Calling
    // `m.handler` DIRECTLY bypasses that zod layer so the malformed value genuinely reaches
    // `linkBindingMacEquals` inside the handler — the guard this test is actually about.
    await expect(
      method('orchestration.federatedLinkConfirm').handler(
        {
          protocol: LINK_BINDING_PROTOCOL,
          probeId: params.probeId,
          confirms: [{ slotIndex: 0, confirm: 'zz'.padEnd(64, 'z') }]
        },
        pairedCtx()
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })
    // The handler's own hex64 shape guard (linkBindingMacEquals) refuses before any decode:
    // timingSafeEqual is never reached.
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })

  // ---- design test 7: peer claims a duplicate --------------------------------------------

  it('test 7: two of the responder’s own saved environments share the secret ⇒ peer_duplicate', async () => {
    const tIn = 'shared-by-two-envs'
    saveCandidateEnvironment(tIn)
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const result = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: { slotIndex: number; matched: false; reason?: string }[]
    }
    expect(result.results).toEqual([{ slotIndex: 0, matched: false, reason: 'peer_duplicate' }])
    const observations = db.listConfirmObservations(homeLinkDeviceId)
    expect(observations.every((o) => o.kind === 'local_duplicate')).toBe(true)
    expect(observations.length).toBe(2)
  })

  // ---- design test 12: replayed confirm ⇒ not_the_addressee, non-fatal ------------------

  it('test 12: a replayed confirm (already consumed) finds nothing and is non-fatal', async () => {
    const tIn = 'consume-once-secret'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const probeResult = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: { slotIndex: number; matched: true; nonceP: string }[]
    }
    const matched = probeResult.results[0]!
    const confirmMac = linkBindingMac(tIn, 'orca.link-binding.v1/confirm', [
      params.probeId,
      params.nonceH,
      '0',
      '0',
      observedChannelFp(),
      dstKeyFp(),
      matched.nonceP
    ])
    const first = (await call(
      'orchestration.federatedLinkConfirm',
      {
        protocol: LINK_BINDING_PROTOCOL,
        probeId: params.probeId,
        confirms: [{ slotIndex: 0, confirm: confirmMac }]
      },
      pairedCtx()
    )) as { acknowledged: number[] }
    expect(first.acknowledged).toEqual([0])

    await expect(
      call(
        'orchestration.federatedLinkConfirm',
        {
          protocol: LINK_BINDING_PROTOCOL,
          probeId: params.probeId,
          confirms: [{ slotIndex: 0, confirm: confirmMac }]
        },
        pairedCtx()
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })
  })

  // ---- design test 13: probeId reuse ------------------------------------------------------

  it('test 13: identical replay of a still-pending probeId returns identical results', async () => {
    const tIn = 'idempotent-secret'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const first = await call('orchestration.federatedLinkProbe', params, pairedCtx())
    const second = await call('orchestration.federatedLinkProbe', params, pairedCtx())
    expect(second).toEqual(first)
  })

  it('test 13: the same probeId with DIFFERENT input is request_mismatch', async () => {
    const tIn = 'idempotent-secret-2'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    await call('orchestration.federatedLinkProbe', params, pairedCtx())
    const mutated = { ...params, epoch: params.epoch + 1 }
    await expect(
      call('orchestration.federatedLinkProbe', mutated, pairedCtx())
    ).rejects.toMatchObject({ code: 'request_mismatch' })
  })

  // ---- design test 14: caps — within-link eviction, never a refusal ---------------------

  it('test 14: the (N+1)th pending record on one link evicts that link’s oldest unconsumed record', async () => {
    const tIn = 'cap-secret'
    saveCandidateEnvironment(tIn)
    const probeIds: string[] = []
    // Fixed epoch throughout: R8.3's epoch supersession would otherwise clear every earlier
    // record on each call, masking the cap/eviction behaviour this test targets.
    for (let i = 0; i <= LINK_BINDING_PENDING_PER_LINK; i += 1) {
      const params = buildProbe(0, tIn, 0)
      probeIds.push(params.probeId)
      await call('orchestration.federatedLinkProbe', params, pairedCtx())
    }
    // Every call above succeeded (never a refusal) — the eviction is silent overflow handling,
    // never a denial, matching R8.2. Replaying the OLDEST probeId now looks like a brand-new
    // probeId (its record was evicted), which succeeds rather than replaying stale results —
    // that is the observable proof the eviction happened.
    const oldestParams = buildProbe(0, tIn, 0)
    const replay = await call(
      'orchestration.federatedLinkProbe',
      { ...oldestParams, probeId: probeIds[0] },
      pairedCtx()
    )
    expect(replay).toBeTruthy()
  })

  // ---- slot batching: 8 slots, correct slotIndex attribution ----------------------------

  it('slot batching: 8 slots, matches attributed by slotIndex, never by array position', async () => {
    const secrets = Array.from({ length: 8 }, (_, i) => `slot-secret-${i}`)
    for (const secret of secrets) {
      saveCandidateEnvironment(secret)
    }
    const id = probeId()
    const nonceH = hex64()
    const epoch = 0
    // Only slots 1, 4 and 6 carry real (matching) selectors; the rest are padding.
    const realSlots = [1, 4, 6]
    const selectors = paddingSelectors(8)
    for (const slot of realSlots) {
      selectors[slot] = linkBindingMac(secrets[slot]!, SELECTOR_LABEL, [
        id,
        nonceH,
        String(slot),
        String(epoch),
        observedChannelFp(),
        dstKeyFp()
      ])
    }
    const result = (await call(
      'orchestration.federatedLinkProbe',
      { protocol: LINK_BINDING_PROTOCOL, probeId: id, nonceH, epoch, selectors },
      pairedCtx()
    )) as { results: { slotIndex: number; matched: true; nonceP: string; proof: string }[] }
    expect(result.results.map((r) => r.slotIndex).sort((a, b) => a - b)).toEqual(realSlots)
    for (const entry of result.results) {
      expect(realSlots).toContain(entry.slotIndex)
    }
  })

  // ---- no key material in the response ----------------------------------------------------

  it('the responder response contains no key material (grep for the secret preimages)', async () => {
    const tIn = 'must-never-leak'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const result = await call('orchestration.federatedLinkProbe', params, pairedCtx())
    const serialized = JSON.stringify(result)
    expect(serialized.includes(tIn)).toBe(false)
    expect(serialized.includes(channelToken)).toBe(false)
    expect(serialized.includes(e2ee.secretKey.toString())).toBe(false)
  })

  // ---- R3: quarantine gate ------------------------------------------------------------

  it('a quarantined link is refused agent_quarantined and carries the advisory', async () => {
    db.putContainment({
      subjectKind: 'link',
      subjectId: homeLinkDeviceId,
      action: 'quarantine',
      reasonCode: 'test',
      reasonText: 'test quarantine',
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })
    const params = buildProbe(0, 'secret')
    await expect(
      call('orchestration.federatedLinkProbe', params, pairedCtx())
    ).rejects.toMatchObject({
      code: 'agent_quarantined',
      data: expect.objectContaining({
        advisory: expect.objectContaining({ kind: 'link_quarantined' })
      })
    })
  })

  // ---- rate limit ---------------------------------------------------------------------

  it('rate-limits federatedLinkProbe per link, per verb', async () => {
    saveCandidateEnvironment('rate-secret')
    // Review F11: was a hardcoded `const budget = 60` — THE REGISTER owns this value.
    const budget = LINK_BINDING_RATE_LIMIT
    for (let i = 0; i < budget; i += 1) {
      await call('orchestration.federatedLinkProbe', buildProbe(0, 'rate-secret', i), pairedCtx())
    }
    await expect(
      call('orchestration.federatedLinkProbe', buildProbe(0, 'rate-secret', budget), pairedCtx())
    ).rejects.toMatchObject({ code: 'rate_limited' })
  })

  // ---- review F2: containment expiry -----------------------------------------------------

  it('F2: an expired quarantine no longer refuses (expires_at in the past)', async () => {
    db.putContainment({
      subjectKind: 'link',
      subjectId: homeLinkDeviceId,
      action: 'quarantine',
      reasonCode: 'test',
      reasonText: 'test quarantine',
      detail: null,
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1_000
    })
    saveCandidateEnvironment('post-expiry-secret')
    const params = buildProbe(0, 'post-expiry-secret')
    const result = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: unknown[]
    }
    expect(result.results).toHaveLength(1)
  })

  // ---- review F11 coverage gaps -----------------------------------------------------------

  it('a confirm arriving on a DIFFERENT link than its own probe is refused, no state change', async () => {
    const tIn = 'cross-link-secret'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const probeResult = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: { slotIndex: number; matched: true; nonceP: string }[]
    }
    const matched = probeResult.results[0]!
    const confirmMac = linkBindingMac(tIn, 'orca.link-binding.v1/confirm', [
      params.probeId,
      params.nonceH,
      '0',
      '0',
      observedChannelFp(),
      dstKeyFp(),
      matched.nonceP
    ])
    // A second, genuinely-registered link — this probeId was never served on it.
    const other = deviceRegistry.mintPendingDevice('other', 'runtime')
    await expect(
      call(
        'orchestration.federatedLinkConfirm',
        {
          protocol: LINK_BINDING_PROTOCOL,
          probeId: params.probeId,
          confirms: [{ slotIndex: 0, confirm: confirmMac }]
        },
        pairedCtx({ pairedDeviceId: other.deviceId, authenticatedCallerFingerprint: 'fp_other' })
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })
    // No state change on the home link's own pending record — the genuine confirm still works.
    const genuine = (await call(
      'orchestration.federatedLinkConfirm',
      {
        protocol: LINK_BINDING_PROTOCOL,
        probeId: params.probeId,
        confirms: [{ slotIndex: 0, confirm: confirmMac }]
      },
      pairedCtx()
    )) as { acknowledged: number[] }
    expect(genuine.acknowledged).toEqual([0])
  })

  it('duplicate slotIndex in one federatedLinkConfirm call is invalid_argument', async () => {
    const tIn = 'dup-slot-secret'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    await call('orchestration.federatedLinkProbe', params, pairedCtx())
    await expect(
      call(
        'orchestration.federatedLinkConfirm',
        {
          protocol: LINK_BINDING_PROTOCOL,
          probeId: params.probeId,
          confirms: [
            { slotIndex: 0, confirm: 'a'.repeat(64) },
            { slotIndex: 0, confirm: 'b'.repeat(64) }
          ]
        },
        pairedCtx()
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('link_contested advisory: a contested binding surfaces a well-shaped 32-hex incidentId', async () => {
    saveCandidateEnvironment('contested-secret')
    db.putPeerLinkBinding({
      linkDeviceId: homeLinkDeviceId,
      environmentId: 'env-does-not-need-to-exist',
      boundEndpointId: 'ep-1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: LINK_BINDING_PROTOCOL,
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    const incidentId = 'c'.repeat(32)
    db.contestPeerLinkBinding(homeLinkDeviceId, Date.now(), incidentId, 'test contest', {
      environmentId: 'env-does-not-need-to-exist',
      boundEndpointId: 'ep-1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: LINK_BINDING_PROTOCOL
    })
    const params = buildProbe(0, 'contested-secret')
    const result = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      advisory?: { kind: string; incidentId: string }
    }
    expect(result.advisory).toEqual({ kind: 'link_contested', incidentId })
    expect(result.advisory?.incidentId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('epoch supersession (R8.3): a higher-epoch probe releases the same link’s lower-epoch pending records', async () => {
    const tIn = 'epoch-secret'
    saveCandidateEnvironment(tIn)
    const low = buildProbe(0, tIn, 0)
    await call('orchestration.federatedLinkProbe', low, pairedCtx())
    const high = buildProbe(0, tIn, 1)
    await call('orchestration.federatedLinkProbe', high, pairedCtx())
    // The lower-epoch probeId's pending record was released by the higher-epoch probe — a
    // confirm against it now finds nothing, the same shape as an expired/consumed record.
    await expect(
      call(
        'orchestration.federatedLinkConfirm',
        {
          protocol: LINK_BINDING_PROTOCOL,
          probeId: low.probeId,
          confirms: [{ slotIndex: 0, confirm: 'a'.repeat(64) }]
        },
        pairedCtx()
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })
  })

  it('the clientId belt check refuses a mismatched credential (probe.ts ~97-102)', async () => {
    const params = buildProbe(0, 'secret')
    await expect(
      call(
        'orchestration.federatedLinkProbe',
        params,
        pairedCtx({ clientId: 'a-token-that-does-not-hash-to-observedChannelFp' })
      )
    ).rejects.toMatchObject({ code: 'unauthenticated_lane' })
  })

  it('the three new passthrough codes cross mapRuntimeError as themselves, through the real dispatcher', async () => {
    // link_store_empty
    await expect(
      dispatchPeer('orchestration.federatedLinkProbe', buildProbe(0, 'secret'), pairedCtx())
    ).rejects.toMatchObject({ code: 'link_store_empty' })

    // link_store_unreadable
    mkdirSync(join(userDataPath, 'orca-environments.json'))
    await expect(
      dispatchPeer('orchestration.federatedLinkProbe', buildProbe(0, 'secret'), pairedCtx())
    ).rejects.toMatchObject({ code: 'link_store_unreadable' })
    rmSync(join(userDataPath, 'orca-environments.json'), { recursive: true, force: true })

    // link_binding_conflict — LinkBindingCapError's own `.code`, exercised directly (review F6:
    // the one live throw site, reply-outbox-store.ts, is a different C-phase's call path; this
    // proves the wire-code wiring itself through the same mapRuntimeError the dispatcher uses).
    const meta: RpcEnvelopeMeta = { runtimeId: 'test-runtime' }
    const capError = new LinkBindingCapError('peer_reply_outbox')
    const failure = mapRuntimeError('id', meta, capError)
    expect(failure.error.code).toBe('link_binding_conflict')
  })

  // C3a delta Q5 and C4/R7.5 are in the sibling file link-binding-handshake-c4-delta.test.ts
  // (max-lines split — this file was at its 800-line cap).

  // ---- review F1: quarantine-gate audit write is bounded by the rate meter (probe/confirm) --

  describe('review F1: quarantine-gate audit rows are bounded by the meter', () => {
    function rawDb(): { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } {
      return (db as unknown as { db: ReturnType<typeof rawDb> }).db
    }

    function auditCount(): number {
      return (rawDb().prepare('SELECT COUNT(*) AS n FROM agent_audit').get() as { n: number }).n
    }

    beforeEach(() => {
      db.putContainment({
        subjectKind: 'link',
        subjectId: homeLinkDeviceId,
        action: 'quarantine',
        reasonCode: 'test',
        reasonText: 'test quarantine',
        detail: null,
        createdAt: Date.now(),
        expiresAt: null
      })
    })

    it('federatedLinkProbe: at most LINK_BINDING_RATE_LIMIT audit rows across a burst', async () => {
      const before = auditCount()
      for (let i = 0; i < LINK_BINDING_RATE_LIMIT + 5; i += 1) {
        await expect(
          call('orchestration.federatedLinkProbe', buildProbe(0, 'secret', i), pairedCtx())
        ).rejects.toBeTruthy()
      }
      expect(auditCount() - before).toBeLessThanOrEqual(LINK_BINDING_RATE_LIMIT)
    })

    it('federatedLinkConfirm: at most LINK_BINDING_RATE_LIMIT audit rows across a burst', async () => {
      const before = auditCount()
      for (let i = 0; i < LINK_BINDING_RATE_LIMIT + 5; i += 1) {
        await expect(
          call(
            'orchestration.federatedLinkConfirm',
            {
              protocol: LINK_BINDING_PROTOCOL,
              probeId: probeId(),
              confirms: [{ slotIndex: 0, confirm: 'a'.repeat(64) }]
            },
            pairedCtx()
          )
        ).rejects.toBeTruthy()
      }
      expect(auditCount() - before).toBeLessThanOrEqual(LINK_BINDING_RATE_LIMIT)
    })

    it('federatedSend: at most LINK_BINDING_RATE_LIMIT audit rows across a burst', async () => {
      const m = ORCHESTRATION_FEDERATED_PEER_SEND_METHODS.find(
        (x) => x.name === 'orchestration.federatedSend'
      )!
      const before = auditCount()
      for (let i = 0; i < LINK_BINDING_RATE_LIMIT + 5; i += 1) {
        const parsed = m.params!.parse({
          toAgentId: 'agt_deadbeef0000',
          messageId: `msg-${i}`,
          subject: 'x'
        })
        // federatedSend's handler is synchronous and throws directly (unlike Ask's `async`) —
        // normalize through a resolved-promise `.then` so a sync throw and an async rejection
        // are asserted the same way.
        await expect(
          Promise.resolve().then(() => m.handler(parsed, pairedCtx()))
        ).rejects.toBeTruthy()
      }
      expect(auditCount() - before).toBeLessThanOrEqual(LINK_BINDING_RATE_LIMIT)
    })

    it('federatedAsk: at most LINK_BINDING_RATE_LIMIT audit rows across a burst', async () => {
      const m = ORCHESTRATION_FEDERATED_PEER_ASK_METHODS.find(
        (x) => x.name === 'orchestration.federatedAsk'
      )!
      const before = auditCount()
      for (let i = 0; i < LINK_BINDING_RATE_LIMIT + 5; i += 1) {
        const parsed = m.params!.parse({
          fromAgent: { id: 'agt_deadbeef0000', displayName: 'Peer' },
          toAgentId: 'agt_deadbeef0001',
          question: `q-${i}`
        })
        await expect(m.handler(parsed, pairedCtx())).rejects.toBeTruthy()
      }
      expect(auditCount() - before).toBeLessThanOrEqual(LINK_BINDING_RATE_LIMIT)
    })
  })

  it('sanity: linkBindingMacEquals backs the handler (a direct positive control)', () => {
    // Review F4(a): the previous version of this test never called `linkBindingMacEquals` —
    // it asserted `timingSafeEqual(x, x) === true`, which tests Node, not this module. Assert
    // the module-graph-level spy WAS called, proving `linkBindingMacEquals` really does back
    // onto `timingSafeEqual` (see the file-header comment for why this is `vi.mock`-based).
    timingSafeEqualSpy.mockClear()
    const a = 'a'.repeat(64)
    expect(linkBindingMacEquals(a, a)).toBe(true)
    expect(timingSafeEqualSpy).toHaveBeenCalled()
  })
})
