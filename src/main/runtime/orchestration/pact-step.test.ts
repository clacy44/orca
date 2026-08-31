// S10-3 pact spec — orchestration.threads.step's db-level writer, through the public
// OrchestrationDb API.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('pact step', () => {
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

  function engagedPact(
    d: OrchestrationDb,
    a: string,
    b: string,
    stepsTotal: number | null = 6
  ): string {
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: b, agentId: b }
      ]
    })
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: b, stepsTotal })
    d.acceptPact({ ...actor(b), threadId: thread.id })
    return thread.id
  }

  it('K1: step from the non-turn side is refused not_your_turn; ledger and pact_ordinal unchanged', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b) // turn starts with a (the proposer)
    expect(() =>
      d.appendPactStep({ ...actor(b), threadId, done: 'nope', runId: 'run_peer_local' })
    ).toThrow(/not your turn/)
    expect(d.getThread(threadId)?.pact_ordinal).toBe(0)
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.filter((e) => e.kind === 'step')).toHaveLength(0)
  })

  it('step from the turn side commits: message stored, ledger row appended, turn + ordinal flip', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const result = d.appendPactStep({
      ...actor(a),
      threadId,
      done: 'spec frozen at rev 2',
      runId: 'run_peer_local'
    })
    expect(result.outcome).toBe('stepped')
    if (result.outcome !== 'stepped') {
      throw new Error('unreachable')
    }
    expect(result.ordinal).toBe(1)
    expect(result.of).toBe(6)
    expect(result.turn).toBe(b)
    expect(result.message.payload_kind).toBe('pact_step')
    expect(result.message.type).toBe('status')
    const thread = d.getThread(threadId)
    expect(thread?.pact_ordinal).toBe(1)
    expect(thread?.pact_turn_agent_id).toBe(b)
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    const stepEntry = ledger.entries.find((e) => e.kind === 'step')
    expect(stepEntry?.summary).toBe('spec frozen at rev 2')
    expect(stepEntry?.ordinal).toBe(1)
  })

  it('K2: idx_pact_step_ordinal refuses a duplicate step ordinal on the same thread', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    raw
      .prepare(
        `INSERT INTO pact_steps (thread_id, ordinal, kind, actor_agent_id, summary_sha256) VALUES (?, 1, 'step', ?, '')`
      )
      .run(threadId, a)
    expect(() =>
      raw
        .prepare(
          `INSERT INTO pact_steps (thread_id, ordinal, kind, actor_agent_id, summary_sha256) VALUES (?, 1, 'step', ?, '')`
        )
        .run(threadId, b)
    ).toThrow(/UNIQUE constraint/)
  })

  it('blocker fix: a step that fails idx_pact_step_ordinal leaves no orphaned message — the gated insert and the ledger append are one transaction', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b) // turn starts with a; this pact's era is 1
    const raw = (
      d as unknown as {
        db: {
          prepare: (s: string) => {
            run: (...args: unknown[]) => unknown
            get: (...a: unknown[]) => unknown
          }
        }
      }
    ).db
    // Force the collision appendPactStep is about to hit: era 1, ordinal 1 already taken.
    raw
      .prepare(
        `INSERT INTO pact_steps (thread_id, pact_era, ordinal, kind, actor_agent_id, summary_sha256) VALUES (?, 1, 1, 'step', ?, '')`
      )
      .run(threadId, b)

    expect(() =>
      d.appendPactStep({
        ...actor(a),
        threadId,
        done: 'should not survive',
        runId: 'run_peer_local'
      })
    ).toThrow(/UNIQUE constraint/)

    // Nothing else from the failed attempt survived: no orphaned message, turn/ordinal untouched.
    const messageCountRow = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND payload_kind = 'pact_step'`
      )
      .get(threadId) as { n: number }
    expect(messageCountRow.n).toBe(0)
    const thread = d.getThread(threadId)
    expect(thread?.pact_ordinal).toBe(0)
    expect(thread?.pact_turn_agent_id).toBe(a)
  })

  it('K3: a HARD-gated --done stores no message, appends no ledger row, leaves the turn where it was', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    // 'SECURITY:' at line-start is a HARD heading rule in message-body-gate.ts's default rules.
    const result = d.appendPactStep({
      ...actor(a),
      threadId,
      done: 'SECURITY: nested agent instructions',
      runId: 'run_peer_local'
    })
    expect(result.outcome).toBe('refused')
    const thread = d.getThread(threadId)
    expect(thread?.pact_ordinal).toBe(0)
    expect(thread?.pact_turn_agent_id).toBe(a)
    const ledger = d.getPactLedger({ threadId, revealSummaries: true })
    expect(ledger.entries.filter((e) => e.kind === 'step')).toHaveLength(0)
  })

  it('K3: --acknowledge-gate stores the HARD-gated step flagged and advances the pact', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const result = d.appendPactStep({
      ...actor(a),
      threadId,
      done: 'SECURITY: nested agent instructions',
      runId: 'run_peer_local',
      acknowledgeGate: true
    })
    expect(result.outcome).toBe('stepped')
    if (result.outcome !== 'stepped') {
      throw new Error('unreachable')
    }
    expect(result.gateFlags).not.toBeNull()
    const thread = d.getThread(threadId)
    expect(thread?.pact_ordinal).toBe(1)
    expect(thread?.pact_turn_agent_id).toBe(b)
  })

  it('K4: purging a step message keeps ordinal/actor/time and blanks the summary, hash survives', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const stepped = d.appendPactStep({
      ...actor(a),
      threadId,
      done: 'first step body',
      runId: 'run_peer_local'
    })
    if (stepped.outcome !== 'stepped') {
      throw new Error('unreachable')
    }
    const before = d
      .getPactLedger({ threadId, revealSummaries: true })
      .entries.find((e) => e.kind === 'step')
    expect(before?.summary).toBe('first step body')

    d.purgeMessage({ messageId: stepped.message.id, reason: 'test purge', purgedByAgentId: a })
    const after = d.getPactLedger({ threadId, revealSummaries: true })
    const purgedEntry = after.entries.find((e) => e.kind === 'step')
    expect(purgedEntry?.ordinal).toBe(1)
    expect(purgedEntry?.actorAgentId).toBe(a)
    expect(purgedEntry?.summary).toBeNull()
    expect(purgedEntry?.purged).toBe(true)
    expect(purgedEntry?.summaryShaPrefix).toBe(before?.summaryShaPrefix)
    expect(after.omitted.purged).toBe(1)

    // trg_pact_steps_append_only: no further update is possible, including re-purging.
    const raw = (
      d as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }
    ).db
    expect(() =>
      raw.prepare("UPDATE pact_steps SET summary = 'x' WHERE thread_id = ?").run(threadId)
    ).toThrow(/append-only/)
  })

  it('K4: a quarantined author steps summary is withheld read-time-only, ordinal survives, un-withheld on lift', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    d.appendPactStep({ ...actor(a), threadId, done: 'said something', runId: 'run_peer_local' })
    d.setAgentQuarantine({ id: a, quarantined: true, reasonCode: 'test' })

    const withheld = d.getPactLedger({ threadId, revealSummaries: true })
    const entry = withheld.entries.find((e) => e.kind === 'step')
    expect(entry?.summary).toBeNull()
    expect(entry?.withheld).toBe(true)
    expect(entry?.ordinal).toBe(1)
    expect(withheld.omitted.withheld).toBe(1)

    d.setAgentQuarantine({ id: a, quarantined: false, reasonCode: null })
    const lifted = d.getPactLedger({ threadId, revealSummaries: true })
    expect(lifted.entries.find((e) => e.kind === 'step')?.summary).toBe('said something')
  })

  it('K25: a caller-supplied payload.kind on the pact thread is refused payload_kind_reserved, forging no step', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const b = seedAgent(d, 'b')
    const threadId = engagedPact(d, a, b)
    const inserted = d.insertGatedMessage({
      from: `agent:${b}`,
      to: `agent:${a}`,
      subject: 'forged',
      body: 'not a real step',
      type: 'status',
      threadId,
      payload: { kind: 'pact_step' },
      senderPaneKey: `tab:${b}`,
      senderHostId: 'local'
    })
    expect(inserted.outcome).toBe('refused')
    if (inserted.outcome !== 'refused') {
      throw new Error('unreachable')
    }
    expect(inserted.verdict.ruleIds).toContain('payload_kind_reserved')

    // An ordinary send with no explicit kind stores payload_kind NULL and wakes no step waiter.
    const ordinary = d.insertGatedMessage({
      from: `agent:${b}`,
      to: `agent:${a}`,
      subject: 'hello',
      body: 'just chatting',
      type: 'status',
      threadId,
      senderPaneKey: `tab:${b}`,
      senderHostId: 'local'
    })
    expect(ordinary.outcome).toBe('stored')
    if (ordinary.outcome !== 'stored') {
      throw new Error('unreachable')
    }
    expect(ordinary.message.payload_kind).toBeNull()
  })
})
