// S10-21a C7l (Ruling 34 Addendum 29, item 2b): fails at base — the module does not exist.
import { describe, expect, it } from 'vitest'
import { captureSelfResumeWatermarkAtStartup } from './self-resume-watermark-capture'

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
