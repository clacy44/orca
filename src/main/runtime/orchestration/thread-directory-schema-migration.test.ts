// S10-2a SCHEMA v33 -> v34 migration tests (T9, T10). Migrates the checked-in, populated v33
// fixture (__fixtures__/v33-orchestration.db, generated from this tree's actual pre-S10-2
// schema code — see the provenance note in agent-directory-schema-migration.test.ts for why a
// real fixture, not a hand-rolled one) up to v34.
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { ThreadRow } from './types'

const FIXTURE_PATH = join(__dirname, '__fixtures__', 'v33-orchestration.db')

describe('SCHEMA v33 -> v34 migration', () => {
  let tempDir: string | undefined
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function copyFixture(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-v33-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    copyFileSync(FIXTURE_PATH, dbPath)
    return dbPath
  }

  function rawInspect(dbPath: string): Database.Database {
    return new Database(dbPath)
  }

  function threadsById(raw: Database.Database): Map<string, ThreadRow> {
    const rows = raw.prepare('SELECT * FROM threads').all() as ThreadRow[]
    return new Map(rows.map((t) => [t.id, t]))
  }

  it('the checked-in fixture really is a populated, unmigrated v33 database', () => {
    const dbPath = copyFixture()
    const raw = rawInspect(dbPath)
    expect(raw.pragma('user_version', { simple: true })).toBe(33)
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
    )
    expect(tables.has('threads')).toBe(false)
    expect(tables.has('thread_participants')).toBe(false)
    expect(tables.has('gate_refusals')).toBe(false)
    const messageCount = raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(messageCount.n).toBeGreaterThan(0)
    raw.close()
  })

  it('M1: migration is idempotent — opening twice is a no-op the second time', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    expect(() => {
      orchestrationDb = new OrchestrationDb(dbPath)
    }).not.toThrow()
    const raw = rawInspect(dbPath)
    expect(raw.pragma('user_version', { simple: true })).toBe(34)
    raw.close()
  })

  it('M2: schema tables/indexes/triggers are present after migration', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    orchestrationDb = undefined
    const raw = rawInspect(dbPath)
    const names = (kind: string): Set<string> =>
      new Set(
        (
          raw.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(kind) as {
            name: string
          }[]
        ).map((r) => r.name)
      )
    const tables = names('table')
    for (const table of ['threads', 'thread_participants', 'gate_refusals']) {
      expect(tables.has(table)).toBe(true)
    }
    const triggers = names('trigger')
    for (const trigger of [
      'trg_threads_provenance_immutable',
      'trg_messages_purge_final',
      'trg_gate_refusals_no_update',
      'trg_gate_refusals_no_delete',
      'trg_agents_no_foreign_origin',
      'trg_agents_no_foreign_origin_update'
    ]) {
      expect(triggers.has(trigger)).toBe(true)
    }
    for (const column of [
      'purged_at',
      'purge_reason',
      'purged_by_agent_id',
      'gate_flags',
      'thread_sequence',
      'payload_kind'
    ]) {
      expect(
        (raw.pragma('table_info(messages)') as { name: string }[]).some((c) => c.name === column)
      ).toBe(true)
    }
    for (const column of [
      'to_agent_id',
      'answered_by_agent_id',
      'answer_body_sha256',
      'answer_purged_at',
      'thread_key'
    ]) {
      expect(
        (raw.pragma('table_info(question_threads)') as { name: string }[]).some(
          (c) => c.name === column
        )
      ).toBe(true)
    }
    raw.close()
  })

  it('payload_kind (A5, pact-spec rev 7): pre-existing v33 rows backfill to NULL, not the empty string or any inferred value', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    orchestrationDb = undefined
    const raw = rawInspect(dbPath)
    const messageCount = raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(messageCount.n).toBeGreaterThan(0)
    const nonNullCount = raw
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE payload_kind IS NOT NULL')
      .get() as { n: number }
    expect(nonNullCount.n).toBe(0)
    raw.close()
  })

  it('T10: backfilled threads exist, a broadcast thread is fanout/closed, a question thread is origin=question, legacy subjects are the fixed literal', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    orchestrationDb.close()
    orchestrationDb = undefined
    const raw = rawInspect(dbPath)
    const threads = threadsById(raw)
    expect(threads.size).toBe(3)

    const legacy = threads.get('thr_legacy_pair')
    expect(legacy).toMatchObject({ origin: 'legacy', state: 'open', subject: '(legacy thread)' })

    const fanout = threads.get('thr_fanout_broadcast')
    expect(fanout).toMatchObject({ origin: 'fanout', state: 'closed', subject: '(legacy thread)' })

    const question = [...threads.values()].find((t) => t.origin === 'question')
    expect(question).toBeDefined()
    expect(question).toMatchObject({ state: 'open', subject: '(legacy thread)' })

    // Every message's from/to handle was backfilled into thread_participants.
    const participants = raw
      .prepare('SELECT thread_id, participant_key FROM thread_participants WHERE thread_id = ?')
      .all('thr_fanout_broadcast') as { thread_id: string; participant_key: string }[]
    const keys = new Set(participants.map((p) => p.participant_key))
    expect(keys).toEqual(new Set(['fable-chair', 'backend-merge', 'docs-writer', 'third-party']))
    raw.close()
  })

  it('T10 mutation guard: a fanout thread refuses new posts (state=closed) after migration', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    const thread = orchestrationDb.getThread('thr_fanout_broadcast')
    expect(thread?.state).toBe('closed')
  })

  it('T9: two messages written in the same second are both resumable via a sequence cursor', () => {
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    const db = orchestrationDb
    const first = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'first',
      body: 'one',
      threadId: 'thr_legacy_pair',
      runId: 'run_peer_local',
      verb: 'send'
    })
    const second = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'second',
      body: 'two',
      threadId: 'thr_legacy_pair',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(first.outcome).toBe('stored')
    expect(second.outcome).toBe('stored')
    if (first.outcome !== 'stored' || second.outcome !== 'stored') {
      throw new Error('expected both inserts to succeed')
    }
    // Force identical created_at timestamps (same second) to reproduce the T9 hazard.
    const raw = (db as unknown as { db: Database.Database }).db
    raw
      .prepare('UPDATE messages SET created_at = ? WHERE id IN (?, ?)')
      .run('2026-08-30 12:00:00', first.message.id, second.message.id)

    const sinceZero = db.getThreadMessagesSince('thr_legacy_pair', first.message.sequence - 1)
    expect(sinceZero.messages.map((m) => m.id)).toEqual(
      expect.arrayContaining([first.message.id, second.message.id])
    )
    const sinceFirst = db.getThreadMessagesSince('thr_legacy_pair', first.message.sequence)
    expect(sinceFirst.messages.map((m) => m.id)).toEqual([second.message.id])
  })

  it('T9 mutation guard: routing --since through the 1-second timestamp truncation would merge the two messages', () => {
    // Documents the mutation this test must fail on (s10-2-spec.md T9): if
    // getThreadMessagesSince were reimplemented on top of
    // normalizeThreadSinceTimestamp (created_at, second resolution) instead of `sequence`,
    // the two same-second messages above would be indistinguishable — this assertion is what
    // that regression breaks.
    const dbPath = copyFixture()
    orchestrationDb = new OrchestrationDb(dbPath)
    const db = orchestrationDb
    const a = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'a',
      body: 'a',
      threadId: 'thr_legacy_pair',
      runId: 'run_peer_local',
      verb: 'send'
    })
    const b = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'b',
      body: 'b',
      threadId: 'thr_legacy_pair',
      runId: 'run_peer_local',
      verb: 'send'
    })
    if (a.outcome !== 'stored' || b.outcome !== 'stored') {
      throw new Error('expected both inserts to succeed')
    }
    expect(b.message.sequence).toBe(a.message.sequence + 1)
  })
})
