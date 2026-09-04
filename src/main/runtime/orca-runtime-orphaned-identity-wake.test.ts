// C2/F-19 (Ruling 33(a)): resolveAgentMailboxForPaneKey returning null used to leave a
// restarted, unregistered pane pull-only forever, even when exactly one registered row on the
// SAME worktree had gone dark with unread mail waiting for it. This proves
// notifyOrphanedIdentityForPane's gating: fires once per pane per 24h window, suppressed at
// 0/>=2 candidates, suppressed once the row is reclaimed (agentMailbox resolves again), and
// inserts nothing when the sole candidate has no unread mail.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo1::/repo/gamma'

type RuntimeInternals = {
  notifyOrphanedIdentityForPane: (
    paneKey: string,
    handle: string | undefined,
    worktreeId: string | undefined,
    target: unknown
  ) => void
  deliverPendingMessages: (target: unknown, options?: { mailboxHandle?: string }) => void
  getAgentDirectoryLivenessSignals: (paneKey: string) => {
    terminalHandle: string | null
    lastAgentStatus: unknown
    observedLive: boolean
  }
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

describe('notifyOrphanedIdentityForPane (Ruling 33(a) C2/F-19)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    // Every pane reads dead by default — a candidate must be explicitly whitelisted live.
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
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
      worktreeId: WORKTREE_ID,
      worktreePath: '/repo/gamma',
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

  it('fires once per pane per window: inserts a host-authored row addressed to the bare handle and delivers it, but not twice', () => {
    setup()
    const candidateId = registerCandidate('tabX:leaf-old', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })
    const deliver = vi
      .spyOn(internals(runtime), 'deliverPendingMessages')
      .mockImplementation(() => {})

    internals(runtime).notifyOrphanedIdentityForPane('tabP:leaf-new', 'term_p', WORKTREE_ID, {
      tabId: 'tabP',
      leafId: 'leaf-new'
    })
    const rows = db.getAllMessagesForHandle('term_p')
    expect(rows.length).toBe(1)
    expect(rows[0].from_handle).toBe('runtime')
    expect(rows[0].body).toContain('"chair"')
    expect(deliver).toHaveBeenCalledTimes(1)

    // Second call within the window: no second row, no second delivery.
    internals(runtime).notifyOrphanedIdentityForPane('tabP:leaf-new', 'term_p', WORKTREE_ID, {
      tabId: 'tabP',
      leafId: 'leaf-new'
    })
    expect(db.getAllMessagesForHandle('term_p').length).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('suppressed at zero candidates on this worktree', () => {
    setup()
    internals(runtime).notifyOrphanedIdentityForPane('tabP:leaf-new', 'term_p', WORKTREE_ID, {
      tabId: 'tabP',
      leafId: 'leaf-new'
    })
    expect(db.getAllMessagesForHandle('term_p').length).toBe(0)
  })

  it('suppressed at two candidates on this worktree (ambiguous)', () => {
    setup()
    const idOne = registerCandidate('tabX:leaf-old1', 'chair-one')
    const idTwo = registerCandidate('tabY:leaf-old2', 'chair-two')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${idOne}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${idTwo}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })
    internals(runtime).notifyOrphanedIdentityForPane('tabP:leaf-new', 'term_p', WORKTREE_ID, {
      tabId: 'tabP',
      leafId: 'leaf-new'
    })
    expect(db.getAllMessagesForHandle('term_p').length).toBe(0)
  })

  it('suppressed once the sole candidate is reclaimed (no longer dead-pane)', () => {
    setup()
    const candidateId = registerCandidate('tabX:leaf-old', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })
    // The candidate's pane now reads live.
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) => ({
      terminalHandle: paneKey === 'tabX:leaf-old' ? 'live' : null,
      lastAgentStatus: null,
      observedLive: paneKey === 'tabX:leaf-old'
    }))
    internals(runtime).notifyOrphanedIdentityForPane('tabP:leaf-new', 'term_p', WORKTREE_ID, {
      tabId: 'tabP',
      leafId: 'leaf-new'
    })
    expect(db.getAllMessagesForHandle('term_p').length).toBe(0)
  })

  it('no row inserted when the sole candidate has no unread mail', () => {
    setup()
    registerCandidate('tabX:leaf-old', 'chair')
    internals(runtime).notifyOrphanedIdentityForPane('tabP:leaf-new', 'term_p', WORKTREE_ID, {
      tabId: 'tabP',
      leafId: 'leaf-new'
    })
    expect(db.getAllMessagesForHandle('term_p').length).toBe(0)
  })
})
