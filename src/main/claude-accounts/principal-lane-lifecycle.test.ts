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
import { wipeResidentLanesAtStartup } from './principal-lane-startup-wipe'

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

  const runStartupPass = () =>
    wipeResidentLanesAtStartup({ laneOptions: { lanesRoot, platform: 'linux' } })

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

    const outcome = await lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)

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

    await lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)

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

    const outcome = await lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)
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
    const wipe = lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)
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

      const outcome = await lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)
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

    const outcome = await lifecycle.wipeOnLastConnectionClose(LANE_A)

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

    const outcome = await lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)

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

    const outcome = await lanes.lifecycle.wipeOnLastConnectionClose(LANE_A)

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

    const outcome = await lifecycle.wipeOnLastConnectionClose(LANE_A)

    expect(outcome.completed).toBe(false)
    // The listener refuses outstanding switch requests by name and republishes the status: the
    // give-up arm is where a waiting switch would otherwise hang to its own timeout.
    expect(changed).toEqual([LANE_A])
  })

  it('starts no lane wipe once the startup pass has spent its budget', async () => {
    const outcomes = await wipeResidentLanesAtStartup({
      laneOptions: { lanesRoot, platform: 'linux' },
      budgetMs: 0
    })

    // Bounded because this pass is awaited in front of the app window; the lanes it could not
    // reach stay wipe-pending rather than being reported wiped.
    expect(outcomes.every((row) => row.completed)).toBe(false)
    expect(existsSync(credentialsPath(LANE_A))).toBe(true)
    expect(isLaneWipePending(LANE_A)).toBe(true)
  })

  it('sweeps a lane that crashed holding only a staged .tmp credential blob', async () => {
    // `writeFileAtomically` stages at `<target>.<pid>.<uuid>.tmp` and unlinks it only on a THROWN
    // error, so a crash between the write and the rename leaves a full credential at 0600 under a
    // name no `.credentials.json` predicate selects — and that lane is never swept at all.
    rmSync(credentialsPath(LANE_A))
    const staged = join(laneDir(LANE_A), '.credentials.json.9.abcd.tmp')
    writeFileSync(staged, credentials('rt-staged'))

    const outcomes = await runStartupPass()

    expect(outcomes.map((row) => row.laneId)).toContain(LANE_A)
    expect(outcomes.every((row) => row.completed)).toBe(true)
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

    const outcome = await lifecycle.wipeOnLastConnectionClose(LANE_A)

    expect(outcome.completed).toBe(false)
    expect(existsSync(credentialsPath(LANE_A))).toBe(true)
    // §2f separates the two properties: launches key on `laneState`, so it reads `absent` here…
    expect(store.getLaneState(LANE_A)).toBe('absent')
    // …and the launch itself must not be handed the blob the host has declared wipe-pending.
    expect(() => prepareLaneLaunch({ principalId: LANE_A, lanesRoot, platform: 'linux' })).toThrow(
      /clearing your Claude account/i
    )
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'returns empty rather than throwing when the lanes root cannot be read',
    async () => {
      // The startup wipe is AWAITED inside `whenReady`, whose chain has no `.catch`: an EACCES or
      // a Windows Protected-DACL EPERM here would take the window and the RPC server with it.
      chmodSync(lanesRoot, 0o000)

      const outcomes = await runStartupPass()
      chmodSync(lanesRoot, 0o700)

      expect(outcomes).toEqual([])
    }
  )

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

  it('wipes every resident lane at startup, with nothing left holding a credential', async () => {
    const outcomes = await runStartupPass()

    expect(outcomes.map((row) => row.laneId).sort()).toEqual([LANE_A, LANE_B].sort())
    expect(outcomes.every((row) => row.completed)).toBe(true)
    expect(existsSync(credentialsPath(LANE_A))).toBe(false)
    expect(existsSync(credentialsPath(LANE_B))).toBe(false)
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
