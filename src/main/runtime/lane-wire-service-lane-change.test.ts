import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import type { LaneStatusFrame } from './lane-status-stream'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

/**
 * `LaneWireService.onLaneChanged` — the join between the authority naming a lane change's cause
 * and every bound grant's status stream. Rev 32 (S9-L3, §10(g)) deletes `LaneDelegatedSwitchService`
 * and the pending-switch routing it tested: what remains is that a lane change re-emits `status` to
 * every subscriber, which this file now covers directly.
 */

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const createdDirs: string[] = []

afterEach(() => {
  attachLaneWireService(null)
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function credentials(refreshToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${refreshToken}`,
      refreshToken,
      expiresAt: Date.now() + 3_600_000
    }
  })
}

function makeHarness() {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-change-'))
  createdDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  const coordinator = new LaneCredentialCoordinator({
    laneOptions: { lanesRoot, platform: 'linux' }
  })
  const bindings = new Map<string, string>([
    ['desktop-a', LANE_A],
    ['phone-a', LANE_A]
  ])
  const service = new LaneWireService({
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: () => 'desktop-a',
      labelOf: () => 'Ana'
    },
    coordinator,
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  attachLaneWireService(service)
  const frames = new Map<string, LaneStatusFrame[]>()
  const attach = (deviceId: string): void => {
    const received: LaneStatusFrame[] = []
    frames.set(deviceId, received)
    service.stream.subscribe({ deviceId, principalId: LANE_A }, `conn-${deviceId}`, (frame) =>
      received.push(frame)
    )
  }
  const loadLane = (refreshToken: string): void => {
    const laneDir = coordinator.store.resolveLaneDir(LANE_A)
    if (!laneDir) {
      throw new Error('lane not provisioned')
    }
    writeFileSync(join(laneDir, '.credentials.json'), credentials(refreshToken))
  }
  return { service, attach, frames, loadLane }
}

describe('lane change routing through the lane wire service', () => {
  it('re-publishes status to every bound grant when the caller logs out', async () => {
    const harness = makeHarness()
    harness.loadLane('rt-1')
    harness.attach('desktop-a')
    harness.attach('phone-a')

    await harness.service.authority.logout('desktop-a')

    for (const deviceId of ['desktop-a', 'phone-a']) {
      const statusFrames = (harness.frames.get(deviceId) ?? []).filter(
        (frame) => frame.type === 'status'
      )
      expect(statusFrames).toHaveLength(1)
      expect((statusFrames[0] as { status: { laneState: string } }).status.laneState).toBe('absent')
    }
  })

  it('routes a lifecycle wipe to the attached service and to no detached one', async () => {
    const harness = makeHarness()
    harness.loadLane('rt-1')
    harness.attach('desktop-a')
    const attached = harness.frames.get('desktop-a') ?? []

    await harness.service.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)
    const framesWhileAttached = attached.length
    // `dispose()` deliberately keeps the wipe listener for the SWAP case, so a detach with nothing
    // incoming has to unregister it — or the coordinator keeps calling a disposed service.
    attachLaneWireService(null)
    harness.loadLane('rt-2')
    await harness.service.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)

    expect(framesWhileAttached).toBeGreaterThan(0)
    expect(attached).toHaveLength(framesWhileAttached)
  })
})
