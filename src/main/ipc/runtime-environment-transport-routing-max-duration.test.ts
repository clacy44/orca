// S10-16 R4.3/R4.6 test 19c: federatedLinkProbe/federatedLinkConfirm take the one-shot branch
// (which carries maxDurationMs), and an envelope-carrying orchestration mutation takes the
// envelope branch (which also carries it) — the two branches R4.3's analysis proves this slice's
// calls actually reach.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'

const { sendRemoteRuntimeRequestMock, sendRemoteRuntimeSharedControlRequestMock } = vi.hoisted(
  () => ({
    sendRemoteRuntimeRequestMock: vi.fn(),
    sendRemoteRuntimeSharedControlRequestMock: vi.fn()
  })
)

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: vi.fn()
}))

vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeConnectionRequest: vi.fn(),
  sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
  reconnectRemoteRuntimeSharedControlConnection: vi.fn()
}))

import {
  callRuntimeEnvironment,
  resetSharedControlSupport
} from './runtime-environment-transport-routing'

describe('callRuntimeEnvironment maxDurationMs branch selection (S10-16 R4.3/R4.6, test 19c)', () => {
  let userDataPath: string
  let environmentId: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-transport-routing-max-duration-'))
    environmentId = addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'device-token',
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
      })
    }).id
    resetSharedControlSupport()
    sendRemoteRuntimeRequestMock.mockReset().mockResolvedValue({
      id: 'r',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-test' }
    })
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('federatedLinkProbe takes the one-shot branch and carries maxDurationMs', async () => {
    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'orchestration.federatedLinkProbe',
      { probeId: 'p1' },
      1000,
      undefined,
      undefined,
      500
    )

    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'orchestration.federatedLinkProbe',
      { probeId: 'p1' },
      1000,
      undefined,
      500
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('an envelope-carrying orchestration mutation takes the envelope branch and carries maxDurationMs', async () => {
    const envelope = { orchestrationContractVersion: 1 }

    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'orchestration.federatedSend',
      { toAgentId: 'agt_1' },
      1000,
      undefined,
      envelope,
      500
    )

    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'orchestration.federatedSend',
      { toAgentId: 'agt_1' },
      1000,
      envelope,
      500
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })
})
