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

  it('records absence (null), never throws, when getOrchestrationDb throws (store open failure)', () => {
    const runtime = new OrcaRuntimeService()
    runtime.getOrchestrationDb = () => {
      throw new Error('store open failed')
    }

    expect(() => runtime.captureSelfResumeWatermark()).not.toThrow()
    expect(runtime.captureSelfResumeWatermark()).toBeNull()
    expect(runtime.getSelfResumeWatermark()).toBeNull()
  })
})
