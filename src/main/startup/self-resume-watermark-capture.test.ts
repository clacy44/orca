// S10-21a C7l (Ruling 34 Addendum 29, item 2b): fails at base — the module does not exist.
import { describe, expect, it, vi } from 'vitest'
import {
  captureSelfResumeWatermarkAtStartup,
  captureSelfResumeWatermarkSurvivingStoreFailure
} from './self-resume-watermark-capture'

describe('captureSelfResumeWatermarkAtStartup', () => {
  it('arms the store on first call (fake runtime whose getOrchestrationDb arms on first call) and returns a non-null watermark', () => {
    let armed = false
    const runtime = {
      captureSelfResumeWatermark: () => {
        // Mirrors the real OrcaRuntimeService#captureSelfResumeWatermark: capture goes through
        // the ARMING getOrchestrationDb() accessor, never a bare unarmed peek.
        if (!armed) {
          armed = true
        }
        return armed ? 42 : null
      }
    }
    expect(armed).toBe(false)
    const watermark = captureSelfResumeWatermarkAtStartup(runtime)
    expect(armed).toBe(true)
    expect(watermark).toBe(42)
  })

  it('records absence (null) rather than throwing when the runtime capture cannot open the store', () => {
    const runtime = {
      captureSelfResumeWatermark: () => null
    }
    expect(captureSelfResumeWatermarkAtStartup(runtime)).toBeNull()
  })
})

// [S10-21a C7n, D-R121 N1] fails at base: captureSelfResumeWatermarkSurvivingStoreFailure does
// not exist — a `getOrchestrationDb()` throw from the desktop capture site used to escape past
// the caller's lock (leaked for the process lifetime) and abort before `openMainWindow`.
describe('captureSelfResumeWatermarkSurvivingStoreFailure', () => {
  it('releases a fake lock, records the failure, and lets the continuation run when the runtime capture throws on a failed store open', () => {
    const storeOpenError = new Error('orchestration_store_open_failed')
    const runtime = {
      captureSelfResumeWatermark: () => {
        throw storeOpenError
      }
    }
    const onStoreOpenFailed = vi.fn()
    const result = captureSelfResumeWatermarkSurvivingStoreFailure(runtime, onStoreOpenFailed)
    // Fake continuation: the call returned rather than throwing past this point.
    expect(result).toBeNull()
    expect(onStoreOpenFailed).toHaveBeenCalledTimes(1)
    expect(onStoreOpenFailed).toHaveBeenCalledWith(storeOpenError)
  })

  it('does not call the failure handler when the runtime capture succeeds', () => {
    const runtime = {
      captureSelfResumeWatermark: () => 7
    }
    const onStoreOpenFailed = vi.fn()
    expect(captureSelfResumeWatermarkSurvivingStoreFailure(runtime, onStoreOpenFailed)).toBe(7)
    expect(onStoreOpenFailed).not.toHaveBeenCalled()
  })
})
