// S10-21a C6b (Ruling 34 Addendum 19): a direct fence for launchAdmissionBundle's
// `contestedLineage` closure — the admission-side contest audit must be verb 'launch', outcome
// 'contested', attributed to the registered row's own id, and must notice every distinct pane.
import { describe, expect, it, vi } from 'vitest'
import { launchAdmissionBundle } from './pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

describe('S10-21a C6b: launchAdmissionBundle contestedLineage', () => {
  it('writes verb "launch", outcome "contested", agentId = registeredAgentId, and notices both distinct panes', () => {
    const writeAgentAudit = vi.fn()
    const writeHostNoticeToPane = vi.fn()
    const runtimeStub = {
      getOrchestrationCompatibilityHostId: () => 'local',
      getLaunchGenerationId: () => 'gen-1',
      getOrchestrationDb: () => ({ writeAgentAudit }),
      writeHostNoticeToPane
    } as unknown as OrcaRuntimeService

    const { ctx } = launchAdmissionBundle(runtimeStub, null)
    ctx.contestedLineage('tab1:leaf-a', 'tabOLD:leaf-a', 'agent-registered-1')

    expect(writeAgentAudit).toHaveBeenCalledTimes(2)
    for (const call of writeAgentAudit.mock.calls) {
      expect(call[0]).toMatchObject({
        agentId: 'agent-registered-1',
        verb: 'launch',
        outcome: 'contested'
      })
    }
    const auditedPanes = writeAgentAudit.mock.calls.map((call) => call[0].actorPaneKey).sort()
    expect(auditedPanes).toEqual(['tab1:leaf-a', 'tabOLD:leaf-a'])
    expect(writeHostNoticeToPane).toHaveBeenCalledTimes(2)
  })

  it('writes one audit row (not two) and notices once when the two panes coincide', () => {
    const writeAgentAudit = vi.fn()
    const writeHostNoticeToPane = vi.fn()
    const runtimeStub = {
      getOrchestrationCompatibilityHostId: () => 'local',
      getLaunchGenerationId: () => 'gen-1',
      getOrchestrationDb: () => ({ writeAgentAudit }),
      writeHostNoticeToPane
    } as unknown as OrcaRuntimeService

    const { ctx } = launchAdmissionBundle(runtimeStub, null)
    ctx.contestedLineage('tab1:leaf-a', 'tab1:leaf-a', 'agent-registered-1')

    expect(writeAgentAudit).toHaveBeenCalledTimes(1)
    expect(writeAgentAudit.mock.calls[0][0]).toMatchObject({
      agentId: 'agent-registered-1',
      actorPaneKey: 'tab1:leaf-a',
      verb: 'launch',
      outcome: 'contested'
    })
    expect(writeHostNoticeToPane).toHaveBeenCalledTimes(1)
  })
})

// S10-21a C11 (design §8 row C11, T19): snapshot the exact composed text — this IS the loud
// notice §9 promises for an UNRECORDED (Layer-3-eligible) admission and for a contested
// lineage; there is no separate "Layer 3" notice text elsewhere in the tree (grep confirms
// `writeHostNoticeToPane` has exactly these two call sites plus session-identity-mismatch-alarm's
// own two texts — reused, never duplicated).
describe('S10-21a C11: launchAdmissionBundle notice text (snapshot)', () => {
  it('ctx.notice composes "Launch admission: <verb> (<reasonCode>)." verbatim', () => {
    const writeHostNoticeToPane = vi.fn()
    const runtimeStub = {
      getOrchestrationCompatibilityHostId: () => 'local',
      getLaunchGenerationId: () => 'gen-1',
      getOrchestrationDb: () => ({}),
      writeHostNoticeToPane
    } as unknown as OrcaRuntimeService

    const { ctx } = launchAdmissionBundle(runtimeStub, null)
    ctx.notice('tab1:leaf-a', 'launch_host_minted', 'launch_host_minted')

    expect(writeHostNoticeToPane).toHaveBeenCalledWith(
      'tab1:leaf-a',
      'Launch admission: launch_host_minted (launch_host_minted).',
      { rateKey: 'launch_host_minted:launch_host_minted' }
    )
  })

  // agent-launch-admission.ts:205 — `ctx.notice(paneKey, 'launch_unrecorded', reasonCode)` is
  // the ONLY notice an UNRECORDED classification (the Layer-3-eligible case, §C.3/§C.4) ever
  // raises; there is no separate sweep-side Layer-3 notice text to compose or duplicate.
  it('ctx.notice composes the same shape for an UNRECORDED classification (the Layer-3 case)', () => {
    const writeHostNoticeToPane = vi.fn()
    const runtimeStub = {
      getOrchestrationCompatibilityHostId: () => 'local',
      getLaunchGenerationId: () => 'gen-1',
      getOrchestrationDb: () => ({}),
      writeHostNoticeToPane
    } as unknown as OrcaRuntimeService

    const { ctx } = launchAdmissionBundle(runtimeStub, null)
    ctx.notice('tab1:leaf-a', 'launch_unrecorded', 'launch_command_unlocatable')

    expect(writeHostNoticeToPane).toHaveBeenCalledWith(
      'tab1:leaf-a',
      'Launch admission: launch_unrecorded (launch_command_unlocatable).',
      { rateKey: 'launch_unrecorded:launch_command_unlocatable' }
    )
  })

  it('ctx.contestedLineage composes "Launch admission: contested lineage." verbatim', () => {
    const writeAgentAudit = vi.fn()
    const writeHostNoticeToPane = vi.fn()
    const runtimeStub = {
      getOrchestrationCompatibilityHostId: () => 'local',
      getLaunchGenerationId: () => 'gen-1',
      getOrchestrationDb: () => ({ writeAgentAudit }),
      writeHostNoticeToPane
    } as unknown as OrcaRuntimeService

    const { ctx } = launchAdmissionBundle(runtimeStub, null)
    ctx.contestedLineage('tab1:leaf-a', 'tab1:leaf-a', 'agent-registered-1')

    expect(writeHostNoticeToPane).toHaveBeenCalledWith(
      'tab1:leaf-a',
      'Launch admission: contested lineage.',
      { rateKey: 'contested' }
    )
  })
})
