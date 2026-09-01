import { afterEach, describe, expect, it } from 'vitest'
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
  // opportunistically inside checkAndBumpRate's own transaction.
  it('prunes an old-window row on the next bump, while keeping the current window', () => {
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
})
