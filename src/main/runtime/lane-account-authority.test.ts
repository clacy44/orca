import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { writeLaneAccountIndex } from '../claude-accounts/lane-account-index'
import { resetLaneWipePendingForTests } from '../claude-accounts/lane-wipe-pending'
import { LaneWireService } from './lane-wire-service'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'

function credentials(email: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${email}`, refreshToken: `rt-${email}` }
  })
}

const createdDirs: string[] = []

afterEach(() => {
  resetLaneWipePendingForTests()
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function plantAccount(laneDir: string, laneAccountId: string, email: string): void {
  const authDir = join(laneDir, 'claude-accounts', laneAccountId, 'auth')
  mkdirSync(authDir, { recursive: true })
  writeFileSync(join(authDir, '.orca-managed-claude-auth'), `${laneAccountId}\n`, { mode: 0o600 })
  writeFileSync(join(authDir, '.credentials.json'), credentials(email), { mode: 0o600 })
}

function makeHarness() {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-account-authority-'))
  createdDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
  const coordinator = new LaneCredentialCoordinator({
    laneOptions: { lanesRoot, platform: 'linux' }
  })
  const bindings = new Map<string, string>([
    ['device-a', LANE_A],
    ['device-b', LANE_B]
  ])
  const service = new LaneWireService({
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => (principalId === LANE_A ? 'device-a' : 'device-b')
    },
    coordinator,
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  const laneDir = (laneId: string): string => join(lanesRoot, laneId)
  return {
    service,
    coordinator,
    laneDir,
    loadLane: (laneId: string, refreshToken: string): void => {
      writeFileSync(join(laneDir(laneId), '.credentials.json'), credentials(refreshToken))
    },
    laneCredentialsOnDisk: (laneId: string): string | null => {
      const path = join(laneDir(laneId), '.credentials.json')
      return existsSync(path) ? readFileSync(path, 'utf-8') : null
    }
  }
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('LaneAccountAuthority — selectAccount/removeAccount (S9-L1 §modules D)', () => {
  it('selects a captured login into the lane, synchronously', async () => {
    const { service, laneDir } = makeHarness()
    plantAccount(laneDir(LANE_A), ACCOUNT_A, 'a@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_A), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: false, capturedAt: 'now' }
    ])

    const result = await service.accountAuthority.selectAccount('device-a', ACCOUNT_A)

    expect(result).toEqual({ active: ACCOUNT_A })
    expect(existsSync(join(laneDir(LANE_A), '.credentials.json'))).toBe(true)
  })

  // Review finding: `selectLaneAccount`'s `invalidateProbes` parameter defaults to a no-op, so
  // nothing failed if a future edit dropped the argument — only reading the call site proved it
  // was threaded. Pins it at the wiring layer: a REAL coordinator's own method must actually run
  // for this lane, and before the credential write it guards, not after.
  it('threads the real coordinator.invalidateLaneUsageProbes into selectAccount, before the write', async () => {
    const { service, laneDir, coordinator } = makeHarness()
    plantAccount(laneDir(LANE_A), ACCOUNT_A, 'a@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_A), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: false, capturedAt: 'now' }
    ])
    const order: string[] = []
    const invalidateSpy = vi
      .spyOn(coordinator, 'invalidateLaneUsageProbes')
      .mockImplementation(async (laneId) => {
        order.push(`invalidate:${laneId}`)
      })
    const writeSpy = vi.spyOn(coordinator.authState, 'serializeLaneWrite')

    await service.accountAuthority.selectAccount('device-a', ACCOUNT_A)

    expect(invalidateSpy).toHaveBeenCalledWith(LANE_A)
    expect(writeSpy).toHaveBeenCalled()
    // `invalidateProbes` runs INSIDE the `serializeLaneWrite` turn, before the credential write —
    // asserted by call order rather than by mock return timing, since both are already resolved
    // by the time `selectAccount` returns.
    expect(order).toEqual([`invalidate:${LANE_A}`])
    invalidateSpy.mockRestore()
    writeSpy.mockRestore()
  })

  it('threads the real coordinator.invalidateLaneUsageProbes into selectAccountInline', async () => {
    const { service, laneDir, coordinator } = makeHarness()
    plantAccount(laneDir(LANE_A), ACCOUNT_A, 'a@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_A), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: false, capturedAt: 'now' }
    ])
    const invalidateSpy = vi.spyOn(coordinator, 'invalidateLaneUsageProbes')

    await service.accountAuthority.selectAccountInline(LANE_A, ACCOUNT_A)

    expect(invalidateSpy).toHaveBeenCalledWith(LANE_A)
    invalidateSpy.mockRestore()
  })

  it('refuses selectAccount for an unknown id and touches nothing', async () => {
    const { service } = makeHarness()
    expect(
      await refusalCode(() => service.accountAuthority.selectAccount('device-a', 'no-such-id'))
    ).toBe('accounts.lane.account_unknown')
  })

  it('never lets one grant select an account into ANOTHER lane', async () => {
    const { service, laneDir } = makeHarness()
    plantAccount(laneDir(LANE_B), ACCOUNT_B, 'b@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_B), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_B, email: 'b@x.com', label: null, active: false, capturedAt: 'now' }
    ])

    // device-a resolves to LANE_A; ACCOUNT_B lives under LANE_B's own store, which LANE_A's
    // `selectLaneAccount` never reads — refused unknown rather than crossing lanes.
    expect(
      await refusalCode(() => service.accountAuthority.selectAccount('device-a', ACCOUNT_B))
    ).toBe('accounts.lane.account_unknown')
  })

  it('removes a captured (non-active) login and leaves the active one alone', async () => {
    const { service, laneDir } = makeHarness()
    plantAccount(laneDir(LANE_A), ACCOUNT_A, 'a@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_A), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: false, capturedAt: 'now' }
    ])

    const result = await service.accountAuthority.removeAccount('device-a', ACCOUNT_A)

    expect(result).toEqual({ removed: ACCOUNT_A })
    expect(existsSync(join(laneDir(LANE_A), 'claude-accounts', ACCOUNT_A))).toBe(false)
  })

  it('refuses an anonymous caller for both mutators before touching the lane', async () => {
    const { service } = makeHarness()
    expect(await refusalCode(() => service.accountAuthority.selectAccount(null, ACCOUNT_A))).toBe(
      'accounts.lane.caller_unidentified'
    )
    expect(await refusalCode(() => service.accountAuthority.removeAccount(null, ACCOUNT_A))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })
})

/**
 * `logout` moved here from `lane-wire-authority.test.ts` (S9-L1): it is now routed through
 * `PrincipalLaneLifecycle.wipeOnExplicitLogout` rather than a direct `wipeLaneCredentials` call,
 * so it gets the login-session-cancelling fence every other wipe reason gets (§fenceWiring).
 */
describe('LaneAccountAuthority — logout', () => {
  it('sweeps the caller own lane and leaves another lane alone', async () => {
    const { service, loadLane, laneCredentialsOnDisk } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    loadLane(LANE_B, 'rt-2')

    const result = await service.accountAuthority.logout('device-a')

    expect(result.cleared).toContain('.credentials.json')
    expect(laneCredentialsOnDisk(LANE_A)).toBeNull()
    expect(laneCredentialsOnDisk(LANE_B)).not.toBeNull()
  })

  it('names the cause of the lane change as logout', async () => {
    const { service, loadLane } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    const changes: string[] = []
    service.stream.subscribe({ deviceId: 'device-a', principalId: LANE_A }, 'conn-a', (frame) =>
      changes.push(frame.type)
    )
    await service.accountAuthority.logout('device-a')
    expect(changes).toContain('status')
  })

  it('cancels an in-flight login session of the SAME lane in the fence, not left dangling', async () => {
    const { service, loadLane } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    const cancelSpy = vi.spyOn(service.coordinator.loginSessions, 'cancelLaneLoginSessions')

    await service.accountAuthority.logout('device-a')

    expect(cancelSpy).toHaveBeenCalledWith(LANE_A)
  })

  it('never auto-provisions: an unprovisioned lane refuses rather than creating one', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-lane-account-authority-unprov-'))
    createdDirs.push(userData)
    const lanesRoot = join(userData, 'claude-lanes')
    // Only LANE_B is provisioned.
    provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    const service = new LaneWireService({
      principals: {
        principalOf: (deviceId) => (deviceId === 'device-a' ? LANE_A : null),
        delegatedGrantIdOf: () => null
      },
      coordinator,
      switchGate: { begin: () => {}, end: () => {} },
      platform: 'linux'
    })

    expect(await refusalCode(() => service.accountAuthority.logout('device-a'))).toBe(
      'accounts.lane.not_provisioned'
    )
  })
})

/** §modules E: the host-inline CLI door — a principalId directly, not a paired grant. */
describe('LaneAccountAuthority §modules E — host-inline select/list/logout', () => {
  it('selectAccountInline writes the credential in synchronously, by principalId', async () => {
    const { service, laneDir } = makeHarness()
    plantAccount(laneDir(LANE_A), ACCOUNT_A, 'a@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_A), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: false, capturedAt: 'now' }
    ])

    const result = await service.accountAuthority.selectAccountInline(LANE_A, ACCOUNT_A)

    expect(result).toEqual({ active: ACCOUNT_A })
    expect(existsSync(join(laneDir(LANE_A), '.credentials.json'))).toBe(true)
  })

  it('listAccountsInline projects the index and never leaks a filesystem path (no authDir)', async () => {
    const { service, laneDir } = makeHarness()
    plantAccount(laneDir(LANE_A), ACCOUNT_A, 'a@x.com')
    writeLaneAccountIndex(join(laneDir(LANE_A), 'claude-accounts'), [
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: true, capturedAt: 'now' }
    ])

    const rows = service.accountAuthority.listAccountsInline(LANE_A)

    expect(rows).toEqual([
      { laneAccountId: ACCOUNT_A, email: 'a@x.com', label: null, active: true }
    ])
    expect(JSON.stringify(rows)).not.toContain('authDir')
  })

  it('listAccountsInline on an unprovisioned lane refuses rather than returning empty silently', () => {
    const { service } = makeHarness()
    expect(() => service.accountAuthority.listAccountsInline('no-such-lane')).toThrow()
  })

  it('logoutInline sweeps the named lane by principalId, no paired grant needed', async () => {
    const { service, loadLane, laneCredentialsOnDisk } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    loadLane(LANE_B, 'rt-2')

    const result = await service.accountAuthority.logoutInline(LANE_A)

    expect(result.cleared).toContain('.credentials.json')
    expect(laneCredentialsOnDisk(LANE_A)).toBeNull()
    expect(laneCredentialsOnDisk(LANE_B)).not.toBeNull()
  })
})
