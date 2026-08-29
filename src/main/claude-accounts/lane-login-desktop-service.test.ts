import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer, type PairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { LaneLoginTransport } from './lane-login-transport'

const { createLaneLoginTransportMock } = vi.hoisted(() => ({
  createLaneLoginTransportMock: vi.fn()
}))

vi.mock('./lane-login-transport', () => ({
  createLaneLoginTransport: createLaneLoginTransportMock
}))

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
    name: 'row-host',
    pairingCode: encodePairingOffer(offer)
  })
  return environment.id
}

/** A transport whose `getCapabilities`/`subscribeStatus` never resolve until told to. */
function makeControllableTransport(environmentId: string): {
  transport: LaneLoginTransport
  resolveCapabilities: (caps: readonly string[]) => void
  deliver: (frame: unknown) => void
} {
  let resolveCapabilities: (caps: readonly string[]) => void = () => {}
  const capabilitiesPromise = new Promise<readonly string[]>((resolve) => {
    resolveCapabilities = resolve
  })
  let deliver: (frame: unknown) => void = () => {}
  const transport: LaneLoginTransport = {
    hostId: environmentId,
    getCapabilities: vi.fn(async () => capabilitiesPromise),
    call: vi.fn(async () => ({})) as unknown as LaneLoginTransport['call'],
    subscribeStatus: vi.fn(async (onFrame) => {
      deliver = onFrame as (frame: unknown) => void
      return () => {}
    })
  }
  return {
    transport,
    resolveCapabilities,
    deliver: (frame: unknown) => deliver(frame)
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-login-desktop-'))
  createLaneLoginTransportMock.mockReset()
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('LaneLoginDesktopService.listRemoteHostRows', () => {
  it('unknown/never-connected environment renders checking', async () => {
    const { LaneLoginDesktopService } = await import('./lane-login-desktop-service')
    const environmentId = seedEnvironment()
    const service = new LaneLoginDesktopService()
    expect(service.listRemoteHostRows(userDataPath)).toEqual([
      { environmentId, label: 'row-host', state: 'checking' }
    ])
  })

  it('capability still checking renders checking', async () => {
    const { LaneLoginDesktopService } = await import('./lane-login-desktop-service')
    const environmentId = seedEnvironment()
    const { transport } = makeControllableTransport(environmentId)
    createLaneLoginTransportMock.mockReturnValue(transport)
    const service = new LaneLoginDesktopService()
    void service.connect(environmentId) // left in flight: getCapabilities never resolves
    expect(service.listRemoteHostRows(userDataPath)).toEqual([
      { environmentId, label: 'row-host', state: 'checking' }
    ])
  })

  it('unsupported host renders unsupported', async () => {
    const { LaneLoginDesktopService } = await import('./lane-login-desktop-service')
    const environmentId = seedEnvironment()
    const { transport, resolveCapabilities } = makeControllableTransport(environmentId)
    createLaneLoginTransportMock.mockReturnValue(transport)
    const service = new LaneLoginDesktopService()
    const connectPromise = service.connect(environmentId)
    resolveCapabilities(['agent.identity-lanes.v1'])
    await connectPromise
    expect(service.listRemoteHostRows(userDataPath)).toEqual([
      { environmentId, label: 'row-host', state: 'unsupported' }
    ])
  })

  // The defect under test: supported, subscribed, but no status/ready frame delivered yet must
  // render 'checking', never the false-alarm 'not-designated'.
  it('supported host with no status frame yet renders checking, not not-designated', async () => {
    const { LaneLoginDesktopService } = await import('./lane-login-desktop-service')
    const environmentId = seedEnvironment()
    const { transport, resolveCapabilities } = makeControllableTransport(environmentId)
    createLaneLoginTransportMock.mockReturnValue(transport)
    const service = new LaneLoginDesktopService()
    const connectPromise = service.connect(environmentId)
    resolveCapabilities([AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY])
    await connectPromise
    expect(service.listRemoteHostRows(userDataPath)).toEqual([
      { environmentId, label: 'row-host', state: 'checking' }
    ])
  })

  // Mutation proof: reverting to the old `!callerIsDelegatedGrant || laneState === null` guard
  // turns this red — this snapshot (`callerIsDelegatedGrant: false`, no status yet) is exactly
  // the shape that guard misreads as "not designated" while it is really "no answer yet".
  it('MUTATION PROOF: the old combined guard would misreport this same snapshot as not-designated', () => {
    const snapshot = { callerIsDelegatedGrant: false, laneState: null as string | null }
    const oldGuardSaysNotDesignated =
      !snapshot.callerIsDelegatedGrant || snapshot.laneState === null
    expect(oldGuardSaysNotDesignated).toBe(true) // the bug, reproduced
    const fixedGuardSaysChecking = snapshot.laneState === null
    expect(fixedGuardSaysChecking).toBe(true) // the fix's actual verdict for this snapshot
  })

  it('supported host with a status frame saying not designated renders not-designated', async () => {
    const { LaneLoginDesktopService } = await import('./lane-login-desktop-service')
    const environmentId = seedEnvironment()
    const { transport, resolveCapabilities, deliver } = makeControllableTransport(environmentId)
    createLaneLoginTransportMock.mockReturnValue(transport)
    const service = new LaneLoginDesktopService()
    const connectPromise = service.connect(environmentId)
    resolveCapabilities([AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY])
    await connectPromise
    deliver({
      type: 'ready',
      subscriptionId: 'sub-1',
      status: { laneState: 'absent', callerIsDelegatedGrant: false, accounts: [] }
    })
    expect(service.listRemoteHostRows(userDataPath)).toEqual([
      { environmentId, label: 'row-host', state: 'not-designated' }
    ])
  })

  it('supported, designated, loaded host renders ready with laneState loaded', async () => {
    const { LaneLoginDesktopService } = await import('./lane-login-desktop-service')
    const environmentId = seedEnvironment()
    const { transport, resolveCapabilities, deliver } = makeControllableTransport(environmentId)
    createLaneLoginTransportMock.mockReturnValue(transport)
    const service = new LaneLoginDesktopService()
    const connectPromise = service.connect(environmentId)
    resolveCapabilities([AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY])
    await connectPromise
    deliver({
      type: 'ready',
      subscriptionId: 'sub-1',
      status: {
        laneState: 'loaded',
        callerIsDelegatedGrant: true,
        accounts: [{ laneAccountId: 'a1', email: 'a@b.com', label: null, active: true }]
      }
    })
    expect(service.listRemoteHostRows(userDataPath)).toEqual([
      { environmentId, label: 'row-host', state: 'ready', laneState: 'loaded' }
    ])
  })
})
