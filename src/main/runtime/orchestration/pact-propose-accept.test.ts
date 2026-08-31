// S10-3 pact spec — propose/accept/decline through the public OrchestrationDb API.
// Mutation-guard comments match the pact-spec TESTS table ids (K#).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('pact propose/accept/decline', () => {
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

  function seedThreadWithParticipants(d: OrchestrationDb, ids: string[]): string {
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: ids[0] ?? null,
      participants: ids.map((id) => ({ participantKey: id, agentId: id }))
    })
    return thread.id
  }

  it('propose -> engaged pact, turn held by proposer (accept)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = seedThreadWithParticipants(d, [a, b])
    const proposed = d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: 6 })
    expect(proposed.pact_state).toBe('proposed')
    expect(proposed.pact_proposer_agent_id).toBe(a)
    expect(proposed.pact_with_agent_id).toBe(b)
    expect(proposed.pact_ordinal).toBe(0)

    const engaged = d.acceptPact({ ...actor(b), threadId })
    expect(engaged.pact_state).toBe('engaged')
    expect(engaged.pact_turn_agent_id).toBe(a) // proposer moves first
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.map((e) => e.kind)).toEqual(['propose', 'accept'])
  })

  it('decline releases the pact and clears the turn', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = seedThreadWithParticipants(d, [a, b])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    const declined = d.declinePact({ ...actor(b), threadId, reasonCode: 'not_now' })
    expect(declined.pact_state).toBe('released')
    expect(declined.pact_turn_agent_id).toBeNull()
  })

  it('K8: --with a quarantined agent refuses agent_quarantined; pact_state stays NULL', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    d.setAgentQuarantine({ id: b, quarantined: true, reasonCode: 'test' })
    const threadId = seedThreadWithParticipants(d, [a, b])
    expect(() =>
      d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    ).toThrow(/a pact needs two accountable participants and b is quarantined/)
    expect(d.getThread(threadId)?.pact_state).toBeNull()
  })

  it('K8: --with a non-participant on a sensitive thread refuses sensitive_thread_no_pact; pact_state stays NULL', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      sensitive: true,
      participants: [{ participantKey: a, agentId: a }]
    })
    expect(() =>
      d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: b, stepsTotal: null })
    ).toThrow(/is a sensitive thread and b is not a participant/)
    expect(d.getThread(thread.id)?.pact_state).toBeNull()
  })

  it('K13 (F1, cross-pact): a mirror propose between an already-engaged pair is refused pact_exists_with_peer, symmetrically', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const thr1 = seedThreadWithParticipants(d, [a, b])
    d.proposePact({ ...actor(a), threadId: thr1, peerAgentId: b, stepsTotal: null })
    d.acceptPact({ ...actor(b), threadId: thr1 })

    const thr2 = seedThreadWithParticipants(d, [a, b])
    expect(() =>
      d.proposePact({ ...actor(a), threadId: thr2, peerAgentId: b, stepsTotal: null })
    ).toThrow(/pact with b on thr_/)
    // the mirror direction (B proposing to A) is refused too — symmetric getEngagedPactWith
    expect(() =>
      d.proposePact({ ...actor(b), threadId: thr2, peerAgentId: a, stepsTotal: null })
    ).toThrow(/pact with a on thr_/)
    expect(d.getThread(thr2)?.pact_state).toBeNull()

    // A PROPOSED (not yet accepted) pact blocks the same way.
    const thr3 = seedThreadWithParticipants(d, [a, b])
    const c = seedAgent(d, 'c')
    const thrAC = seedThreadWithParticipants(d, [a, c])
    d.proposePact({ ...actor(a), threadId: thrAC, peerAgentId: c, stepsTotal: null })
    expect(() =>
      d.proposePact({ ...actor(a), threadId: thr3, peerAgentId: c, stepsTotal: null })
    ).toThrow(/pact_exists_with_peer|pact with c/)
  })

  it('K13 backstop: with the guard forced open, idx_pact_pair_live turns the mirror insert into a constraint failure', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const thr1 = seedThreadWithParticipants(d, [a, b])
    const thr2 = seedThreadWithParticipants(d, [a, b])
    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    raw
      .prepare(
        `UPDATE threads SET pact_proposer_agent_id=?, pact_with_agent_id=?, pact_state='proposed' WHERE id=?`
      )
      .run(a, b, thr1)
    expect(() =>
      raw
        .prepare(
          `UPDATE threads SET pact_proposer_agent_id=?, pact_with_agent_id=?, pact_state='proposed' WHERE id=?`
        )
        .run(a, b, thr2)
    ).toThrow(/UNIQUE constraint|idx_pact_pair_live/)
  })

  it('K15: a third thread member cannot seize an engaged pact (pact_exists); parties/turn/ordinal unchanged', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const c = seedAgent(d, 'c')
    const threadId = seedThreadWithParticipants(d, [a, b, c])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    d.acceptPact({ ...actor(b), threadId })
    expect(() =>
      d.proposePact({ ...actor(c), threadId, peerAgentId: a, stepsTotal: null })
    ).toThrow(/already has a pact/)
    const thread = d.getThread(threadId)
    expect(thread?.pact_proposer_agent_id).toBe(a)
    expect(thread?.pact_with_agent_id).toBe(b)
    expect(thread?.pact_turn_agent_id).toBe(a)
    expect(thread?.pact_ordinal).toBe(0)
  })

  it('K15: a re-propose after release resets pact_ordinal to 0', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = seedThreadWithParticipants(d, [a, b])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    d.acceptPact({ ...actor(b), threadId })
    d.appendPactStep({ ...actor(a), threadId, done: 'first step', runId: 'run_peer_local' })
    expect(d.getThread(threadId)?.pact_ordinal).toBe(1)
    d.releasePact({ ...actor(a), threadId, reasonCode: 'done' })
    const reproposed = d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: 3 })
    expect(reproposed.pact_ordinal).toBe(0)
  })

  it("blocker fix: re-propose after release is steppable again — era-2 ordinal 1 no longer collides with era-1's", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = seedThreadWithParticipants(d, [a, b])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    d.acceptPact({ ...actor(b), threadId })
    d.appendPactStep({ ...actor(a), threadId, done: 'era 1 step', runId: 'run_peer_local' })
    d.releasePact({ ...actor(a), threadId, reasonCode: 'done' })

    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: 3 })
    d.acceptPact({ ...actor(b), threadId })
    // Previously threw: "UNIQUE constraint failed: pact_steps.thread_id, pact_steps.ordinal" —
    // era-2's ordinal 1 collided with era-1's still-present (append-only) ordinal-1 step row.
    const stepped = d.appendPactStep({
      ...actor(a),
      threadId,
      done: 'era 2 step',
      runId: 'run_peer_local'
    })
    expect(stepped.outcome).toBe('stepped')
    if (stepped.outcome !== 'stepped') {
      throw new Error('unreachable')
    }
    expect(stepped.ordinal).toBe(1)
    expect(d.getThread(threadId)?.pact_turn_agent_id).toBe(b)

    // Both eras' step rows survive in the append-only ledger (ruling 2) — no ordinal was elided,
    // and neither collided with the other.
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    const stepSummaries = ledger.entries.filter((e) => e.kind === 'step').map((e) => e.summary)
    expect(stepSummaries).toEqual(['era 1 step', 'era 2 step'])
  })

  it('major fix: propose refuses a pact with yourself (pact_self), before any write', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const threadId = seedThreadWithParticipants(d, [a])
    expect(() =>
      d.proposePact({ ...actor(a), threadId, peerAgentId: a, stepsTotal: null })
    ).toThrow(/cannot propose a pact with yourself/)
    expect(d.getThread(threadId)?.pact_state).toBeNull()
  })

  it('pact_not_federated: a peer address naming a different host is refused before any write', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const threadId = seedThreadWithParticipants(d, [a])
    expect(() =>
      d.proposePact({ ...actor(a), threadId, peerAgentId: 'b@otherhost', stepsTotal: null })
    ).toThrow(/host-local/)
    expect(d.getThread(threadId)?.pact_state).toBeNull()
  })

  it('verify major: a QUARANTINED CALLER may not propose - refused agent_quarantined, pact_state stays NULL', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    d.setAgentQuarantine({ id: a, quarantined: true, reasonCode: 'test' })
    const threadId = seedThreadWithParticipants(d, [a, b])
    expect(() =>
      d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    ).toThrow(/quarantined participant may not propose/)
    expect(d.getThread(threadId)?.pact_state).toBeNull()
  })

  it('verify major: a QUARANTINED CALLER may not accept - the proposal stays proposed', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = seedThreadWithParticipants(d, [a, b])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    d.setAgentQuarantine({ id: b, quarantined: true, reasonCode: 'test' })
    expect(() => d.acceptPact({ ...actor(b), threadId })).toThrow(
      /quarantined participant may not accept/
    )
    expect(d.getThread(threadId)?.pact_state).toBe('proposed')
  })

  // Verify blocker regression: a DB stamped v35 by the PRE-FIX copy of the unshipped migration
  // has no pact_era anywhere; migrate()'s early return must not strand it (mutation guard:
  // removing the storedVersion>=35 repair in db.ts turns this red on the reopen assertions).
  it('verify blocker: a v35 DB without pact_era is repaired on open', () => {
    freshDb() // registers a throwaway :memory: db for the shared afterEach close
    const dir = mkdtempSync(join(tmpdir(), 'orca-pact-era-repair-'))
    const file = join(dir, 'orchestration.db')
    try {
      type Raw = { exec(sql: string): void; prepare(s: string): { get(...a: unknown[]): unknown } }
      const first = new OrchestrationDb(file)
      const raw = (first as unknown as { db: Raw }).db
      raw.exec(`DROP INDEX IF EXISTS idx_pact_step_ordinal`)
      raw.exec(`ALTER TABLE pact_steps DROP COLUMN pact_era`)
      raw.exec(`ALTER TABLE threads DROP COLUMN pact_era`)
      first.close()

      const reopened = new OrchestrationDb(file)
      const raw2 = (reopened as unknown as { db: Raw }).db
      const col = (table: string) =>
        (
          raw2
            .prepare(
              `SELECT COUNT(*) AS c FROM pragma_table_info('${table}') WHERE name = 'pact_era'`
            )
            .get() as { c: number }
        ).c
      expect(col('threads')).toBe(1)
      expect(col('pact_steps')).toBe(1)
      const idx = raw2
        .prepare(`SELECT group_concat(name) AS g FROM pragma_index_info('idx_pact_step_ordinal')`)
        .get() as { g: string | null }
      expect(idx.g ?? '').toContain('pact_era')
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
