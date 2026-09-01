import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { checkAndBumpRate } from './agent-rate-limit'

describe('checkAndBumpRate', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('allows up to the limit within a window, then refuses with retryAfterMs', () => {
    const db = rawDb()
    const params = {
      subjectKey: 'pane:tab1:leaf-aaa',
      verb: 'register',
      windowMs: 60_000,
      limit: 2
    }
    expect(checkAndBumpRate(db, params)).toEqual({ allowed: true })
    expect(checkAndBumpRate(db, params)).toEqual({ allowed: true })
    const third = checkAndBumpRate(db, params)
    expect(third.allowed).toBe(false)
    if (!third.allowed) {
      expect(third.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('separate subject keys/verbs get independent windows', () => {
    const db = rawDb()
    const a = checkAndBumpRate(db, {
      subjectKey: 'pane:a',
      verb: 'register',
      windowMs: 60_000,
      limit: 1
    })
    const b = checkAndBumpRate(db, {
      subjectKey: 'pane:b',
      verb: 'register',
      windowMs: 60_000,
      limit: 1
    })
    expect(a).toEqual({ allowed: true })
    expect(b).toEqual({ allowed: true })
  })

  // Mutation proof: a rate limiter that bumps the counter even on refusal (rather than only
  // on allow) would let a caller's Nth request corrupt the count for the window after it —
  // this asserts refused calls do not advance the count further.
  it('MUTATION PROOF: a refused call does not itself get counted twice', () => {
    const db = rawDb()
    const params = { subjectKey: 'pane:x', verb: 'find', windowMs: 60_000, limit: 1 }
    checkAndBumpRate(db, params) // count -> 1, allowed
    checkAndBumpRate(db, params) // refused, count must stay at 1
    const row = db
      .prepare('SELECT count FROM agent_rate WHERE subject_key = ? AND verb = ?')
      .get('pane:x', 'find') as { count: number }
    expect(row.count).toBe(1)
  })

  // S10-15 (INV-P-006): agent_rate is peer-writable and must never grow forever — pruned
  // opportunistically inside checkAndBumpRate's own transaction. Both the stale row and the
  // bump below share verb 'register' — the prune is verb-scoped (V-1), so this asserts pruning
  // of a stale SAME-verb row, not merely any stale row.
  it('prunes an old-window row of the SAME verb on the next bump, while keeping the current window', () => {
    const db = rawDb()
    db.prepare(
      `INSERT INTO agent_rate (subject_key, verb, window_start, count) VALUES (?, ?, ?, ?)`
    ).run('pane:old', 'register', new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), 1)

    expect(
      checkAndBumpRate(db, { subjectKey: 'pane:new', verb: 'register', windowMs: 60_000, limit: 5 })
    ).toEqual({ allowed: true })

    const oldRow = db
      .prepare('SELECT count FROM agent_rate WHERE subject_key = ?')
      .get('pane:old') as { count: number } | undefined
    expect(oldRow).toBeUndefined()
    const newRow = db
      .prepare('SELECT count FROM agent_rate WHERE subject_key = ?')
      .get('pane:new') as { count: number } | undefined
    expect(newRow?.count).toBe(1)
  })

  // V-1 regression: the prune must be scoped to the bumping call's OWN verb. Before the fix,
  // DELETE FROM agent_rate WHERE window_start < ? had no verb filter, so a short-window verb's
  // bump (e.g. 'find', windowMs MINUTE_MS) could delete a different verb's still-current row
  // (e.g. 'quarantine', windowMs DAY_MS) purely because the other verb's window_start looked
  // stale relative to the short window's own (much smaller) retention threshold.
  it('V-1: a short-window verb bump does not prune a different verb DAY_MS window row for the same subject', () => {
    const db = rawDb()
    const DAY_MS = 24 * 60 * 60 * 1000
    const MINUTE_MS = 60 * 1000
    const subjectKey = 'pane:shared-subject'

    // Subject A bumps a DAY_MS-windowed verb (e.g. 'quarantine').
    expect(
      checkAndBumpRate(db, { subjectKey, verb: 'quarantine', windowMs: DAY_MS, limit: 10 })
    ).toEqual({ allowed: true })

    // 3 hours pass — well within the DAY_MS window, but past a naive 1h-floor retention.
    const advance = 3 * 60 * 60 * 1000
    const realNow = Date.now()
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + advance)
    try {
      // A different subject bumps a MINUTE_MS-windowed verb (e.g. 'find').
      expect(
        checkAndBumpRate(db, {
          subjectKey: 'pane:other-subject',
          verb: 'find',
          windowMs: MINUTE_MS,
          limit: 100
        })
      ).toEqual({ allowed: true })
    } finally {
      dateNowSpy.mockRestore()
    }

    // The DAY_MS quarantine row for subject A must still exist with its count preserved.
    const quarantineRow = db
      .prepare('SELECT count FROM agent_rate WHERE subject_key = ? AND verb = ?')
      .get(subjectKey, 'quarantine') as { count: number } | undefined
    expect(quarantineRow?.count).toBe(1)

    // A further DAY_MS bump for subject A must see count 2, not 1 (i.e. the prior row was not
    // wiped and replaced by a fresh count-1 row).
    expect(
      checkAndBumpRate(db, { subjectKey, verb: 'quarantine', windowMs: DAY_MS, limit: 10 })
    ).toEqual({ allowed: true })
    const quarantineRowAfter = db
      .prepare('SELECT count FROM agent_rate WHERE subject_key = ? AND verb = ?')
      .get(subjectKey, 'quarantine') as { count: number } | undefined
    expect(quarantineRowAfter?.count).toBe(2)
  })
})
