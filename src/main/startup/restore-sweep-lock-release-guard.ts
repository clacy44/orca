// [S10-21a C7o, D-R122 F1] The desktop startup lock can be released early — before the window
// continuation — when `captureSelfResumeWatermarkSurvivingStoreFailure` (self-resume-watermark-
// capture.ts) catches a failed store open. This guard is the ONLY thing standing between that
// early release and `runStartupRestoreSweepBody` (index.ts) running unlocked: it decides whether
// the sweep body may run, and when it may not, records why loudly — console.error, a durable
// crash breadcrumb, and the same `restore-sweep-done` milestone a real sweep emits (zero layer
// counts) — so the milestone is never silently absent for a boot that skipped the sweep.
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { logStartupMilestone } from './startup-diagnostics'

export const RESTORE_SWEEP_SKIPPED_LOCK_RELEASED_REASON =
  'sweep_lock_released_after_capture_failure' as const

export type RestoreSweepZeroSummary = {
  candidates: 0
  layer1: 0
  layer2: 0
  layer3: 0
  skippedDaemonSurvived: 0
  skippedLeafHeld: 0
  errors: 0
  deferredByReason: Record<string, never>
}

export function buildRestoreSweepSkippedSummary(): RestoreSweepZeroSummary {
  return {
    candidates: 0,
    layer1: 0,
    layer2: 0,
    layer3: 0,
    skippedDaemonSurvived: 0,
    skippedLeafHeld: 0,
    errors: 0,
    deferredByReason: {}
  }
}

export type RestoreSweepLockGuardDeps = {
  logError: (message: string) => void
  logMilestone: (event: string, details: Record<string, unknown>) => void
  recordBreadcrumb: (name: string, data?: CrashReportBreadcrumbData) => void
}

const defaultRestoreSweepLockGuardDeps: RestoreSweepLockGuardDeps = {
  logError: (message) => console.error(message),
  logMilestone: logStartupMilestone,
  recordBreadcrumb: recordDurableCrashBreadcrumb
}

/** Returns true when the caller must run the sweep body (lock still held). Returns false when
 * the lock was already released by the capture-failure callback — the caller must NOT run the
 * body, and this function has already recorded why (loudly, not silently). */
export function runStartupRestoreSweepBodyIfLockHeld(
  desktopSweepLockReleased: boolean,
  releaseErrorClassName: string | null,
  deps: RestoreSweepLockGuardDeps = defaultRestoreSweepLockGuardDeps
): boolean {
  if (!desktopSweepLockReleased) {
    return true
  }
  const errorClass = releaseErrorClassName ?? 'UnknownError'
  deps.logError(
    `[restore-sweep] SKIPPED: the sweep lock was released after the startup capture failed (${errorClass}); panes are not auto-restored this boot — register once per pane`
  )
  deps.recordBreadcrumb('restore_sweep_skipped_lock_released', {
    reason: RESTORE_SWEEP_SKIPPED_LOCK_RELEASED_REASON,
    errorClass
  })
  deps.logMilestone('restore-sweep-done', {
    ...buildRestoreSweepSkippedSummary(),
    reason: RESTORE_SWEEP_SKIPPED_LOCK_RELEASED_REASON
  })
  return false
}
