// S10-3 pact spec — getTurnsHeldBy / getPactLedger / getEngagedPactWith read paths.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('pact queries', () => {
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

  function threadWith(d: OrchestrationDb, ids: string[]): string {
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: ids[0] ?? null,
      participants: ids.map((id) => ({ participantKey: id, agentId: id }))
    })
    return thread.id
  }

  function engagedPact(d: OrchestrationDb, a: string, b: string, threadId: string): void {
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    d.acceptPact({ ...actor(b), threadId })
  }

  it('K5: getTurnsHeldBy names the engaged pact whose turn the agent holds', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    engagedPact(d, a, b, threadId)
    expect(d.getTurnsHeldBy(a)).toEqual([threadId])
    expect(d.getTurnsHeldBy(b)).toEqual([])
  })

  it('K5/K24: a turn held only in a PAUSED pact is excluded from getTurnsHeldBy', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    engagedPact(d, a, b, threadId)
    d.pausePact({ ...actor(a), threadId, reasonCode: 'operator' })
    expect(d.getTurnsHeldBy(a)).toEqual([])
  })

  // T26 (S10-21b B6, design §2.1/§2.9): a thread with pact_turn_in_flight_at IS NOT NULL is
  // excluded from getTurnsHeldBy — the emitting host still shows the turn as its own during the
  // in-flight interval, so it must not ALSO be double-counted as a park-able turn. Fails at base
  // 73984e659d (no pact_turn_in_flight_at clause in the query).
  it('T26: getTurnsHeldBy excludes an in-flight thread', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    engagedPact(d, a, b, threadId)
    expect(d.getTurnsHeldBy(a)).toEqual([threadId])
    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    raw
      .prepare(`UPDATE threads SET pact_turn_in_flight_at = datetime('now') WHERE id = ?`)
      .run(threadId)
    expect(d.getTurnsHeldBy(a)).toEqual([])
  })

  it('K9: a thread participant outside the pact sees ordinals/actors/times/hashes and zero summaries', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const c = seedAgent(d, 'c')
    const threadId = threadWith(d, [a, b, c])
    engagedPact(d, a, b, threadId)
    d.appendPactStep({ ...actor(a), threadId, done: 'secret plan', runId: 'run_peer_local' })

    const outsider = d.getPactLedger({ threadId, revealSummaries: false })
    const step = outsider.entries.find((e) => e.kind === 'step')
    expect(step?.summary).toBeNull()
    expect(step?.ordinal).toBe(1)
    expect(step?.actorAgentId).toBe(a)
    expect(step?.at).toBeTruthy()
    expect(step?.summaryShaPrefix).toHaveLength(12)

    const participant = d.getPactLedger({ threadId, revealSummaries: true })
    expect(participant.entries.find((e) => e.kind === 'step')?.summary).toBe('secret plan')
  })

  it('K9: a non-participant of the thread is refused not_a_participant at the RPC boundary (isThreadParticipant false)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const outsider = seedAgent(d, 'outsider')
    const threadId = threadWith(d, [a, b])
    expect(d.isThreadParticipant(threadId, outsider)).toBe(false)
  })

  it('getEngagedPactWith is symmetric across proposed and engaged states', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    expect(d.getEngagedPactWith(a, b)?.id).toBe(threadId)
    expect(d.getEngagedPactWith(b, a)?.id).toBe(threadId)
    d.acceptPact({ ...actor(b), threadId })
    expect(d.getEngagedPactWith(a, b)?.id).toBe(threadId)
    expect(d.getEngagedPactWith(b, a)?.id).toBe(threadId)
  })

  it('trg_pact_turn_membership: an engaged pact cannot be updated to a turn outside the pair', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const c = seedAgent(d, 'c')
    const threadId = threadWith(d, [a, b, c])
    engagedPact(d, a, b, threadId)
    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    expect(() =>
      raw.prepare('UPDATE threads SET pact_turn_agent_id = ? WHERE id = ?').run(c, threadId)
    ).toThrow(/turn held by a participant/)
    expect(() =>
      raw.prepare('UPDATE threads SET pact_turn_agent_id = NULL WHERE id = ?').run(threadId)
    ).toThrow(/turn held by a participant/)
  })

  // T31 (design §4.7, "containment follows supersession") — rendering half only: B14's
  // quarantine-chain-walk RPC/CLI caller is not yet landed at this base (151845af72), so this
  // test flags the remote row's chain directly (as B14's writer eventually will) rather than
  // going through a not-yet-existing `orca agents quarantine` caller, per this brief's own
  // OPEN-item guidance ("test the WITHHOLD rendering in isolation against a directly-flagged
  // quarantined row and re-run as integration once commit 14 lands"). Fails at base: the pre-B11
  // `getPactLedger` LEFT JOINs `ps.actor_agent_id` against `agents.id`, which a rendered
  // `remote:<link>:<id>` key never matches, so `actorDisplayName` stays null and `withheld`
  // stays false regardless of `remote_agents.local_quarantined`.
  it('T31: a step authored under a pre-rebind remote party id is withheld once the POST-rebind id is quarantined', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    engagedPact(d, a, b, threadId)

    const raw = (
      d as unknown as {
        db: {
          prepare: (s: string) => { run: (...args: unknown[]) => unknown }
        }
      }
    ).db

    const linkId = 'env-1'
    const oldRemoteId = 'remote-old'
    const newRemoteId = 'remote-new'
    raw
      .prepare(
        `INSERT INTO remote_agents
           (environment_id, environment_name, link_kind, remote_agent_id, display_name, state,
            superseded_at, succeeded_by_remote_agent_id)
         VALUES (?, 'env', 'environment', ?, 'Old Peer', 'gone', datetime('now'), ?)`
      )
      .run(linkId, oldRemoteId, newRemoteId)
    raw
      .prepare(
        `INSERT INTO remote_agents
           (environment_id, environment_name, link_kind, remote_agent_id, display_name, state,
            local_quarantined)
         VALUES (?, 'env', 'environment', ?, 'New Peer', 'live', 1)`
      )
      .run(linkId, newRemoteId)

    const renderedOldKey = `remote:${linkId}:${oldRemoteId}`
    raw
      .prepare(
        `INSERT INTO pact_steps
           (thread_id, ordinal, kind, actor_agent_id, message_id, summary, summary_sha256,
            turn_after_agent_id)
         VALUES (?, 1, 'step', ?, 'msg-1', 'pre-rebind summary', 'deadbeef', ?)`
      )
      .run(threadId, renderedOldKey, b)

    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    const step = ledger.entries.find((e) => e.actorAgentId === renderedOldKey)
    expect(step).toBeDefined()
    expect(step?.actorDisplayName).toBe('Old Peer')
    expect(step?.withheld).toBe(true)
    expect(step?.summary).toBeNull()
    expect(ledger.omitted.withheld).toBeGreaterThanOrEqual(1)
  })

  it('T31 control: an UNQUARANTINED remote actor (no chain member flagged) resolves a display name but is not withheld', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    engagedPact(d, a, b, threadId)

    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    const linkId = 'env-2'
    const remoteId = 'remote-clean'
    raw
      .prepare(
        `INSERT INTO remote_agents (environment_id, environment_name, link_kind, remote_agent_id, display_name, state)
         VALUES (?, 'env', 'environment', ?, 'Clean Peer', 'live')`
      )
      .run(linkId, remoteId)
    const renderedKey = `remote:${linkId}:${remoteId}`
    raw
      .prepare(
        `INSERT INTO pact_steps
           (thread_id, ordinal, kind, actor_agent_id, message_id, summary, summary_sha256, turn_after_agent_id)
         VALUES (?, 1, 'step', ?, 'msg-2', 'ordinary summary', 'cafebabe', ?)`
      )
      .run(threadId, renderedKey, b)

    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    const step = ledger.entries.find((e) => e.actorAgentId === renderedKey)
    expect(step?.actorDisplayName).toBe('Clean Peer')
    expect(step?.withheld).toBe(false)
    expect(step?.summary).toBe('ordinary summary')
  })

  it('verify minor: ledger rows expose era, so repeated ordinals across re-proposes stay distinguishable', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = threadWith(d, [a, b])
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    d.declinePact({ ...actor(b), threadId, reasonCode: 'not_now' })
    d.proposePact({ ...actor(a), threadId, peerAgentId: b, stepsTotal: null })
    const rows = d.getPactLedger({ threadId, revealSummaries: false }).entries
    const proposeEras = rows.filter((r) => r.kind === 'propose').map((r) => r.era)
    expect(proposeEras).toEqual([1, 2])
    for (const row of rows) {
      expect(typeof row.era).toBe('number')
    }
  })
})
