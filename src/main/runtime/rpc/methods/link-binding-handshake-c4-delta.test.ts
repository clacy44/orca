// S10-16: split out of link-binding-handshake.test.ts (max-lines ratchet — that file was at its
// 800-line cap) — duplicated harness rather than shared, matching this codebase's established
// test-split precedent (orchestration-federated-peer-ask-link-quarantine.test.ts). Covers two
// items: C3a delta Q5 (the S10-19 peer-profile admission gate around probe/confirm) and C4/R7.5
// (a confirm schedules this host's own proof round via the link-binding prover).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DeviceRegistry } from '../../device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from '../../e2ee-keypair'
import { createLinkBindingSelfView } from '../../device-registry-link-credential'
import { hashCallerCredential } from '../../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from '../../orchestration/environment-transport'
import {
  LINK_BINDING_PROTOCOL,
  SELECTOR_LABEL,
  CONFIRM_LABEL,
  linkBindingMac
} from '../../orchestration/link-binding-proof'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_LINK_BINDING_PEER_METHODS } from './orchestration-link-binding-peer'
import { addEnvironmentFromPairingCode } from '../../../../shared/runtime-environment-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { admitRuntimePeerMethod } from '../../runtime-peer-rpc-allowlist'
import { mapRuntimeError } from '../errors'
import type { RpcContext, RpcEnvelopeMeta } from '../core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

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

// C3a delta Q5: mirrors runtime-rpc.ts's own condition (`:2001`) for WHEN the S10-19 peer-profile
// gate runs at all — `device.scope === 'runtime' && accessProfile === 'peer'`. A mobile-scope or
// full-profile caller never reaches `admitRuntimePeerMethod` in production; it goes straight to
// the handler, gated only by the handler's own lane check.
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

function paddingSelectors(count: number): string[] {
  return Array.from({ length: count }, () => hex64())
}

describe('S10-16 C3a delta Q5 / C4 R7.5 (split from link-binding-handshake.test.ts)', () => {
  let root: string
  let userDataPath: string
  let deviceRegistry: DeviceRegistry
  let e2ee: E2EEKeypair
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-link-binding-handshake-c4-delta-'))
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

  // C3a delta Q5: prove the negative both ways — a mobile-scope ctx is refused by the handler's
  // own lane gate (unauthenticated_lane), and a runtime-scope full-profile ctx also skips the
  // allowlist gate but reaches real handler logic (link_store_empty on this test's empty store).
  it('Q5: a mobile-scope or full-profile ctx skips admitRuntimePeerMethod and is refused by the handler’s own lane gate', async () => {
    const params = buildProbe(0, 'secret')
    const mobileCtx: RpcContext = {
      runtime,
      pairedDeviceId: homeLinkDeviceId,
      clientKind: 'mobile',
      authenticatedCallerFingerprint: HOME_LINK_FINGERPRINT
    }
    await expect(
      dispatchPeer('orchestration.federatedLinkProbe', params, mobileCtx, {
        scope: 'mobile',
        accessProfile: 'peer'
      })
    ).rejects.toMatchObject({ code: 'unauthenticated_lane' })

    await expect(
      dispatchPeer('orchestration.federatedLinkProbe', params, pairedCtx(), {
        scope: 'runtime',
        accessProfile: 'full'
      })
    ).rejects.toMatchObject({ code: 'link_store_empty' })
  })

  // C4/R7.5: a confirm schedules THIS host's own proof round against the peer that just
  // confirmed — the wiring C3 left as a comment (orchestration-link-binding-confirm.ts).
  it('C4/R7.5: an acknowledged confirm schedules this host’s own proof round via the link-binding prover', async () => {
    const tIn = 'schedule-on-confirm-secret'
    saveCandidateEnvironment(tIn)
    const params = buildProbe(0, tIn)
    const probeResult = (await call('orchestration.federatedLinkProbe', params, pairedCtx())) as {
      results: { slotIndex: number; matched: true; nonceP: string }[]
    }
    const matched = probeResult.results[0]!
    const confirmMac = linkBindingMac(tIn, CONFIRM_LABEL, [
      params.probeId,
      params.nonceH,
      '0',
      '0',
      observedChannelFp(),
      dstKeyFp(),
      matched.nonceP
    ])
    const scheduleBinding = vi.fn()
    vi.spyOn(runtime, 'getLinkBindingProver').mockReturnValue({
      scheduleBinding,
      arm: vi.fn(),
      disarm: vi.fn(),
      requestRerun: vi.fn(),
      health: vi.fn(),
      stop: vi.fn()
    })
    await call(
      'orchestration.federatedLinkConfirm',
      {
        protocol: LINK_BINDING_PROTOCOL,
        probeId: params.probeId,
        confirms: [{ slotIndex: 0, confirm: confirmMac }]
      },
      pairedCtx()
    )
    expect(scheduleBinding).toHaveBeenCalledWith(homeLinkDeviceId, 'peer_confirmed')
    expect(scheduleBinding).toHaveBeenCalledTimes(1)
  })
})
