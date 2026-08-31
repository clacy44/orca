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
})
