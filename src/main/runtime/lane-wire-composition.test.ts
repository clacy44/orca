/**
 * Release-audit B1: `attachLaneWireService` had a production-shaped constructor and no production
 * caller. These tests drive the actual composition seam this stage adds
 * (`setLaneWireHostDependencies` + `attachPrincipalLaneHost`, the real call chain `index.ts` and
 * `runtime-rpc.ts` use) rather than a hand-built `LaneWireService`, so a regression that only
 * breaks the WIRING — not the classes underneath — fails here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import {
  attachPrincipalLaneHost,
  detachPrincipalLaneHost,
  type PrincipalLaneHostRuntime
} from './principal-lane-host-wiring'
import { createPrincipalLaneConnectionJoin } from './principal-lane-connection-lifecycle'
import { setLaneWireHostDependencies } from './lane-wire-composition'
import { getLaneWireService } from './lane-wire-service'
import type { PrincipalGrantRow, PrincipalGrantSource } from './principal-registry'

class FakeGrants implements PrincipalGrantSource {
  loadSucceeded = true
  private rows: PrincipalGrantRow[] = [
    {
      deviceId: 'home-peer',
      name: 'Ana laptop',
      token: 'peer-token',
      pairedAt: 1_000,
      lastSeenAt: 1_000,
      pendingExpiresAt: undefined
    }
  ]

  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }

  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

const RUNTIME_AUTH_TOKEN = 'a'.repeat(48)

function noopRuntime(): PrincipalLaneHostRuntime {
  return {}
}

function refusalCodeOf(run: () => unknown): string {
  try {
    run()
    return 'no-refusal'
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : 'other-error'
  }
}

describe('production lane wire composition (release-audit B1)', () => {
  let userDataPath = ''

  afterEach(() => {
    detachPrincipalLaneHost(noopRuntime())
    setLaneWireHostDependencies(null)
    if (userDataPath) {
      rmSync(userDataPath, { recursive: true, force: true })
      userDataPath = ''
    }
  })

  it('leaves accounts.lane.not_enabled when no host dependencies are registered', () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wire-composition-'))
    attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime: noopRuntime()
    })
    expect(getLaneWireService()).toBeNull()
    expect(refusalCodeOf(() => getLaneWireService()?.authority.status('home-peer'))).toBe(
      'no-refusal'
    )
  })

  it('answers accounts.lane RPCs through the production wiring once dependencies are registered', () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wire-composition-'))
    const lanesRoot = mkdtempSync(join(tmpdir(), 'orca-lane-wire-composition-lanes-'))
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })

    attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime: noopRuntime()
    })

    // The wire is attached at all: a null service is exactly today's bug (B1).
    expect(getLaneWireService()).not.toBeNull()

    // A caller with no bound principal now fails past `not_enabled` — the wire resolved the
    // caller and refused on the NEXT check (`caller_unidentified`), proving the production
    // dependency chain (coordinator, persistence, principals view) is live end to end.
    expect(refusalCodeOf(() => getLaneWireService()!.authority.status('unbound-device'))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })

  it('arms the close-wipe lifecycle join once the production wire is attached, and disarms it on detach', () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wire-composition-'))
    const lanesRoot = mkdtempSync(join(tmpdir(), 'orca-lane-wire-composition-lanes-'))
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })

    const runtime = noopRuntime()
    const attachment = attachPrincipalLaneHost({
      userDataPath,
      grants: new FakeGrants(),
      runtimeAuthToken: RUNTIME_AUTH_TOKEN,
      runtime
    })

    const laneJoin = createPrincipalLaneConnectionJoin({
      bindings: attachment.registry,
      connectedDeviceIds: () => []
    })
    expect(laneJoin).not.toBeNull()

    detachPrincipalLaneHost(runtime)
    expect(getLaneWireService()).toBeNull()
    expect(
      createPrincipalLaneConnectionJoin({
        bindings: attachment.registry,
        connectedDeviceIds: () => []
      })
    ).toBeNull()
  })
})
