import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer, type PairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import type * as remoteRuntimeClientModule from '../../shared/remote-runtime-client'

// Release-audit follow-up (B3): T1's caller scan only proves the trigger line exists in source,
// not that it actually fires. This proves the production ok-status path calls it.
const { notifyLaneLoginHostReachableMock } = vi.hoisted(() => ({
  notifyLaneLoginHostReachableMock: vi.fn()
}))

vi.mock('../claude-accounts/lane-login-desktop-service', () => ({
  notifyLaneLoginHostReachable: notifyLaneLoginHostReachableMock
}))

const { sendRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  sendRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../shared/remote-runtime-client', async () => {
  const actual = await vi.importActual<typeof remoteRuntimeClientModule>(
    '../../shared/remote-runtime-client'
  )
  return { ...actual, sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock }
})

let userDataPath: string

function seedEnvironment(): string {
  const keyPair = generateKeyPair()
  const offer: PairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:9',
    deviceToken: 'a'.repeat(48),
    publicKeyB64: publicKeyToBase64(keyPair.publicKey)
  }
  const environment = addEnvironmentFromPairingCode(userDataPath, {
    name: 'lane-hook-host',
    pairingCode: encodePairingOffer(offer)
  })
  return environment.id
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-hook-'))
  sendRemoteRuntimeRequestMock.mockReset()
  notifyLaneLoginHostReachableMock.mockReset()
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('lane delegation reachable trigger', () => {
  it('fires on an ok status.get response, and not on a failed one', async () => {
    const { getRuntimeEnvironmentStatus } = await import('./runtime-environment-transport-routing')
    const id = seedEnvironment()
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'status.get',
      ok: true,
      result: { pairedDeviceId: 'device-1', capabilities: [] },
      _meta: { runtimeId: 'runtime-a' }
    })

    await getRuntimeEnvironmentStatus(userDataPath, id, 500)
    expect(notifyLaneLoginHostReachableMock).toHaveBeenCalledWith(id)

    notifyLaneLoginHostReachableMock.mockClear()
    sendRemoteRuntimeRequestMock.mockRejectedValueOnce(new Error('connect failed'))
    await getRuntimeEnvironmentStatus(userDataPath, id, 500)
    expect(notifyLaneLoginHostReachableMock).not.toHaveBeenCalled()
  })
})
