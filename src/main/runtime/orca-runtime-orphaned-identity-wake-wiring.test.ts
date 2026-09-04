// F-5 (attacker-lens review, Ruling 33(a) H6a): orca-runtime-orphaned-identity-wake.test.ts
// proves notifyOrphanedIdentityForPane's own gating in isolation, but nothing previously drove
// its two real callers — deliverPendingMessagesForLeaf's else-branch (~:35174) and
// deliverPendingMessagesForPty's mirror (~:35205) — with a real leaf/pty record whose
// worktreeId derives (splitWorktreeIdForFilesystem) to the registered candidate's
// worktree_path. This proves the WIRING: the notice lands once, addressed to the requesting
// pane's own bare handle, and never to an unrelated pane.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'

// A worktreeId shape other than 'repo1::/repo/gamma': a folder-workspace instance suffix that
// splitWorktreeIdForFilesystem must strip before the worktree_path comparison resolves.
const WORKTREE_ID = 'repo2::/repo/delta::workspace:11111111-1111-4111-8111-111111111111'
const WORKTREE_PATH = '/repo/delta'

type RuntimeInternals = {
  deliverPendingMessagesForLeaf: (leaf: {
    tabId: string
    leafId: string
    worktreeId: string | null
  }) => void
  deliverPendingMessagesForPty: (pty: {
    ptyId: string
    paneKey: string | null
    worktreeId: string | null
  }) => void
  deliverPendingMessages: (target: unknown, options?: { mailboxHandle?: string }) => void
  getAgentDirectoryLivenessSignals: (paneKey: string) => {
    terminalHandle: string | null
    lastAgentStatus: unknown
    observedLive: boolean
  }
  handleByLeafKey: Map<string, string>
  handleByPtyId: Map<string, string>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

describe('deliverPendingMessagesForLeaf/ForPty wiring to notifyOrphanedIdentityForPane (F-5, Ruling 33(a) H6a)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
    })
    vi.spyOn(internals(runtime), 'deliverPendingMessages').mockImplementation(() => {})
  }

  function registerDeadCandidate(paneKey: string, displayName: string): string {
    const created = db.upsertAgentByPaneSuffix({
      displayName,
      role: null,
      hostId: 'local',
      paneKey,
      terminalHandle: `term_${displayName}`,
      processIncarnation: 'proc-x',
      worktreeId: WORKTREE_ID,
      worktreePath: WORKTREE_PATH,
      branch: 'delta',
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

  it('deliverPendingMessagesForLeaf wakes only the requesting pane bare handle, not another pane', () => {
    setup()
    const candidateId = registerDeadCandidate('tabX:leaf-old', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })

    internals(runtime).handleByLeafKey.set('tabP::leaf-new', 'term_p')
    internals(runtime).deliverPendingMessagesForLeaf({
      tabId: 'tabP',
      leafId: 'leaf-new',
      worktreeId: WORKTREE_ID
    })

    expect(db.getAllMessagesForHandle('term_p').length).toBe(1)
    expect(db.getAllMessagesForHandle('term_p')[0].body).toContain('"chair"')
    // A different, unrelated pane's bare handle never receives this pane's notice.
    expect(db.getAllMessagesForHandle('term_someone_else').length).toBe(0)
  })

  it('deliverPendingMessagesForPty (the pty-only mirror) wakes only its own pane bare handle', () => {
    setup()
    const candidateId = registerDeadCandidate('tabX:leaf-old2', 'chair')
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${candidateId}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })

    internals(runtime).handleByPtyId.set('pty-q', 'term_q')
    internals(runtime).deliverPendingMessagesForPty({
      ptyId: 'pty-q',
      paneKey: 'tabQ:leaf-q',
      worktreeId: WORKTREE_ID
    })

    expect(db.getAllMessagesForHandle('term_q').length).toBe(1)
    expect(db.getAllMessagesForHandle('term_q')[0].body).toContain('"chair"')
    expect(db.getAllMessagesForHandle('term_someone_else').length).toBe(0)
  })
})
