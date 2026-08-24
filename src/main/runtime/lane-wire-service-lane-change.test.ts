import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import type { LaneStatusFrame } from './lane-status-stream'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

/**
 * The JOIN the two halves of §2l's "no request is left pending against nobody" hang on: the
 * authority names the cause of a lane change, the switch service knows what to do with each, and
 * `LaneWireService.onLaneChanged` is the only thing that routes one to the other. Both halves are
 * pinned in their own files, and a build that routed `clear` back through `settleForLane` — the
 * pre-fix behaviour that pinned the phone at `pending` with every row disabled — kept them green.
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
  let watermarks: ClaudeLaneCredentialWatermark[] = []
  let delegationRows: ClaudeLaneDelegationRow[] = []
  const persistence = {
    getClaudeLaneCredentialWatermarks: () => watermarks,
    setClaudeLaneCredentialWatermarks: (rows: readonly ClaudeLaneCredentialWatermark[]) => {
      watermarks = [...rows]
    },
    getClaudeLaneDelegationRows: () => delegationRows,
    setClaudeLaneDelegationRows: (rows: readonly ClaudeLaneDelegationRow[]) => {
      delegationRows = [...rows]
    }
  }
  const coordinator = new LaneCredentialCoordinator({
    persistence,
    sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
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
    persistence,
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
  const push = (refreshToken: string): Promise<unknown> =>
    service.authority.push('desktop-a', {
      envelope: {
        credentialsJson: credentials(refreshToken),
        oauthAccountJson: JSON.stringify({
          accountUuid: 'acct-lane',
          emailAddress: 'ana@corp.test'
        }),
        displayName: 'Ana work'
      },
      // A re-push is judged against what the lane last held (§2c), so it carries that sha.
      basedOnRefreshTokenSha256:
        service.coordinator.store.getWatermark(LANE_A)?.refreshTokenSha256 ?? null,
      delegation: {
        hostId: 'h',
        principalId: LANE_A,
        delegatedGrantId: 'desktop-a',
        since: 1
      }
    })
  return { service, attach, frames, push }
}

function mintToken(service: LaneWireService): string {
  return service.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])[0]
    .delegatedAccountId
}

async function requestSwitchWithPending(harness: ReturnType<typeof makeHarness>) {
  await harness.push('rt-1')
  harness.attach('desktop-a')
  harness.attach('phone-a')
  return harness.service.switches.requestSwitch('phone-a', mintToken(harness.service))
}

function failuresFor(harness: ReturnType<typeof makeHarness>, deviceId: string) {
  return (harness.frames.get(deviceId) ?? []).filter((frame) => frame.type === 'switch-failed')
}

describe('lane change routing through the lane wire service', () => {
  it('refuses an outstanding switch by name when the caller clears the lane', async () => {
    const harness = makeHarness()
    const { requestId } = await requestSwitchWithPending(harness)

    await harness.service.authority.clear('desktop-a')

    expect(failuresFor(harness, 'phone-a')).toEqual([
      {
        type: 'switch-failed',
        requestId,
        code: 'accounts.lane.switch_lane_cleared',
        message: expect.stringContaining('released on the host')
      }
    ])
    expect(harness.service.switches.hasPendingFor(LANE_A)).toBe(false)
  })

  it('routes a lifecycle wipe to the attached service and to no detached one', async () => {
    const harness = makeHarness()
    await harness.push('rt-1')
    harness.attach('desktop-a')
    const attached = harness.frames.get('desktop-a') ?? []

    await harness.service.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)
    const framesWhileAttached = attached.length
    // `dispose()` deliberately keeps the wipe listener for the SWAP case, so a detach with nothing
    // incoming has to unregister it — or the coordinator keeps calling a disposed service.
    attachLaneWireService(null)
    await harness.push('rt-2')
    await harness.service.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)

    expect(framesWhileAttached).toBeGreaterThan(0)
    expect(attached).toHaveLength(framesWhileAttached + 1)
  })

  // Negative control: the OTHER cause still settles silently, because the phone reads a
  // `switch-failed` as the failure of the request it is holding — and a push is its success.
  it('settles an outstanding switch with no terminal frame when the caller pushes', async () => {
    const harness = makeHarness()
    await requestSwitchWithPending(harness)

    await harness.push('rt-2')

    expect(failuresFor(harness, 'phone-a')).toEqual([])
    expect(harness.service.switches.hasPendingFor(LANE_A)).toBe(false)
  })
})
