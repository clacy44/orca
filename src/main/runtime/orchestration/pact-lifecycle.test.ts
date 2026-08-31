// S10-3 pact spec — pause/resume/release/auto-pause through the public OrchestrationDb API.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('pact pause/resume/release', () => {
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

  it('K11: either participant can release, in any state including paused; a third party is refused', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const c = seedAgent(d, 'c')
    const threadId = engagedPact(d, a, b)
    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    expect(() => d.releasePact({ ...actor(c), threadId, reasonCode: 'x' })).toThrow(
      /not a participant/
    )
    const released = d.releasePact({ ...actor(b), threadId, reasonCode: 'done' })
    expect(released.pact_state).toBe('released')
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.at(-1)?.kind).toBe('release')
  })

  it('K16: step during pause is refused pact_paused; ledger/ordinal unchanged', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    expect(() =>
      d.appendPactStep({ ...actor(a), threadId, done: 'x', runId: 'run_peer_local' })
    ).toThrow(/paused/)
    expect(d.getThread(threadId)?.pact_ordinal).toBe(0)
  })

  it('K16: resume by the pausing side clears the pause and leaves the turn exactly where it was', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const turnBefore = d.getThread(threadId)?.pact_turn_agent_id
    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    const outcome = d.resumePactOrRequest({ ...actor(a), threadId })
    expect(outcome.kind).toBe('resumed')
    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).toBeNull()
    expect(thread?.pact_turn_agent_id).toBe(turnBefore)
  })

  it('K16: resume by the counterpart without acceptance writes only resume_request and leaves the pact paused', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    const outcome = d.resumePactOrRequest({ ...actor(b), threadId })
    expect(outcome.kind).toBe('requested')
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.at(-1)?.kind).toBe('resume_request')
    // The pausing side's own later resume still succeeds.
    const resumed = d.resumePactOrRequest({ ...actor(a), threadId })
    expect(resumed.kind).toBe('resumed')
    expect(d.getThread(threadId)?.pact_paused_at).toBeNull()
  })

  it('K17: the v35 pact_pause_reason CHECK admits all six codes', () => {
    const d = freshDb()
    const codes = [
      'counterpart_gone',
      'counterpart_left',
      'counterpart_quarantined',
      'thread_paused',
      'thread_closed',
      'operator'
    ]
    for (const code of codes) {
      const a = seedAgent(d, `a_${code}`)
      const b = seedAgent(d, `b_${code}`)
      const threadId = engagedPact(d, a, b)
      const paused = d.pausePact({ ...actor(a), threadId, reasonCode: code })
      expect(paused.pact_pause_reason).toBe(code)
    }
  })

  it('K17: a counterpart leaving auto-pauses with counterpart_left', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const outcomes = d.autoPausePactsForAgent(b, 'counterpart_left')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].threadId).toBe(threadId)
    const thread = d.getThread(threadId)
    expect(thread?.pact_pause_reason).toBe('counterpart_left')
    expect(thread?.pact_paused_at).not.toBeNull()
  })

  it('major fix: a quarantined participant cannot lift its own counterpart_quarantined auto-pause', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.setAgentQuarantine({ id: b, quarantined: true, reasonCode: 'test' })
    d.autoPausePactsForAgent(b, 'counterpart_quarantined')
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // B (still quarantined) tries to lift its own containment auto-pause unilaterally.
    expect(() => d.resumePactOrRequest({ ...actor(b), threadId })).toThrow(
      /condition has not cleared/
    )
    // A (the counterpart) cannot lift it either, while B is still quarantined.
    expect(() => d.resumePactOrRequest({ ...actor(a), threadId })).toThrow(
      /condition has not cleared/
    )
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // Once the quarantine is actually lifted, either side may resume.
    d.setAgentQuarantine({ id: b, quarantined: false, reasonCode: null })
    const outcome = d.resumePactOrRequest({ ...actor(a), threadId })
    expect(outcome.kind).toBe('resumed')
    expect(d.getThread(threadId)?.pact_paused_at).toBeNull()
  })

  it('major fix: a quarantined participant may not step, even off-turn checks aside', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b) // a holds the turn
    d.setAgentQuarantine({ id: a, quarantined: true, reasonCode: 'test' })
    expect(() =>
      d.appendPactStep({ ...actor(a), threadId, done: 'x', runId: 'run_peer_local' })
    ).toThrow(/quarantined and a quarantined participant may not step/)
    expect(d.getThread(threadId)?.pact_ordinal).toBe(0)
  })

  it('major fix: resume for counterpart_left is refused until the leaver rejoins the thread', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.leaveThread(threadId, b)
    const outcome = d.autoPausePactOnThread(threadId, 'counterpart_left')
    expect(outcome).not.toBeNull()

    // A resuming unilaterally while B is still gone from the thread is refused — this is the
    // probe Q2 shape: A must not be able to resume, step, and hand the turn to an unreachable B.
    expect(() => d.resumePactOrRequest({ ...actor(a), threadId })).toThrow(
      /condition has not cleared/
    )

    // Once B rejoins (left_at cleared), the condition has cleared and either side may resume.
    d.upsertThreadParticipant({ threadId, participantKey: b, agentId: b })
    const resumed = d.resumePactOrRequest({ ...actor(a), threadId })
    expect(resumed.kind).toBe('resumed')
  })

  it('K17: a thread close auto-pauses with thread_closed, and resume is refused forever (release only)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const outcome = d.autoPausePactOnThread(threadId, 'thread_closed')
    expect(outcome?.threadId).toBe(threadId)
    expect(() => d.resumePactOrRequest({ ...actor(a), threadId })).toThrow(/no reopen verb/)
    const released = d.releasePact({ ...actor(a), threadId, reasonCode: 'thread_closed' })
    expect(released.pact_state).toBe('released')
  })

  it('auto-pause is idempotent: an already-paused pact is left alone (no double pause row)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    const outcomes = d.autoPausePactsForAgent(b, 'counterpart_left')
    expect(outcomes).toHaveLength(0)
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.filter((e) => e.kind === 'pause')).toHaveLength(1)
  })

  it('pact_steps.trg_pact_steps_no_delete / append_only: the ledger cannot be deleted or arbitrarily updated', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    expect(() => raw.prepare('DELETE FROM pact_steps WHERE thread_id = ?').run(threadId)).toThrow(
      /append-only/
    )
    expect(() =>
      raw.prepare("UPDATE pact_steps SET reason_code = 'x' WHERE thread_id = ?").run(threadId)
    ).toThrow(/append-only/)
  })
})
