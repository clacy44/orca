// S10-21a C7l (Ruling 34 Addendum 29, item 2b): the desktop startup capture call, extracted so
// it is directly testable with a fake runtime — without index.ts's own openMainWindow/lock
// machinery. Thin: delegates to the runtime's own captureSelfResumeWatermark (orca-runtime.ts),
// which captures through the arming getOrchestrationDb() accessor and records absence on a
// store that cannot open.
export type SelfResumeWatermarkCaptureRuntime = {
  captureSelfResumeWatermark(): number | null
}

export function captureSelfResumeWatermarkAtStartup(
  runtime: SelfResumeWatermarkCaptureRuntime
): number | null {
  return runtime.captureSelfResumeWatermark()
}

// [S10-21a C7n, D-R121 N1] `captureSelfResumeWatermark`'s own `getOrchestrationDb()` call
// deliberately propagates a failed store open (C7m/D-R120) — a caller with a lock held across
// the capture must not let that propagate past it. Pure: takes the failure handler as a
// parameter (releases the lock, records the absence) so this is testable without Electron or
// the real lock module.
export function captureSelfResumeWatermarkSurvivingStoreFailure(
  runtime: SelfResumeWatermarkCaptureRuntime,
  onStoreOpenFailed: (error: unknown) => void
): number | null {
  try {
    return captureSelfResumeWatermarkAtStartup(runtime)
  } catch (error) {
    onStoreOpenFailed(error)
    return null
  }
}
