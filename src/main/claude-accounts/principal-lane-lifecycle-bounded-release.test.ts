/**
 * S9-L1 §fenceWiring "THE LATCH RELEASE", the bounded-budget arm — scoped to its own file because
 * it needs `wipeLaneCredentials` mocked to always throw `logout_incomplete` regardless of real
 * disk state (its own internal `LANE_SWEEP_PASSES` re-read is synchronous with no injectable
 * per-pass hook `attemptWipe` threads through, so the reappearing-credential shape this arm
 * exists for cannot be driven from outside through the real sweep — see
 * `principal-lane-credential-sweep.test.ts` for that module's own re-read coverage instead).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { isLaneWipePending, resetLaneWipePendingForTests } from './lane-wipe-pending'
import { provisionPrincipalLane } from './principal-credential-lane'
import type * as PrincipalLaneCredentialSweep from './principal-lane-credential-sweep'

const wipeMock = vi.fn()
vi.mock('./principal-lane-credential-sweep', async (importOriginal) => {
  const actual = await importOriginal<typeof PrincipalLaneCredentialSweep>()
  return { ...actual, wipeLaneCredentials: (...args: unknown[]) => wipeMock(...args) }
})

const LOGOUT_INCOMPLETE = () =>
  new ClaudeLaneRefusal(
    'accounts.lane.logout_incomplete',
    'Orca swept this Claude credential lane but a credential file kept reappearing in it.'
  )

describe('the bounded-budget wipe-pending mark release', () => {
  let userData = ''
  let lanesRoot = ''
  const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  const laneDir = (laneId: string): string => join(lanesRoot, laneId)

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-bounded-release-'))
    lanesRoot = join(userData, 'claude-lanes')
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
    writeFileSync(join(laneDir(LANE_A), '.credentials.json'), '{}')
    resetLaneWipePendingForTests()
    wipeMock.mockReset()
  })

  afterEach(() => {
    resetLaneWipePendingForTests()
    rmSync(userData, { recursive: true, force: true })
  })

  it('releases the wipe-pending mark once the probe is confirmed dead but the sweep keeps refusing logout_incomplete', async () => {
    const { PrincipalLaneLifecycle } = await import('./principal-lane-lifecycle')
    wipeMock.mockRejectedValue(LOGOUT_INCOMPLETE())
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      // The probe DOES confirm dead — no live claude holds the credential.
      invalidateProbes: async () => {},
      platform: 'linux',
      wait: async () => {}
    })

    const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(false)
    expect(wipeMock).toHaveBeenCalled()
    // The bounded budget (every WIPE_ATTEMPTS attempt genuinely ran the sweep) is exhausted, so
    // the mark itself releases — not only the sequence — rather than staying latched forever.
    expect(isLaneWipePending(LANE_A)).toBe(false)
  })

  it('does NOT release the mark when the probe is never confirmed dead, even after the same number of attempts', async () => {
    const { PrincipalLaneLifecycle } = await import('./principal-lane-lifecycle')
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      // The probe's process never dies: no sweep may even start.
      invalidateProbes: () => new Promise<void>(() => {}),
      platform: 'linux',
      probeDeathTimeoutMs: 5,
      wait: async () => {}
    })

    const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

    expect(outcome.completed).toBe(false)
    // Never even reached — a live process may still hold this lane's credential.
    expect(wipeMock).not.toHaveBeenCalled()
    expect(isLaneWipePending(LANE_A)).toBe(true)
  })

  // MP anchor: the ordinary logout_incomplete-throwing sweep already covers "sweep genuinely ran
  // once", but a real fault (not the named refusal) must not count toward the budget either.
  it('does NOT release the mark when the sweep fails with an unrelated fault rather than logout_incomplete', async () => {
    const { PrincipalLaneLifecycle } = await import('./principal-lane-lifecycle')
    wipeMock.mockRejectedValue(new Error('disk full'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lifecycle = new PrincipalLaneLifecycle({
      resolveLaneDir: (laneId) => laneDir(laneId),
      laneDirExists: (laneId) => existsSync(laneDir(laneId)),
      serializeLaneWrite: (_laneId, run) => run(),
      invalidateProbes: async () => {},
      platform: 'linux',
      wait: async () => {}
    })

    const outcome = await lifecycle.wipeOnExplicitLogout(LANE_A)

    warnSpy.mockRestore()
    expect(outcome.completed).toBe(false)
    expect(isLaneWipePending(LANE_A)).toBe(true)
  })
})
