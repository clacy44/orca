// S10-21a C8 (design v3.2 §2.8, "unchanged from v2's C7"; T10): the mint-ordering fix —
// `refreshDerivedAgentsFromLiveGraph` must yield to the restore sweep rather than minting a
// derived placeholder for a pane the sweep is mid-restore on.
import { afterEach, describe, expect, it } from 'vitest'
import { refreshDerivedAgentsFromLiveGraph } from './agent-directory-rpc-liveness'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

const HOST_ID = 'local'
const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_a',
    ptyId: 'pty-a',
    worktreeId: 'wt_1',
    worktreePath: '/repo/alpha',
    branch: 'alpha',
    tabId: 'tabA',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'alpha work',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('refreshDerivedAgentsFromLiveGraph: C8 mint-ordering fix (T10)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  afterEach(() => {
    db?.close()
  })

  it('T10a: a live restore ticket naming the pane mints NO derived row for it', async () => {
    setup()
    runtime.mintRestoreTicket({
      predecessorPaneKey: PANE_A,
      sessionId: 'sess-a',
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      launchGeneration: runtime.getLaunchGenerationId()
    })
    const listSpy = async (): ReturnType<OrcaRuntimeService['listTerminals']> => ({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    runtime.listTerminals = listSpy as unknown as OrcaRuntimeService['listTerminals']

    await refreshDerivedAgentsFromLiveGraph(runtime, db, HOST_ID)

    const { agents } = db.listAgents({ hostId: HOST_ID, includeDerived: true, limit: 200 })
    expect(agents.find((a) => a.pane_key === PANE_A)).toBeUndefined()
  })

  it('T10b: a same-generation pending launch row (no rebound agent) mints NO derived row', async () => {
    setup()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: PANE_B,
      agentType: 'claude',
      sessionId: 'sess-b',
      launchGeneration: runtime.getLaunchGenerationId(),
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      evidence: 'sweep_record'
    })
    const listSpy = async (): ReturnType<OrcaRuntimeService['listTerminals']> => ({
      terminals: [
        terminal({
          handle: 'term_b',
          ptyId: 'pty-b',
          tabId: 'tabB',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        })
      ],
      totalCount: 1,
      truncated: false
    })
    runtime.listTerminals = listSpy as unknown as OrcaRuntimeService['listTerminals']

    await refreshDerivedAgentsFromLiveGraph(runtime, db, HOST_ID)

    const { agents } = db.listAgents({ hostId: HOST_ID, includeDerived: true, limit: 200 })
    expect(agents.find((a) => a.pane_key === PANE_B)).toBeUndefined()
  })

  it('T10c: fence — a same-generation launch row already rebound, and an ordinary pane with no launch row, still mint normally', async () => {
    setup()
    const recorded = db.recordLaunch({
      hostId: HOST_ID,
      paneKey: PANE_B,
      agentType: 'claude',
      sessionId: 'sess-b',
      launchGeneration: runtime.getLaunchGenerationId(),
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      evidence: 'sweep_record'
    })
    if (!recorded.ok) {
      throw new Error('fixture setup failed: recordLaunch refused')
    }
    db.setLaunchAgentId({ seq: recorded.row.seq }, 'agt_prebound')
    db.setSweepRestoreMark(HOST_ID, PANE_B)

    const listSpy = async (): ReturnType<OrcaRuntimeService['listTerminals']> => ({
      terminals: [
        terminal({
          handle: 'term_b',
          ptyId: 'pty-b',
          tabId: 'tabB',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        }),
        terminal({
          handle: 'term_c',
          ptyId: 'pty-c',
          tabId: 'tabC',
          leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          title: 'ordinary pane'
        })
      ],
      totalCount: 2,
      truncated: false
    })
    runtime.listTerminals = listSpy as unknown as OrcaRuntimeService['listTerminals']

    await refreshDerivedAgentsFromLiveGraph(runtime, db, HOST_ID)

    const { agents } = db.listAgents({ hostId: HOST_ID, includeDerived: true, limit: 200 })
    expect(agents.find((a) => a.pane_key === PANE_B)).toBeDefined()
    expect(agents.find((a) => a.pane_key === PANE_C)).toBeDefined()
  })
})
