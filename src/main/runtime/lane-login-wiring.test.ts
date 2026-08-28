import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_RPC_METHODS } from './rpc/methods'
import { CLAUDE_CREDENTIAL_LANE_METHODS } from './rpc/methods/claude-credential-lanes'
import { attachPrincipalLaneHost, detachPrincipalLaneHost } from './principal-lane-host-wiring'
import { setLaneWireHostDependencies } from './lane-wire-composition'
import { getLaneWireService, attachLaneWireService } from './lane-wire-service'
import { LaneAccountAuthority } from './lane-account-authority'
import { LaneLoginAuthority } from './lane-login-authority'
import { LaneLoginSessionRegistry } from '../claude-accounts/lane-login-session'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import type { PrincipalGrantRow } from './principal-registry'
import { PrincipalRegistry } from './principal-registry'
import { authorizeHostConsent } from './principal-consent-authority'
import { isStreamingMethod, type RpcContext } from './rpc/core'
import {
  isLaneWipePending,
  markLaneWipePending,
  releaseUnconfirmedLaneWipe,
  resetLaneWipePendingForTests
} from '../claude-accounts/lane-wipe-pending'
import { PRINCIPAL_LANE_METHODS } from './rpc/methods/principal-lanes'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

class FakeGrants {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true
  add(deviceId: string): void {
    this.rows.push({
      deviceId,
      name: 'Ana',
      token: `token-${deviceId}`,
      pairedAt: 1,
      lastSeenAt: 1,
      pendingExpiresAt: Date.now() + 60_000
    })
  }
  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }
  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

const LOGIN_QUARTET_METHODS = [
  'accounts.lane.loginStart',
  'accounts.lane.loginSubmitCode',
  'accounts.lane.loginCancel',
  'accounts.lane.loginStatus',
  'accounts.lane.selectAccount',
  'accounts.lane.removeAccount',
  'accounts.lane.logout'
]

/**
 * The "zero production consumers" proof (S9-L1 reviews r1/r2): every module this slice adds must
 * be reached from the REAL production composition root — `attachPrincipalLaneHost`, the function
 * `src/main/index.ts` calls at startup — not just constructible in a test harness.
 */
describe('S9-L1 §rpcs: the login-quartet RPCs are reachable from production composition', () => {
  let userDataPath = ''

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wiring-'))
    resetLaneWipePendingForTests()
  })

  afterEach(() => {
    detachPrincipalLaneHost({})
    attachLaneWireService(null)
    setLaneWireHostDependencies(null)
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers all seven login-quartet/select/remove/logout methods on the runtime method table', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const name of LOGIN_QUARTET_METHODS) {
      expect(registered.has(name), `${name} must be registered`).toBe(true)
    }
    // And they are OWNED by this slice's own method module, not registered elsewhere by name only.
    const ownNames = new Set(CLAUDE_CREDENTIAL_LANE_METHODS.map((method) => method.name))
    for (const name of LOGIN_QUARTET_METHODS) {
      expect(ownNames.has(name)).toBe(true)
    }
  })

  it('wires a REAL LaneLoginAuthority/LaneAccountAuthority through the production attach path, not a stub', () => {
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot: join(userDataPath, 'claude-lanes'), platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })
    const grants = new FakeGrants()
    grants.add('desktop-a')

    attachPrincipalLaneHost({
      userDataPath,
      grants,
      runtimeAuthToken: 'test-token',
      runtime: {}
    })

    const service = getLaneWireService()
    expect(service).not.toBeNull()
    expect(service!.loginAuthority).toBeInstanceOf(LaneLoginAuthority)
    expect(service!.accountAuthority).toBeInstanceOf(LaneAccountAuthority)
    expect(service!.coordinator.loginSessions).toBeInstanceOf(LaneLoginSessionRegistry)
    // Real (empty) map, not undefined/a stub — closes the review's standing blocker.
    expect(service!.coordinator.loginSessions.statusOf('nothing-yet')).toBeNull()
  })

  it('the RPC handler for loginStart reaches the ATTACHED production LaneLoginAuthority end to end', async () => {
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot: join(userDataPath, 'claude-lanes'), platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })
    const grants = new FakeGrants()
    grants.add('desktop-a')
    // Bound but NOT designated: `attachPrincipalLaneHost` constructs its OWN `PrincipalRegistry`
    // from the same `userDataPath`, which loads this persisted bind on construction.
    const consent = authorizeHostConsent({})
    const setupRegistry = new PrincipalRegistry(userDataPath, grants)
    const principal = setupRegistry.createPrincipal(consent, 'Ana')
    setupRegistry.bindGrant(consent, 'desktop-a', principal.principalId)

    attachPrincipalLaneHost({ userDataPath, grants, runtimeAuthToken: 'test-token', runtime: {} })

    const method = CLAUDE_CREDENTIAL_LANE_METHODS.find((m) => m.name === 'accounts.lane.loginStart')
    if (!method || isStreamingMethod(method)) {
      throw new Error('missing accounts.lane.loginStart')
    }
    // Unbound, undesignated device: refused by the REAL attached authority, not `not_enabled` —
    // proves the call reached the production service rather than finding nothing attached.
    const params = method.params!.parse({ expectedEmail: 'a@x.com' })
    await expect(
      method.handler(params, { pairedDeviceId: 'desktop-a' } as RpcContext)
    ).rejects.toMatchObject({ code: 'accounts.lane.no_login_device_designated' })
  })

  it('`orca lane wipe --force` reaches the ATTACHED production lifecycle end to end', async () => {
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot: join(userDataPath, 'claude-lanes'), platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })
    const grants = new FakeGrants()
    const consent = authorizeHostConsent({})
    const setupRegistry = new PrincipalRegistry(userDataPath, grants)
    const principal = setupRegistry.createPrincipal(consent, 'Ana')

    attachPrincipalLaneHost({ userDataPath, grants, runtimeAuthToken: 'test-token', runtime: {} })
    // A LATCHED mark: the sequence gave up (no longer in flight) but the mark itself stayed set —
    // the exact state `--force` exists to end. `markLaneWipePending` alone leaves a sequence in
    // flight forever, which `forceReleaseWipeLatch` correctly refuses to act on.
    const sequence = markLaneWipePending(principal.principalId)
    releaseUnconfirmedLaneWipe(principal.principalId, sequence)
    expect(isLaneWipePending(principal.principalId)).toBe(true)

    const method = PRINCIPAL_LANE_METHODS.find((m) => m.name === 'accounts.lane.wipe')
    if (!method || isStreamingMethod(method)) {
      throw new Error('missing accounts.lane.wipe')
    }
    const params = method.params!.parse({ principalId: principal.principalId, force: true })
    // Host-only, like every other lane-consent write: an identified (paired) caller is refused.
    const result = await method.handler(params, {} as RpcContext)

    expect(result).toEqual({ released: true })
    expect(isLaneWipePending(principal.principalId)).toBe(false)
  })
})
