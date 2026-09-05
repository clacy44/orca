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
