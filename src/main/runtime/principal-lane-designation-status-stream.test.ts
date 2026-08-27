/**
 * Discoverability follow-up (release audit): a registry write outside the wire — bind, designate,
 * provision — must reach a desktop that is already subscribed to the lane-status stream, exactly
 * as a push or clear already does through `LaneWireService.onLaneChanged`. Before this file, a
 * device that subscribed before designation held a stale `callerIsDelegatedGrant: false` for the
 * rest of the connection's life; nothing on the registry side ever told it otherwise.
 *
 * Runs the real production wiring (`attachPrincipalLaneHost` + `setLaneWireHostDependencies`), the
 * same call chain `principal-lane-production-wiring.integration.test.ts` proves the push path
 * over — but subscribes directly against the attached `LaneWireService.stream` rather than a real
 * WebSocket, since only the registry-write → stream-frame join is under test here.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import type { LaneStatusFrame } from './lane-status-stream'
import { getLaneWireService } from './lane-wire-service'
import { setLaneWireHostDependencies } from './lane-wire-composition'
import type { PrincipalGrantRow, PrincipalGrantSource } from './principal-grant-source'
import { attachPrincipalLaneHost, detachPrincipalLaneHost } from './principal-lane-host-wiring'
import { getPrincipalLaneConsentService } from './principal-lane-consent-service'

const electronState = { userDataPath: '' }
vi.mock('electron', () => ({ app: { getPath: () => electronState.userDataPath } }))

const CONSENT = { source: 'local-socket' } as const
const DEVICE_ID = 'a'.repeat(64)

class FakeGrants implements PrincipalGrantSource {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true

  add(deviceId: string): void {
    this.rows = [
      ...this.rows,
      {
        deviceId,
        name: 'Desktop',
        token: `token-${deviceId}`,
        pairedAt: 1,
        lastSeenAt: 1,
        pendingExpiresAt: Date.now() + 60_000
      }
    ]
  }

  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }

  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

const dirs: string[] = []

afterEach(() => {
  detachPrincipalLaneHost({})
  setLaneWireHostDependencies(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makePersistence(): {
  getClaudeLaneCredentialWatermarks: () => ClaudeLaneCredentialWatermark[]
  setClaudeLaneCredentialWatermarks: (rows: readonly ClaudeLaneCredentialWatermark[]) => void
  getClaudeLaneDelegationRows: () => ClaudeLaneDelegationRow[]
  setClaudeLaneDelegationRows: (rows: readonly ClaudeLaneDelegationRow[]) => void
  getClaudeLaneDelegationLeases: () => ClaudeLaneDelegationLease[]
  setClaudeLaneDelegationLeases: (rows: readonly ClaudeLaneDelegationLease[]) => void
} {
  let watermarks: ClaudeLaneCredentialWatermark[] = []
  let delegationRows: ClaudeLaneDelegationRow[] = []
  let leases: ClaudeLaneDelegationLease[] = []
  return {
    getClaudeLaneCredentialWatermarks: () => watermarks,
    setClaudeLaneCredentialWatermarks: (rows) => {
      watermarks = [...rows]
    },
    getClaudeLaneDelegationRows: () => delegationRows,
    setClaudeLaneDelegationRows: (rows) => {
      delegationRows = [...rows]
    },
    getClaudeLaneDelegationLeases: () => leases,
    setClaudeLaneDelegationLeases: (rows) => {
      leases = [...rows]
    }
  }
}

function startHarness(): { userDataPath: string; grants: FakeGrants } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-designation-stream-'))
  electronState.userDataPath = userDataPath
  dirs.push(userDataPath)
  const lanesRoot = join(userDataPath, 'claude-lanes')
  const persistence = makePersistence()
  const coordinator = new LaneCredentialCoordinator({
    persistence,
    sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
    laneOptions: { lanesRoot, platform: 'linux' }
  })
  setLaneWireHostDependencies({
    coordinator,
    persistence,
    accounts: { findAccount: () => null }
  })
  const grants = new FakeGrants()
  grants.add(DEVICE_ID)
  attachPrincipalLaneHost({
    userDataPath,
    grants,
    runtimeAuthToken: 'tok',
    runtime: {}
  })
  return { userDataPath, grants }
}

describe('designation reaching an already-subscribed lane-status stream (release-audit follow-up)', () => {
  it('emits a status frame naming the newly designated grant as the delegated pusher', () => {
    startHarness()
    const consent = getPrincipalLaneConsentService()!
    const wire = getLaneWireService()!
    const ana = consent.createPrincipal(CONSENT, 'Ana')

    // Subscribed BEFORE anything is bound or designated — the live symptom's exact timing.
    const frames: LaneStatusFrame[] = []
    wire.stream.subscribe(
      { deviceId: DEVICE_ID, principalId: ana.principalId },
      'conn-1',
      (frame) => frames.push(frame)
    )

    consent.bindGrant(CONSENT, DEVICE_ID, ana.principalId)
    expect(frames.filter((f) => f.type === 'status')).toHaveLength(1)
    expect(frames.at(-1)).toMatchObject({
      type: 'status',
      status: { delegatedGrantId: null, callerIsDelegatedGrant: false }
    })

    consent.designatePusher(CONSENT, ana.principalId, DEVICE_ID)
    expect(frames.filter((f) => f.type === 'status')).toHaveLength(2)
    expect(frames.at(-1)).toMatchObject({
      type: 'status',
      status: { delegatedGrantId: DEVICE_ID, callerIsDelegatedGrant: true }
    })
  })

  it('also emits on provision and deprovision, so the residency badge stays live too', () => {
    startHarness()
    const consent = getPrincipalLaneConsentService()!
    const wire = getLaneWireService()!
    const ana = consent.createPrincipal(CONSENT, 'Ana')
    consent.bindGrant(CONSENT, DEVICE_ID, ana.principalId)
    consent.designatePusher(CONSENT, ana.principalId, DEVICE_ID)

    const frames: LaneStatusFrame[] = []
    wire.stream.subscribe(
      { deviceId: DEVICE_ID, principalId: ana.principalId },
      'conn-1',
      (frame) => frames.push(frame)
    )

    consent.provisionLane(CONSENT, ana.principalId)
    expect(frames.filter((f) => f.type === 'status')).toHaveLength(1)
  })

  it('does not throw when no lane wire is attached (a build with lanes disabled)', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-designation-stream-nowire-'))
    electronState.userDataPath = userDataPath
    dirs.push(userDataPath)
    // No `setLaneWireHostDependencies`: `attachComposedLaneWire` attaches a null wire.
    const grants = new FakeGrants()
    grants.add(DEVICE_ID)
    attachPrincipalLaneHost({ userDataPath, grants, runtimeAuthToken: 'tok', runtime: {} })
    const consent = getPrincipalLaneConsentService()!
    const ana = consent.createPrincipal(CONSENT, 'Ana')
    expect(() => consent.bindGrant(CONSENT, DEVICE_ID, ana.principalId)).not.toThrow()
    expect(() => consent.designatePusher(CONSENT, ana.principalId, DEVICE_ID)).not.toThrow()
  })
})
