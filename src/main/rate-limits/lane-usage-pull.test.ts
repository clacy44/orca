/**
 * S9 §2k / §5 — the per-lane usage pull: its preparation, the four joins a probe forces, and the
 * two start-side preconditions of the close-wipe fence.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  LaneUsagePull,
  buildLaneUsageAuthPreparation,
  type LaneUsagePullDeps
} from './lane-usage-pull'
import type { ClaudeLaneUsageAttribution } from './claude-usage-attribution'

const LANE_A = '11111111-1111-4111-8111-111111111111'
const LANE_B = '22222222-2222-4222-8222-222222222222'

function laneRow(laneId: string): ClaudeLaneUsageAttribution {
  return {
    laneId,
    configDir: `/data/claude-lanes/${laneId}`,
    provenance: `lane:${'a'.repeat(32)}`,
    identity: null
  }
}

function okUsage(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

type Harness = {
  pull: LaneUsagePull
  deps: LaneUsagePullDeps
  spawned: { gateId: string; laneId: string }[]
  exited: string[]
  synced: string[]
  probedPreparations: { configDir: string; provenance: string }[]
}

function harness(overrides: Partial<LaneUsagePullDeps> = {}, lanes = [laneRow(LANE_A)]): Harness {
  const spawned: { gateId: string; laneId: string }[] = []
  const exited: string[] = []
  const synced: string[] = []
  const probedPreparations: { configDir: string; provenance: string }[] = []
  const laneStates = new Map<string, RuntimeTerminalLaneState>()
  const deps: LaneUsagePullDeps = {
    listLoadedLanes: () => lanes,
    laneStateOf: (laneId) => laneStates.get(laneId) ?? 'loaded',
    isWipePending: () => false,
    isSwitchInProgress: () => false,
    fetchUsage: async ({ authPreparation }) => {
      probedPreparations.push({
        configDir: authPreparation.configDir,
        provenance: authPreparation.provenance
      })
      return okUsage(42)
    },
    markProbeSpawned: (gateId, laneId) => spawned.push({ gateId, laneId }),
    markProbeExited: (gateId) => exited.push(gateId),
    syncProbedLane: async (laneId) => {
      synced.push(laneId)
    },
    platform: 'linux',
    ...overrides
  }
  return { pull: new LaneUsagePull(deps), deps, spawned, exited, synced, probedPreparations }
}

describe('LaneUsagePull', () => {
  it("hands the probe the lane's own config dir and opaque provenance", async () => {
    const h = harness()

    const outcome = await h.pull.run()

    expect(outcome).toMatchObject({ probed: [LANE_A], failed: [] })
    expect(h.probedPreparations).toEqual([
      { configDir: `/data/claude-lanes/${LANE_A}`, provenance: `lane:${'a'.repeat(32)}` }
    ])
    expect(h.pull.laneUsage(LANE_A)?.session?.usedPercent).toBe(42)
  })

  it('builds a host-runtime preparation that strips auth env and never says managed', () => {
    const preparation = buildLaneUsageAuthPreparation(laneRow(LANE_A))

    expect(preparation).toEqual({
      configDir: `/data/claude-lanes/${LANE_A}`,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: { CLAUDE_CONFIG_DIR: `/data/claude-lanes/${LANE_A}` },
      stripAuthEnv: true,
      provenance: `lane:${'a'.repeat(32)}`
    })
    expect(preparation.provenance.startsWith('managed:')).toBe(false)
  })

  it('registers the probe in the lane it runs in and releases it on the way out', async () => {
    const h = harness()

    await h.pull.run()

    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]?.laneId).toBe(LANE_A)
    expect(h.exited).toEqual([h.spawned[0]?.gateId])
  })

  it('syncs the probed lane after the probe exits, even on an idle lane', async () => {
    const order: string[] = []
    const h = harness({
      fetchUsage: async () => {
        order.push('probe')
        return okUsage(1)
      },
      markProbeExited: () => order.push('release'),
      syncProbedLane: async () => {
        order.push('sync')
      }
    })

    await h.pull.run()

    expect(order).toEqual(['probe', 'release', 'sync'])
  })

  // The close-wipe fence, start side. Asserted separately from the kill.
  it('starts no probe into a lane whose wipe is pending', async () => {
    const h = harness({ isWipePending: (laneId) => laneId === LANE_A })

    const outcome = await h.pull.run()

    expect(outcome.probed).toEqual([])
    expect(outcome.skipped).toEqual([{ laneId: LANE_A, reason: 'wipe-pending' }])
    expect(h.spawned).toEqual([])
    expect(h.probedPreparations).toEqual([])
  })

  it('starts no probe into a lane whose laneState is absent', async () => {
    const h = harness({ laneStateOf: () => 'absent' })

    const outcome = await h.pull.run()

    expect(outcome.skipped).toEqual([{ laneId: LANE_A, reason: 'lane-absent' }])
    expect(h.spawned).toEqual([])
  })

  it('skips a lane whose switch gate is closed instead of queueing it', async () => {
    const h = harness({ isSwitchInProgress: () => true })

    const outcome = await h.pull.run()

    expect(outcome.skipped).toEqual([{ laneId: LANE_A, reason: 'switch-in-progress' }])
    expect(h.probedPreparations).toEqual([])
  })

  it('drops a stale probe’s result but still syncs the lane it may have rotated', async () => {
    let abort: (() => void) | null = null
    const h = harness({
      fetchUsage: async ({ signal }) => {
        abort?.()
        return signal.aborted ? okUsage(99) : okUsage(1)
      }
    })
    abort = () => h.pull.invalidateLane(LANE_A)

    const outcome = await h.pull.run()

    expect(outcome.probed).toEqual([])
    expect(outcome.skipped).toEqual([{ laneId: LANE_A, reason: 'stale-probe' }])
    expect(h.pull.laneUsage(LANE_A)).toBeNull()
    expect(h.synced).toEqual([LANE_A])
  })

  it('probes each loaded lane and refuses only the lane that is fenced', async () => {
    const h = harness({ isWipePending: (laneId) => laneId === LANE_B }, [
      laneRow(LANE_A),
      laneRow(LANE_B)
    ])

    const outcome = await h.pull.run()

    expect(outcome.probed).toEqual([LANE_A])
    expect(outcome.skipped).toEqual([{ laneId: LANE_B, reason: 'wipe-pending' }])
  })
})

describe('the win32 arm — disabled, not failed (§2k Fact 2)', () => {
  it('runs no probe on win32 and says so', async () => {
    const h = harness({ platform: 'win32' })
    const spy = vi.spyOn(h.deps, 'fetchUsage')

    const outcome = await h.pull.run()

    expect(outcome.disabled).toBe(true)
    expect(outcome.probed).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    expect(h.pull.laneUsage(LANE_A)).toBeNull()
  })
})

/**
 * Per-lane error isolation. `pty.spawn` is unguarded inside `fetchViaPty`'s executor, so a probe
 * really can reject — and this pull sits on the FIRST await of the rate-limit cycle.
 */
describe('a throwing probe', () => {
  it('does not end the tick, and the lanes after it are still probed', async () => {
    const probed: string[] = []
    const h = harness(
      {
        fetchUsage: async ({ authPreparation }) => {
          if (authPreparation.configDir.includes(LANE_A)) {
            throw new Error('spawn ENOENT claude')
          }
          probed.push(authPreparation.configDir)
          return okUsage(7)
        }
      },
      [laneRow(LANE_A), laneRow(LANE_B)]
    )

    const outcome = await h.pull.run()

    expect(outcome.failed).toEqual([LANE_A])
    expect(outcome.probed).toEqual([LANE_B])
    expect(probed).toEqual([`/data/claude-lanes/${LANE_B}`])
  })

  // §2c trigger 2's second arm: the lane may have rotated BEFORE the probe threw, and a watermark
  // left at the pre-probe sha refuses the desktop's next push as `push_stale`.
  it('still syncs the lane it may have rotated, and releases the gate id', async () => {
    const h = harness({
      fetchUsage: async () => {
        throw new Error('spawn ENOENT claude')
      }
    })

    await h.pull.run()

    expect(h.synced).toEqual([LANE_A])
    expect(h.exited).toEqual([h.spawned[0]?.gateId])
  })

  it('publishes no usage row for the lane whose probe threw', async () => {
    const h = harness({
      fetchUsage: async () => {
        throw new Error('spawn ENOENT claude')
      }
    })

    await h.pull.run()

    expect(h.pull.laneUsage(LANE_A)).toBeNull()
  })

  it('survives a post-probe sync that throws', async () => {
    const h = harness({
      syncProbedLane: async () => {
        throw new Error('lane dir swept')
      }
    })

    const outcome = await h.pull.run()

    expect(outcome.probed).toEqual([LANE_A])
    expect(h.pull.laneUsage(LANE_A)?.session?.usedPercent).toBe(42)
  })
})

/**
 * §2k budgets N hidden `claude` processes per tick. The rate-limit cycle reads the auth
 * preparation resolver twice, so the tick has to be idempotent within a cycle.
 */
describe('one tick at a time', () => {
  it('collapses two overlapping ticks into a single probe per lane', async () => {
    let probes = 0
    const h = harness({
      fetchUsage: async () => {
        probes += 1
        await Promise.resolve()
        return okUsage(3)
      }
    })

    const [a, b] = await Promise.all([h.pull.run(), h.pull.run()])

    expect(probes).toBe(1)
    expect(a).toBe(b)
    expect(h.synced).toEqual([LANE_A])
  })

  // Negative control: the guard is per-tick, not once-ever — the next cycle probes again.
  it('probes again on the next tick', async () => {
    const h = harness()

    await h.pull.run()
    await h.pull.run()

    expect(h.probedPreparations).toHaveLength(2)
  })
})
