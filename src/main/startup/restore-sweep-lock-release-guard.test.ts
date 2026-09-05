// [S10-21a C7o, D-R122 F1] Drives the extracted startup step directly — no Electron, no
// index.ts's own openMainWindow/lock machinery — mirroring self-resume-watermark-capture.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { captureSelfResumeWatermarkSurvivingStoreFailure } from './self-resume-watermark-capture'
import {
  buildRestoreSweepSkippedSummary,
  RESTORE_SWEEP_SKIPPED_LOCK_RELEASED_REASON,
  runStartupRestoreSweepBodyIfLockHeld
} from './restore-sweep-lock-release-guard'

describe('restore sweep lock release guard (S10-21a C7o, D-R122 F1)', () => {
  it('with a runtime whose getOrchestrationDb throws at capture, releases the lock, opens the window continuation, and never invokes the sweep body — the milestone/breadcrumb carries the reason', () => {
    const releaseLock = vi.fn()
    let desktopSweepLockReleased = false
    let releaseErrorClassName: string | null = null

    // Why: mirrors D-R122 fact (a)/(b) — an armer throw inside getOrchestrationDb at capture time.
    const throwingRuntime = {
      captureSelfResumeWatermark: () => {
        throw new TypeError('orchestration store open failed')
      }
    }

    // Step 1 — the capture site (index.ts): the failure is caught, the lock releases, and
    // startup's window continuation proceeds (represented here by control simply returning).
    captureSelfResumeWatermarkSurvivingStoreFailure(throwingRuntime, (error) => {
      releaseLock()
      desktopSweepLockReleased = true
      releaseErrorClassName = error instanceof Error ? error.constructor.name : typeof error
    })

    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(desktopSweepLockReleased).toBe(true)

    // Step 2 — the later call site (index.ts ~:3417), reached after the window continuation and
    // startup barriers: the guard must refuse to run the sweep body because the lock is gone.
    const runSweepBody = vi.fn()
    const logError = vi.fn()
    const logMilestone = vi.fn()
    const recordBreadcrumb = vi.fn()

    const shouldRunBody = runStartupRestoreSweepBodyIfLockHeld(
      desktopSweepLockReleased,
      releaseErrorClassName,
      { logError, logMilestone, recordBreadcrumb }
    )
    if (shouldRunBody) {
      runSweepBody()
    }

    expect(shouldRunBody).toBe(false)
    expect(runSweepBody).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      '[restore-sweep] SKIPPED: the sweep lock was released after the startup capture failed (TypeError); panes are not auto-restored this boot — register once per pane'
    )
    expect(recordBreadcrumb).toHaveBeenCalledWith('restore_sweep_skipped_lock_released', {
      reason: RESTORE_SWEEP_SKIPPED_LOCK_RELEASED_REASON,
      errorClass: 'TypeError'
    })
    expect(logMilestone).toHaveBeenCalledWith('restore-sweep-done', {
      ...buildRestoreSweepSkippedSummary(),
      reason: RESTORE_SWEEP_SKIPPED_LOCK_RELEASED_REASON
    })
  })

  it('runs the sweep body normally, with no skip logging, when the lock is still held', () => {
    const runSweepBody = vi.fn()
    const logError = vi.fn()
    const logMilestone = vi.fn()
    const recordBreadcrumb = vi.fn()

    const shouldRunBody = runStartupRestoreSweepBodyIfLockHeld(false, null, {
      logError,
      logMilestone,
      recordBreadcrumb
    })
    if (shouldRunBody) {
      runSweepBody()
    }

    expect(shouldRunBody).toBe(true)
    expect(runSweepBody).toHaveBeenCalledTimes(1)
    expect(logError).not.toHaveBeenCalled()
    expect(logMilestone).not.toHaveBeenCalled()
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})
