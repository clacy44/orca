/**
 * S9-L1 §fenceWiring "laneWipePending PUBLISH", the reconciliation half: `lane-account-store-
 * reconciliation.ts`'s own docstring says publishing on a surviving-child reappearance is
 * deliberately NOT its job — "that wiring is module C's lane-wipe-pending.ts". This file proves
 * the wiring exists at `attachPrincipalLaneHost`, the one production caller of reconciliation.
 *
 * `reconcileLaneAccountStore` only reports `reappeared: true` when a directory a synchronous pass
 * just deleted is back by the NEXT pass — reproducing that through real disk I/O inside one
 * synchronous call needs a concurrent writer this test cannot script deterministically, so the
 * reconciliation module is mocked here, scoped to this file alone (the sibling
 * `principal-lane-host-wiring.test.ts` exercises the real module end to end for every other case).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrincipalGrantRow, PrincipalGrantSource } from './principal-registry'
import {
  forceReleaseLaneWipeLatch,
  isLaneWipePending,
  resetLaneWipePendingForTests
} from '../claude-accounts/lane-wipe-pending'
import { authorizeHostConsent } from './principal-consent-authority'

const PEER_TOKEN = 'peer-token'

class FakeGrants implements PrincipalGrantSource {
  loadSucceeded = true
  private rows: PrincipalGrantRow[] = [
    {
      deviceId: 'home-peer',
      name: 'Ana laptop',
      token: PEER_TOKEN,
      pairedAt: 1_000,
      lastSeenAt: 1_000,
      pendingExpiresAt: Date.now() + 60_000
    }
  ]

  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }

  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

const electronState = { userDataDir: '' }
vi.mock('electron', () => ({ app: { getPath: () => electronState.userDataDir } }))

const reconcileMock = vi.fn()
vi.mock('../claude-accounts/lane-account-store-reconciliation', () => ({
  reconcileLaneAccountStore: (...args: unknown[]) => reconcileMock(...args)
}))

describe('attachPrincipalLaneHost — publishing a reconciliation surviving-child reappearance', () => {
  let userDataPath = ''

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wiring-reappeared-'))
    electronState.userDataDir = userDataPath
    resetLaneWipePendingForTests()
    reconcileMock.mockReset()
  })

  afterEach(async () => {
    const { detachPrincipalLaneHost } = await import('./principal-lane-host-wiring')
    detachPrincipalLaneHost({ setPrincipalLaneLookup: () => undefined })
    rmSync(userDataPath, { recursive: true, force: true })
    resetLaneWipePendingForTests()
  })

  it('marks the lane wipe-pending when reconciliation reports a directory reappeared', async () => {
    const { provisionPrincipalLane } = await import('../claude-accounts/principal-credential-lane')
    const { CLAUDE_LANES_DIRNAME } = await import('../claude-accounts/claude-lanes-root')
    const { attachPrincipalLaneHost } = await import('./principal-lane-host-wiring')

    const grants = new FakeGrants()
    const lanesRoot = join(userDataPath, CLAUDE_LANES_DIRNAME)
    // The registry needs the principal bound BEFORE attach, so the very first attach's own
    // reconciliation loop is the one under test — no second attach needed.
    const { PrincipalRegistry } = await import('./principal-registry')
    const setupRegistry = new PrincipalRegistry(userDataPath, grants)
    const consent = authorizeHostConsent({})
    const person = setupRegistry.createPrincipal(consent, 'Ana')
    setupRegistry.bindGrant(consent, 'home-peer', person.principalId)
    provisionPrincipalLane(person.principalId, { lanesRoot })
    reconcileMock.mockReturnValue({
      arm: 'a',
      deletedLaneAccountIds: [],
      quarantinedLaneAccountIds: [],
      droppedDanglingLaneAccountIds: [],
      reappeared: true
    })

    attachPrincipalLaneHost({
      userDataPath,
      grants,
      runtimeAuthToken: 'a'.repeat(48),
      runtime: {}
    })

    expect(reconcileMock).toHaveBeenCalled()
    expect(isLaneWipePending(person.principalId)).toBe(true)
    // The mark must latch WITHOUT pinning the sequence in flight — otherwise the operator's only
    // exit (`orca lane wipe --force`) refuses forever against exactly this arm.
    expect(forceReleaseLaneWipeLatch(person.principalId)).toBe(true)
    expect(isLaneWipePending(person.principalId)).toBe(false)
  })

  it('does not mark the lane when reconciliation reports a clean pass', async () => {
    const { provisionPrincipalLane } = await import('../claude-accounts/principal-credential-lane')
    const { CLAUDE_LANES_DIRNAME } = await import('../claude-accounts/claude-lanes-root')
    const { attachPrincipalLaneHost } = await import('./principal-lane-host-wiring')

    const grants = new FakeGrants()
    const lanesRoot = join(userDataPath, CLAUDE_LANES_DIRNAME)
    const { PrincipalRegistry } = await import('./principal-registry')
    const setupRegistry = new PrincipalRegistry(userDataPath, grants)
    const consent = authorizeHostConsent({})
    const person = setupRegistry.createPrincipal(consent, 'Ana')
    setupRegistry.bindGrant(consent, 'home-peer', person.principalId)
    provisionPrincipalLane(person.principalId, { lanesRoot })
    reconcileMock.mockReturnValue({
      arm: 'none',
      deletedLaneAccountIds: [],
      quarantinedLaneAccountIds: [],
      droppedDanglingLaneAccountIds: [],
      reappeared: false
    })

    attachPrincipalLaneHost({
      userDataPath,
      grants,
      runtimeAuthToken: 'a'.repeat(48),
      runtime: {}
    })

    expect(isLaneWipePending(person.principalId)).toBe(false)
  })
})
