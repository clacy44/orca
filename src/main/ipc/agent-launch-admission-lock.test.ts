// S10-21a C3-v2e, D-R104 F-11: the pane lock's timeout path must clean up its own
// `paneLockTails` entry — before this fix only the success/throw path (inside `fn`'s
// try/finally) did, leaking one map entry per timed-out waiter forever.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  withPaneLock,
  PANE_LOCK_TIMEOUT_MS,
  _paneLockHasTailForTest
} from './agent-launch-admission-lock'
import { LaunchAdmissionRefusedError } from './agent-launch-admission-errors'

describe('S10-21a C3-v2e, D-R104 F-11: withPaneLock timeout cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a timed-out waiter deletes its own paneLockTails entry (no leak)', async () => {
    vi.useFakeTimers()
    const key = `local\0tab-lock-timeout:leaf-a-${Math.random()}`
    let releaseHolder!: () => void
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    // First holder never returns until we release it — forces the second waiter to time out.
    const holder = withPaneLock(key, async () => {
      await holderReleased
      return 'holder-done'
    })

    const waiter = withPaneLock(key, async () => 'waiter-should-not-run')
    const waiterOutcome = waiter.catch((err: unknown) => err)

    await vi.advanceTimersByTimeAsync(PANE_LOCK_TIMEOUT_MS + 1)
    const outcome = await waiterOutcome
    expect(outcome).toBeInstanceOf(LaunchAdmissionRefusedError)
    expect((outcome as LaunchAdmissionRefusedError).reasonCode).toBe('launch_admission_timeout')

    // The timed-out waiter was the newest tail for this key — its own cleanup must have run.
    expect(_paneLockHasTailForTest(key)).toBe(false)

    releaseHolder()
    await expect(holder).resolves.toBe('holder-done')
  })
})
