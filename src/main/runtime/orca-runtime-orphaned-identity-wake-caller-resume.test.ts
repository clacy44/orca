// 10z.5 R290 (T19): the idle-edge register nudge is suppressed for a pane that was caller-resumed
// into a session whose registered identity is bound to another pane; a fresh pane is still nudged.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo1::/repo/gamma'
const X = '77777777-7777-4777-8777-777777777777'
const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_RESUMED = 'tabR:rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr'
const PANE_FRESH = 'tabF:ffffffff-ffff-4fff-8fff-ffffffffffff'

type RuntimeInternals = {
  notifyOrphanedIdentityForPane: (
    paneKey: string,
    handle: string | undefined,
    worktreeId: string | undefined,
    target: unknown
  ) => void
  deliverPendingMessagesForHandle: (handle: string) => void
}

describe('notifyOrphanedIdentityForPane: caller-resumed panes (R290)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): { candidateId: string } {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
    })
    vi.spyOn(
      runtime as unknown as RuntimeInternals,
      'deliverPendingMessagesForHandle'
    ).mockImplementation(() => {})
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair',
      role: null,
      hostId: 'local',
      paneKey: PANE_A,
      terminalHandle: 'term_chair',
      processIncarnation: 'proc-x',
      worktreeId: WORKTREE_ID,
      worktreePath: '/repo/gamma',
      branch: 'gamma',
      title: null,
      agentLabel: null,
      originHandle: 'term_chair',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${created.agent.id}`,
      subject: 'waiting',
      type: 'status',
      priority: 'normal'
    })
    // The identity is attributed to X through its own launch row, and its pane holds X.
    const launched = db.recordLaunch({
      hostId: 'local',
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch failed')
    }
    db.setLaunchAgentId({ seq: launched.row.seq }, created.agent.id)
    return { candidateId: created.agent.id }
  }

  function notify(paneKey: string, handle: string): void {
    ;(runtime as unknown as RuntimeInternals).notifyOrphanedIdentityForPane(
      paneKey,
      handle,
      WORKTREE_ID,
      { tabId: 'tabX', leafId: 'leaf' }
    )
  }

  const rateRows = (paneKey: string): number =>
    (
      db as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }
    ).db
      .prepare('SELECT * FROM agent_rate WHERE subject_key = ?')
      .all(paneKey).length

  afterEach(() => {
    db?.close()
  })

  it('inserts no message and bumps no rate for a pane caller-resumed into a held identity', () => {
    setup()
    db.writeAgentAudit({
      agentId: db.getAgentByPaneKey('local', PANE_A)?.id ?? null,
      actorPaneKey: PANE_RESUMED,
      actorHostId: 'local',
      verb: 'launch_unrecorded',
      outcome: 'admitted',
      reasonCode: 'resume_target_owned_by_pane_without_live_agent'
    })
    notify(PANE_RESUMED, 'term_resumed')
    expect(db.getAllMessagesForHandle('term_resumed').length).toBe(0)
    expect(rateRows(PANE_RESUMED)).toBe(0)
  })

  it('a fresh pane on the same worktree is still nudged', () => {
    setup()
    notify(PANE_FRESH, 'term_fresh')
    const rows = db.getAllMessagesForHandle('term_fresh')
    expect(rows.length).toBe(1)
    expect(rows[0].body).toContain('"chair"')
    expect(rateRows(PANE_FRESH)).toBe(1)
  })
})
