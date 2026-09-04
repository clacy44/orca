// C1/F-19 (Ruling 33(a)): orchestration.check told a restarted, unregistered pane nothing about
// the identity waiting for it on the same worktree — a derived (or absent) caller row read as a
// stranger, pull-only, even when exactly one registered row on this worktree had gone dark with
// mail waiting. This proves the orphanedIdentityNotice fires only for that exact 0/1/>=2 shape.
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

describe('orchestration.check: orphaned-identity notice (Ruling 33(a) C1/F-19)', () => {
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

  it('T8: exactly one dead-pane row on this worktree with 2 unread -> notice names it with N=2', async () => {
    setup()
    const candidateId = registerCandidate('tabX:leaf-old', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'first',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'second',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })

    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      orphanedIdentityNotice?: string
    }
    expect(result.orphanedIdentityNotice).toBeDefined()
    expect(result.orphanedIdentityNotice).toContain('"chair"')
    expect(result.orphanedIdentityNotice).toContain('2 unread')
    expect(result.orphanedIdentityNotice).toContain('pane gone')
    expect(result.orphanedIdentityNotice).toContain('orca agents register --name chair')
  })

  it('T9a: zero candidates on this worktree -> no notice', async () => {
    setup()
    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      orphanedIdentityNotice?: string
    }
    expect(result.orphanedIdentityNotice).toBeUndefined()
  })

  it('T9b: two dead-pane candidates on this worktree -> no notice (ambiguous)', async () => {
    setup()
    const idOne = registerCandidate('tabX:leaf-old1', 'chair-one')
    const idTwo = registerCandidate('tabY:leaf-old2', 'chair-two')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${idOne}`,
      subject: 'first',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${idTwo}`,
      subject: 'second',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })

    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      orphanedIdentityNotice?: string
    }
    expect(result.orphanedIdentityNotice).toBeUndefined()
  })

  it('T9c: the sole candidate on this worktree has a LIVE pane -> no notice', async () => {
    setup(['tabX:leaf-old'])
    const candidateId = registerCandidate('tabX:leaf-old', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'first',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })

    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      orphanedIdentityNotice?: string
    }
    expect(result.orphanedIdentityNotice).toBeUndefined()
  })
})
