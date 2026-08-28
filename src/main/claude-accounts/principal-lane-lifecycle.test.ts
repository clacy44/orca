import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaneCredentialCoordinator } from './lane-credential-coordinator'
import { isLaneWipePending, resetLaneWipePendingForTests } from './lane-wipe-pending'
import { provisionPrincipalLane } from './principal-credential-lane'
import {
  PrincipalLaneLifecycle,
  principalHasRemainingConnections
} from './principal-lane-lifecycle'
import { prepareLaneLaunch } from './principal-lane-preparation'
import { PrincipalLaneStore } from './principal-lane-store'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

const credentials = (refreshToken: string): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt: Date.now() + 3_600_000 }
  })

/**
 * §2f's lifecycle fence (S9c), kept and adapted for rev 32 (S9-L3, §10(g)): the watermark, the
 * residency index and Orca's own rotation are deleted, so the tests that judged a stale re-push
 * or a rotation call against them go with the deleted mechanism. The fence itself — kill the
 * in-flight probe, confirm it dead, sweep, re-read, only then clear the wipe-pending mark — is
 * unchanged and stays covered below.
 */
describe('the principal lane lifecycle wipe', () => {
  let userData = ''
  let lanesRoot = ''

  const laneDir = (laneId: string): string => join(lanesRoot, laneId)
  const credentialsPath = (laneId: string): string => join(laneDir(laneId), '.credentials.json')

  const makeCoordinator = (): LaneCredentialCoordinator =>
    new LaneCredentialCoordinator({ laneOptions: { lanesRoot, platform: 'linux' } })

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-lifecycle-'))
    lanesRoot = join(userData, 'claude-lanes')
    resetLaneWipePendingForTests()
    for (const laneId of [LANE_A, LANE_B]) {
      provisionPrincipalLane(laneId, { lanesRoot, platform: 'linux' })
      writeFileSync(credentialsPath(laneId), credentials(`rt-${laneId}`))
      writeFileSync(
        join(laneDir(laneId), '.claude.json'),
        JSON.stringify({ oauthAccount: { accountUuid: `acct-${laneId}` }, keep: true })
      )
      writeFileSync(join(laneDir(laneId), 'transcript.jsonl'), 'kept\n')
    }
  })

  afterEach(() => {
    resetLaneWipePendingForTests()
    rmSync(userData, { recursive: true, force: true })
  })

  it('sweeps the credential and leaves the transcripts alone', async () => {
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')
    writeFileSync(join(laneDir(LANE_A), '.credentials.json.9.abc.tmp'), credentials('staged'))

    const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(true)
    expect(outcome.removed).toContain('.credentials.json')
    expect(outcome.removed).toContain('.credentials.json.9.abc.tmp')
    expect(existsSync(credentialsPath(LANE_A))).toBe(false)
    // §2f: the oauthAccount identity goes, the transcripts stay.
    expect(JSON.parse(readFileSync(join(laneDir(LANE_A), '.claude.json'), 'utf-8'))).toEqual({
      keep: true
    })
    expect(readFileSync(join(laneDir(LANE_A), 'transcript.jsonl'), 'utf-8')).toBe('kept\n')
    expect(lanes.store.getLaneState(LANE_A)).toBe('absent')
    // The other lane is untouched.
    expect(existsSync(credentialsPath(LANE_B))).toBe(true)
  })

  it('clears the wipe-pending mark only on the clean post-sweep read-back', async () => {
    const lanes = makeCoordinator()
    const marks: boolean[] = []
    const realInvalidate = lanes.invalidateLaneUsageProbes.bind(lanes)
    vi.spyOn(lanes, 'invalidateLaneUsageProbes').mockImplementation(async (laneId) => {
      await realInvalidate(laneId)
      marks.push(isLaneWipePending(laneId))
    })

    await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

    // The mark is already set by the time the kill half runs, and only lifted after this — a
    // clean sweep must never leave it set past a completed wipe.
    expect(marks).toEqual([true])
    expect(isLaneWipePending(LANE_A)).toBe(false)
  })

  it('kills the in-flight probe and waits for its claude to die before sweeping', async () => {
    const order: string[] = []
    const lanes = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' },
      // A real probe is a `claude` under the lane's config dir, and §2c's `cli-observed` cause
      // exists because such a CLI writes a rotated `.credentials.json` back as it goes.
      fetchLaneUsage: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              order.push('probe-wrote-back')
              writeFileSync(credentialsPath(LANE_A), credentials('rotated-by-the-probe'))
              reject(new Error('aborted'))
            }, 5)
          })
        })
    })
    await lanes.syncLane(LANE_A, 'launch')
    const pull = lanes.pullLaneUsage()
    await Promise.resolve()

    const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)
    order.push('swept')
    await pull

    expect(order).toEqual(['probe-wrote-back', 'swept'])
    expect(outcome.completed).toBe(true)
    // The wipe promise is only true if the sweep ran AFTER the dying CLI's write.
    expect(existsSync(credentialsPath(LANE_A))).toBe(false)
    expect(lanes.store.getLaneState(LANE_A)).toBe('absent')
    expect(lanes.laneUsage(LANE_A)).toBeNull()
  })

  it('refuses a probe requested while the wipe is pending', async () => {
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')
    let sawSkip: string | undefined
    const wipe = lanes.lifecycle.wipeOnExplicitLogout(LANE_A)
    const pulled = await lanes.pullLaneUsage()
    sawSkip = pulled.skipped.find((row) => row.laneId === LANE_A)?.reason
    await wipe

    expect(sawSkip).toBe('wipe-pending')
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'leaves the mark set and reports the wipe NOT done when the sweep cannot finish',
    async () => {
      const lanes = makeCoordinator()
      await lanes.syncLane(LANE_A, 'launch')
      // A directory the sweep cannot unlink from: the credential is still at rest afterwards.
      chmodSync(laneDir(LANE_A), 0o500)

      const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)
      chmodSync(laneDir(LANE_A), 0o700)

      expect(outcome.completed).toBe(false)
      expect(existsSync(credentialsPath(LANE_A))).toBe(true)
      // §2f: nothing may state the credential is gone while this is set.
      expect(isLaneWipePending(LANE_A)).toBe(true)
    }
  )

  it('does not sweep at all when the probe cannot be confirmed dead in the window', async () => {
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      // The probe's process never dies: the fence must hold rather than sweep past it.
      invalidateProbes: () => new Promise<void>(() => {}),
      platform: 'linux',
      probeDeathTimeoutMs: 5
    })

    const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(false)
    // The credential is still on disk: the sweep never ran past the unconfirmed probe.
    expect(existsSync(credentialsPath(LANE_A))).toBe(true)
    expect(isLaneWipePending(LANE_A)).toBe(true)
  })

  it('reports the wipe NOT done for a lane directory it cannot prove it owns', async () => {
    // A lost or unreadable ownership marker is the shape a failed Windows DACL verification and an
    // interrupted provision both leave behind — and the directory still holds a full credential.
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')
    rmSync(join(laneDir(LANE_A), '.orca-principal-lane'))

    const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(false)
    expect(existsSync(credentialsPath(LANE_A))).toBe(true)
    // Latched, so every launch into that lane keeps failing closed rather than reading `absent`
    // for an unrelated reason.
    expect(isLaneWipePending(LANE_A)).toBe(true)
  })

  it('leaves an unprovable lane on disk and says the revoke removed nothing', async () => {
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')
    rmSync(join(laneDir(LANE_A), '.orca-principal-lane'))

    const outcome = await lanes.lifecycle.removeLaneOnLastGrantRevoked(LANE_A)

    expect(outcome).toMatchObject({ completed: false, laneRemoved: false })
    expect(existsSync(credentialsPath(LANE_A))).toBe(true)
  })

  it('reports nothing to wipe for a principal that has no lane directory', async () => {
    const lanes = makeCoordinator()
    rmSync(laneDir(LANE_A), { recursive: true, force: true })

    const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(true)
    expect(isLaneWipePending(LANE_A)).toBe(false)
  })

  it('publishes the lane change on the give-up arm too, so switches are refused', async () => {
    const changed: string[] = []
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      invalidateProbes: () => new Promise<void>(() => {}),
      platform: 'linux',
      probeDeathTimeoutMs: 5,
      onLaneWiped: (laneId) => changed.push(laneId)
    })

    const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(false)
    // The listener refuses outstanding switch requests by name and republishes the status: the
    // give-up arm is where a waiting switch would otherwise hang to its own timeout.
    expect(changed).toEqual([LANE_A])
  })

  it('`orca lane wipe --force` releases a latched mark left by a give-up arm and republishes', async () => {
    const changed: string[] = []
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      invalidateProbes: () => new Promise<void>(() => {}),
      platform: 'linux',
      probeDeathTimeoutMs: 5,
      onLaneWiped: (laneId) => changed.push(laneId)
    })
    await lifecycle.wipeOnExplicitLogout(LANE_A)
    expect(isLaneWipePending(LANE_A)).toBe(true)
    changed.length = 0

    const released = lifecycle.forceReleaseWipeLatch(LANE_A)

    expect(released).toBe(true)
    expect(isLaneWipePending(LANE_A)).toBe(false)
    // Republished, same listener the automatic arms use — a subscriber must not need to poll.
    expect(changed).toEqual([LANE_A])
  })

  it('`orca lane wipe --force` reports nothing released for a lane that is not latched', () => {
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      invalidateProbes: async () => {},
      platform: 'linux'
    })

    expect(lifecycle.forceReleaseWipeLatch(LANE_A)).toBe(false)
  })

  it('sweeps a lane that crashed holding only a staged .tmp credential blob', async () => {
    // `writeFileAtomically` stages at `<target>.<pid>.<uuid>.tmp` and unlinks it only on a THROWN
    // error, so a crash between the write and the rename leaves a full credential at 0600 under a
    // name no `.credentials.json` predicate selects — and that lane is never swept at all.
    rmSync(credentialsPath(LANE_A))
    const staged = join(laneDir(LANE_A), '.credentials.json.9.abcd.tmp')
    writeFileSync(staged, credentials('rt-staged'))
    const lanes = makeCoordinator()

    const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(true)
    expect(existsSync(staged)).toBe(false)
  })

  it('fails a lane launch closed while the wipe is pending, credential still on disk', async () => {
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      invalidateProbes: () => new Promise<void>(() => {}),
      platform: 'linux',
      probeDeathTimeoutMs: 5
    })
    const store = new PrincipalLaneStore({ lanesRoot, platform: 'linux' })

    const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(false)
    expect(existsSync(credentialsPath(LANE_A))).toBe(true)
    // §2f separates the two properties: launches key on `laneState`, so it reads `absent` here…
    expect(store.getLaneState(LANE_A)).toBe('absent')
    // …and the launch itself must not be handed the blob the host has declared wipe-pending.
    expect(() => prepareLaneLaunch({ principalId: LANE_A, lanesRoot, platform: 'linux' })).toThrow(
      /clearing your Claude account/i
    )
  })

  it('removes the revoked lane inside the same write queue the sweep took', async () => {
    const queue: string[] = []
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: async (_laneId, run) => {
        queue.push('enter')
        try {
          return await run()
        } finally {
          queue.push(existsSync(laneDir(LANE_A)) ? 'exit:lane-present' : 'exit:lane-removed')
        }
      },
      invalidateProbes: () => Promise.resolve(),
      platform: 'linux'
    })

    const outcome = await lifecycle.removeLaneOnLastGrantRevoked(LANE_A)

    expect(outcome.laneRemoved).toBe(true)
    // A write that entered the queue between the sweep and the removal would otherwise be told it
    // succeeded and then have its whole lane directory taken out from under it.
    expect(queue).toEqual(['enter', 'exit:lane-removed'])
  })

  it('removes the directory only on the last-grant revoke', async () => {
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')

    const outcome = await lanes.lifecycle.removeLaneOnLastGrantRevoked(LANE_A)

    expect(outcome.laneRemoved).toBe(true)
    expect(existsSync(laneDir(LANE_A))).toBe(false)
    expect(existsSync(laneDir(LANE_B))).toBe(true)
  })

  it('logs out one lane without touching the other', async () => {
    // S9-L1: no startup batch wipe any more — each lane's logout is its own explicit act.
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')
    await lanes.syncLane(LANE_B, 'launch')

    const outcome = await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(true)
    expect(existsSync(credentialsPath(LANE_A))).toBe(false)
    expect(existsSync(credentialsPath(LANE_B))).toBe(true)
  })

  it('removes the directory and its credential on deprovision', async () => {
    const lanes = makeCoordinator()
    await lanes.syncLane(LANE_A, 'launch')

    const outcome = await lanes.lifecycle.removeLaneOnDeprovision(LANE_A, (dir) =>
      rmSync(dir, { recursive: true, force: true })
    )

    expect(outcome.laneRemoved).toBe(true)
    expect(existsSync(laneDir(LANE_A))).toBe(false)
    expect(existsSync(laneDir(LANE_B))).toBe(true)
  })

  /**
   * S9-L1 §fenceWiring "session side": `cancelLaneLoginSessions` (sync, state-transition only)
   * and `sweepCancelledLoginDirs` (async, destructive) are the two new deps a login session
   * registry hands the lifecycle. These tests pin the three call sites and their ordering
   * against the SHIPPED `wipe()`/`refuseWipe()`/missing-directory arms directly — no login
   * session registry involved, just recorder functions standing in for its two exports.
   */
  describe('S9-L1 §fenceWiring session-side wiring', () => {
    it('cancels every in-flight login session in the SAME synchronous step as the mark, before the queue/sweep', async () => {
      const order: string[] = []
      const lifecycle = new PrincipalLaneLifecycle({
        resolveLaneDir: (laneId) => laneDir(laneId),
        laneDirExists: (laneId) => existsSync(laneDir(laneId)),
        serializeLaneWrite: async (laneId, run) => {
          order.push(`queue-enter:${laneId}`)
          return run()
        },
        invalidateProbes: () => Promise.resolve(),
        platform: 'linux',
        cancelLaneLoginSessions: (laneId) => order.push(`cancel:${laneId}`),
        sweepCancelledLoginDirs: async (laneId) => {
          order.push(`sweep-dirs:${laneId}`)
        }
      })

      const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

      expect(outcome.completed).toBe(true)
      // The cancel fires BEFORE the queue is ever entered — it is not a member of the queue, it
      // is taken alongside the mark that gates entry into it — and the destructive sweep runs
      // only once inside that same turn, ahead of the credential sweep it shares the turn with.
      expect(order).toEqual([`cancel:${LANE_A}`, `queue-enter:${LANE_A}`, `sweep-dirs:${LANE_A}`])
    })

    it('cancels login sessions on the refuseWipe arm too, deferring the destructive sweep (no queue turn held there)', async () => {
      const cancelled: string[] = []
      const swept: string[] = []
      const lifecycle = new PrincipalLaneLifecycle({
        resolveLaneDir: () => null, // unprovable ownership, but SOMETHING is at that path
        laneDirExists: () => true,
        serializeLaneWrite: (_laneId, run) => run(),
        invalidateProbes: () => Promise.resolve(),
        platform: 'linux',
        cancelLaneLoginSessions: (laneId) => cancelled.push(laneId),
        sweepCancelledLoginDirs: async (laneId) => {
          swept.push(laneId)
        }
      })

      const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

      expect(outcome.completed).toBe(false)
      expect(cancelled).toEqual([LANE_A])
      expect(swept).toEqual([])
    })

    it('cancels login sessions on the missing-directory fast path, where no mark is ever taken', async () => {
      const cancelled: string[] = []
      const lifecycle = new PrincipalLaneLifecycle({
        resolveLaneDir: () => null,
        laneDirExists: () => false, // nothing at rest at all — the arm a naive edit misses
        serializeLaneWrite: (_laneId, run) => run(),
        invalidateProbes: () => Promise.resolve(),
        platform: 'linux',
        cancelLaneLoginSessions: (laneId) => cancelled.push(laneId)
      })

      const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

      expect(outcome.completed).toBe(true)
      expect(cancelled).toEqual([LANE_A])
      // Nothing was at rest and no mark was set on this arm — the induction premise the OTHER
      // two arms rely on does not apply here, and nothing should have latched a mark either.
      expect(isLaneWipePending(LANE_A)).toBe(false)
    })

    it('the coordinator wires a REAL LaneLoginSessionRegistry into the lifecycle — not a stub with no caller', async () => {
      // Closes the S9-L1 review's standing blocker: every module this slice ships must be
      // reached from production code. `LaneCredentialCoordinator` is the composition root
      // `runtime-auth-service.ts` constructs in production.
      const lanes = makeCoordinator()
      await lanes.syncLane(LANE_A, 'launch')
      const sessionsBefore = lanes.loginSessions.statusOf('anything')
      expect(sessionsBefore).toBeNull() // real registry, real (empty) map — not undefined/a stub

      const cancelSpy = vi.spyOn(lanes.loginSessions, 'cancelLaneLoginSessions')
      const sweepSpy = vi.spyOn(lanes.loginSessions, 'sweepCancelledLoginDirs')

      await lanes.lifecycle.wipeOnExplicitLogout(LANE_A)

      expect(cancelSpy).toHaveBeenCalledWith(LANE_A)
      expect(sweepSpy).toHaveBeenCalledWith(LANE_A)
    })
  })
})

describe('the close predicate', () => {
  const principals = new Map([
    ['desktop-a', LANE_A],
    ['phone-a', LANE_A],
    ['desktop-b', LANE_B]
  ])
  const principalOf = (deviceId: string): string | null => principals.get(deviceId) ?? null

  it("counts sockets across ALL of the principal's grants, not one grant", () => {
    // The phone is still connected: the desktop's last socket closing wipes nothing.
    expect(
      principalHasRemainingConnections({
        principalId: LANE_A,
        connectedDeviceIds: ['phone-a'],
        principalOf
      })
    ).toBe(true)
    // Another PERSON's grant is not this principal's.
    expect(
      principalHasRemainingConnections({
        principalId: LANE_A,
        connectedDeviceIds: ['desktop-b'],
        principalOf
      })
    ).toBe(false)
  })

  it('reports no survivor for a grant bound to nobody', () => {
    expect(
      principalHasRemainingConnections({
        principalId: LANE_A,
        connectedDeviceIds: ['unbound-device'],
        principalOf
      })
    ).toBe(false)
  })
})
