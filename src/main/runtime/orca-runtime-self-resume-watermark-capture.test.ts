// S10-21a C7l (Ruling 34 Addendum 29, item 2c): `captureSelfResumeWatermark` must capture
// through the ARMING `getOrchestrationDb()` accessor, not a bare `_orchestrationDb` peek — a
// store nothing has attached yet must still be armed and read, not silently skipped forever.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

describe('OrcaRuntimeService#captureSelfResumeWatermark', () => {
  it('arms the store (calls getOrchestrationDb) and returns a non-null watermark when it opens', () => {
    const runtime = new OrcaRuntimeService()
    const orchestrationDb = new OrchestrationDb(':memory:')
    // A fresh DB's agent_audit is empty — newestAgentAuditSeq() is null with nothing seeded;
    // one row gives the watermark something real to read, matching production (the sweep never
    // captures against a genuinely empty audit table in practice).
    orchestrationDb.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: null,
      verb: 'sweep_note',
      outcome: 'proceeded',
      reasonCode: 'seed_for_watermark_test'
    })
    const getOrchestrationDb = vi.fn(() => orchestrationDb)
    runtime.getOrchestrationDb = getOrchestrationDb

    const watermark = runtime.captureSelfResumeWatermark()

    expect(getOrchestrationDb).toHaveBeenCalledTimes(1)
    expect(watermark).not.toBeNull()
    expect(typeof watermark).toBe('number')
    expect(runtime.getSelfResumeWatermark()).toBe(watermark)
    orchestrationDb.close()
  })

  // [S10-21a C7m, Ruling 34 Addendum 30, item 5, SCENARIO_CORRECTION] Was:
  //   expect(() => runtime.captureSelfResumeWatermark()).not.toThrow()
  //   expect(runtime.captureSelfResumeWatermark()).toBeNull()
  // Addendum 30 requires `getOrchestrationDb()` to run OUTSIDE the try — an arming failure must
  // PROPAGATE to the startup path's own loud handler, never be swallowed a second time here.
  it('an arming failure (getOrchestrationDb throws) PROPAGATES — the caller, not this method, degrades loudly (fails at base)', () => {
    const runtime = new OrcaRuntimeService()
    runtime.getOrchestrationDb = () => {
      throw new Error('store open failed')
    }

    expect(() => runtime.captureSelfResumeWatermark()).toThrow('store open failed')
    expect(runtime.getSelfResumeWatermark()).toBeNull()
  })

  it('a half-armed capture (the store opens but the seq read throws) never throws, logs watermark_capture_partial_arm, watermark stays absent (fails at base)', () => {
    const runtime = new OrcaRuntimeService()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fakeDb = {
      newestAgentAuditSeq: () => {
        throw new Error('seq read failed')
      }
    } as unknown as OrchestrationDb
    // Mirrors a real arming `getOrchestrationDb()`: it both returns the store AND leaves
    // `_orchestrationDb` set, so the "half-armed" branch (`if (this._orchestrationDb)`) sees it.
    runtime.getOrchestrationDb = () => {
      ;(runtime as unknown as { _orchestrationDb: OrchestrationDb | null })._orchestrationDb =
        fakeDb
      return fakeDb
    }

    expect(() => runtime.captureSelfResumeWatermark()).not.toThrow()
    expect(runtime.getSelfResumeWatermark()).toBeNull()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('watermark_capture_partial_arm: seq read failed')
    )
    consoleError.mockRestore()
  })
})
