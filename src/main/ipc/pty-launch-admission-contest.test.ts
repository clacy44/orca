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
