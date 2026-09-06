// [S10-21a C15b, D-R129 F1/F3/F4] Extracted from App.tsx's `sweep-restore-marks-hydrate` step so
// the terminal-path gate and the timeout-loudness are exercisable without mounting the full app.
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import type { SweepRestoreMarkListReply } from '../../../shared/sweep-restore-mark-list'
import { logRendererStartupDiagnostic } from './startup-diagnostics'
import { recordRendererCrashBreadcrumb } from '../lib/crash-breadcrumb-recorder'

/** [S10-21a C15b, F3] `sweepIncomplete` was written and never read (R52 reopens silently on the
 * 30s timeout). Chair call: adopt the pre-sweep view anyway (deferring forever is F1's failure
 * mode) but record it loudly — console.error plus the existing renderer→main startup-diagnostics
 * channel (`logRendererStartupDiagnostic` -> `window.api.app.startupDiagnostic` ->
 * `app:startupDiagnostic`, src/main/index.ts:913; opt-in via ORCA_STARTUP_DIAGNOSTICS, so
 * console.error remains the always-on record). */
export function applySweepRestoreMarkListReply(reply: SweepRestoreMarkListReply): void {
  useAppStore.getState().setSweepRestoredPaneKeys(reply.paneKeys)
  if (reply.sweepIncomplete) {
    console.error(
      '[startup] sweepRestoreMarkList timed out waiting for the sweep lock; adopting the pre-sweep marks:',
      reply.paneKeys
    )
    logRendererStartupDiagnostic('sweep-restore-marks-incomplete', {
      paneKeyCount: reply.paneKeys.length
    })
    // [S10-21a C15c, D-R131 N1] console.error alone is invisible in a packaged build (nothing
    // forwards renderer console, and startupDiagnostic is dropped unless
    // ORCA_STARTUP_DIAGNOSTICS) — the crash-breadcrumb channel is ungated and durable.
    recordRendererCrashBreadcrumb('sweep_restore_marks_incomplete', {
      paneCount: reply.paneKeys.length
    })
  }
}

/** [S10-21a C15b, F1/F4] `sweepRestoreMarksHydrated` must be set exactly once on EVERY terminal
 * path of the startup chain (the success/timeout finally, and the outer catch — any throw above
 * or after the hydrate step must not leave it false for the process lifetime, forcing every pane
 * "already restored" forever). `cancelled` short-circuits the whole thing: a torn-down StrictMode
 * pass must not flip the flag or replay (App.tsx's own dev-mount/unmount convention). Idempotent —
 * a second call (e.g. the catch after the try's own finally already ran) is a no-op, so
 * `loudReason` is logged only on the call that actually terminates the gate. */
export function finalizeSweepRestoreMarksHydration(
  cancelled: boolean,
  loudReason: string | null
): void {
  if (cancelled) {
    return
  }
  const state = useAppStore.getState()
  if (state.sweepRestoreMarksHydrated) {
    return
  }
  if (loudReason) {
    console.error(
      '[startup] sweepRestoreMarksHydrated forced true from a non-success startup path (mark set left at its default):',
      loudReason
    )
    // [S10-21a C15c, D-R131 N1] Same durability gap as the timeout case above.
    recordRendererCrashBreadcrumb('sweep_restore_marks_forced', {
      stepLabel: loudReason,
      paneCount: state.sweepRestoredPaneKeys.size
    })
  }
  state.setSweepRestoreMarksHydrated(true)
  for (const worktreeId of state.takePendingSweepMarksResumeWorktreeIds()) {
    resumeSleepingAgentSessionsForWorktree(worktreeId)
  }
  for (const wake of state.takePendingSweepMarksResumeWakes()) {
    wake()
  }
}

/** [S10-21a C15c, D-R131 N5] The outer catch's variant of `finalizeSweepRestoreMarksHydration`:
 * a throw ABOVE the hydrate step means it never ran, so the mark set is still the empty default
 * — finalizing straight away would adopt "nothing restored" even when marks exist. Best-effort
 * re-read first (bounded: `awaitRestoreSweepLockRelease` resolves `'not-held'` synchronously
 * when no sweep holds the lock, and by the same 30s bound otherwise); on failure, proceed exactly
 * as before (never blocks the gate). No-op re-read if the finally already hydrated. */
export async function finalizeSweepRestoreMarksHydrationFromCatch(
  cancelled: boolean,
  loudReason: string | null
): Promise<void> {
  if (!cancelled && !useAppStore.getState().sweepRestoreMarksHydrated) {
    try {
      const reply = await window.api.session.sweepRestoreMarkList()
      applySweepRestoreMarkListReply(reply)
    } catch (error) {
      console.warn('[startup] sweepRestoreMarkList best-effort catch-path read failed:', error)
    }
  }
  finalizeSweepRestoreMarksHydration(cancelled, loudReason)
}
