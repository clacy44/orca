// 10z.5 R290 (T20): `orchestration.check` omits orphanedIdentityNotice for a pane caller-resumed into
// a session whose registered identity is bound to another pane; a fresh pane keeps the notice.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EVIDENCE_C = { terminalHandle: 'term_c', paneKey: PANE_C, launchToken: 'token-c' }
const WORKTREE_PATH = '/repo/gamma'

function makeAuthority(): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey: PANE_C,
    terminalHandle: 'term_c',
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_c',
    ptyId: 'pty-c',
    worktreeId: 'wt_gamma',
    worktreePath: WORKTREE_PATH,
    branch: 'gamma',
    tabId: 'tabC',
    leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: 'gamma work',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('orchestration.check: orphaned-identity notice for caller-resumed panes (R290)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const ctx: RpcContext = { orchestrationCompatibilityEvidence: EVIDENCE_C } as RpcContext

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  // Every pane named here reads dead unless included — a candidate is "gone" by omission.
  function setup(livePaneKeys: readonly string[] = []): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_c' ? PANE_C : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) => ({
      terminalHandle: livePaneKeys.includes(paneKey) ? 'live' : null,
      lastAgentStatus: null,
      observedLive: livePaneKeys.includes(paneKey)
    }))
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === EVIDENCE_C.terminalHandle &&
        evidence.paneKey === EVIDENCE_C.paneKey &&
        evidence.launchToken
      ) {
        return makeAuthority()
      }
      return null
    })
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime

    // The caller's OWN pane carries only a derived row (restart-minted placeholder).
    db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: PANE_C,
      terminalHandle: 'term_c',
      processIncarnation: 'proc-1',
      worktreeId: 'wt_gamma',
      worktreePath: WORKTREE_PATH,
      branch: 'gamma',
      title: null,
      agentLabel: null
    })
  }

  function registerCandidate(paneKey: string, displayName: string): string {
    const created = db.upsertAgentByPaneSuffix({
      displayName,
      role: null,
      hostId: 'local',
      paneKey,
      terminalHandle: `term_${displayName}`,
      processIncarnation: 'proc-x',
      worktreeId: 'wt_gamma',
      worktreePath: WORKTREE_PATH,
      branch: 'gamma',
      title: null,
      agentLabel: null,
      originHandle: `term_${displayName}`,
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    return created.agent.id
  }

  afterEach(() => {
    db?.close()
  })

  const X = '88888888-8888-4888-8888-888888888888'

  function seedHeldIdentity(): string {
    const candidateId = registerCandidate('tabX:leaf-old', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'first',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })
    const launched = db.recordLaunch({
      hostId: 'local',
      paneKey: 'tabX:leaf-old',
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch failed')
    }
    db.setLaunchAgentId({ seq: launched.row.seq }, candidateId)
    return candidateId
  }

  it('a fresh derived pane keeps the notice', async () => {
    setup()
    seedHeldIdentity()
    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      orphanedIdentityNotice?: string
    }
    expect(result.orphanedIdentityNotice).toContain('"chair"')
  })

  it('omits the notice for a pane caller-resumed into a held identity', async () => {
    setup()
    const candidateId = seedHeldIdentity()
    db.writeAgentAudit({
      agentId: candidateId,
      actorPaneKey: PANE_C,
      actorHostId: 'local',
      verb: 'launch_unrecorded',
      outcome: 'admitted',
      reasonCode: 'resume_target_owned_by_pane_without_live_pty'
    })
    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      orphanedIdentityNotice?: string
    }
    expect(result.orphanedIdentityNotice).toBeUndefined()
  })
})
