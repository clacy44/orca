// S10-21a C10 (design v3.2 §2.11 N4 fix, drill criterion 8; Ruling 34 Addendum 25): fence tests
// for the host-authored pact un-pause primitive. The end-to-end drill-criterion-8 test (through
// the sweep, a real Layer-2 rebind) lives in restore-registered-agent-panes.test.ts; these test
// `resumePactsForRestoredAgent` directly against the filter predicate and the failure path.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type Database from '../../sqlite/sync-database'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('C10: resumePactsForRestoredAgent', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedAgent(
    d: OrchestrationDb,
    id: string,
    overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
  ): string {
    const result = d.upsertAgentByPaneSuffix({
      displayName: id,
      role: null,
      hostId: 'local',
      paneKey: `tab:${id}`,
      terminalHandle: `term_${id}`,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: `term_${id}`,
      originHostId: 'local',
      ...overrides
    })
    if (result.outcome === 'name_taken') {
      throw new Error(`seedAgent: name taken for ${id}`)
    }
    return result.agent.id
  }

  function actor(agentId: string): {
    callerAgentId: string
    callerPaneKey: string | null
    callerHostId: string
  } {
    return { callerAgentId: agentId, callerPaneKey: `tab:${agentId}`, callerHostId: 'local' }
  }

  function engagedPact(d: OrchestrationDb, a: string, b: string): string {
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: b, agentId: b }
      ]
    })
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: b, stepsTotal: null })
    d.acceptPact({ ...actor(b), threadId: thread.id })
    return thread.id
  }

  it('drill criterion 8: a pact paused counterpart_gone resumes once the gone agent is restored', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.autoPausePactsForAgent(a, 'counterpart_gone')
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    d.resumePactsForRestoredAgent(a, [threadId])

    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).toBeNull()
    expect(thread?.pact_pause_reason).toBeNull()
    expect(thread?.pact_state).toBe('engaged')
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.at(-1)?.kind).toBe('resume')
    expect(ledger.entries.at(-1)?.actorAgentId).toBeNull()
  })

  it('fence: a pact paused for another reason stays paused', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.autoPausePactsForAgent(a, 'counterpart_quarantined')

    d.resumePactsForRestoredAgent(a, [threadId])

    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).not.toBeNull()
    expect(thread?.pact_pause_reason).toBe('counterpart_quarantined')
  })

  it('fence: a pact whose counterpart is a different agent stays paused', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const c = seedAgent(d, 'c')
    const threadId = engagedPact(d, a, b)
    d.autoPausePactsForAgent(a, 'counterpart_gone')

    // c is not a participant of this pact at all.
    d.resumePactsForRestoredAgent(c, [threadId])

    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).not.toBeNull()
    expect(thread?.pact_pause_reason).toBe('counterpart_gone')
  })

  it('fence: a resume failure is audited and never thrown', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.autoPausePactsForAgent(a, 'counterpart_gone')

    const raw = (d as unknown as { db: Database.Database }).db
    const originalPrepare = raw.prepare.bind(raw)
    const failingUpdate = `UPDATE threads SET pact_paused_at = NULL, pact_pause_reason = NULL WHERE id = ?`
    raw.prepare = ((sql: string) => {
      if (sql === failingUpdate) {
        throw new Error('simulated resume write failure')
      }
      return originalPrepare(sql)
    }) as typeof raw.prepare

    expect(() => d.resumePactsForRestoredAgent(a, [threadId])).not.toThrow()
    raw.prepare = originalPrepare

    // The pact is unaffected — still paused, exactly as before the failed attempt (a pact that
    // cannot resume does not undo a rebind, §2.11).
    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).not.toBeNull()
    expect(thread?.pact_pause_reason).toBe('counterpart_gone')
    const failureAudit = raw
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'pact_resumed_after_rebind' AND outcome = 'failed'`
      )
      .all()
    expect(failureAudit).toHaveLength(1)
  })

  it('a non-existent thread id is silently skipped, no throw', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    expect(() => d.resumePactsForRestoredAgent(a, ['thr_does_not_exist'])).not.toThrow()
  })
})
