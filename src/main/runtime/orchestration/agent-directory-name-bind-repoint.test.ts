// Ruling 32 Addendum 10 (A3/F-5b): mail addressed to a bare display name before that name was
// ever bound to an agent (`recipient_pane_key IS NULL`, no read path scans a bare-name mailbox)
// gets a second chance the moment the name registers — on both the fresh-insert and re-mint
// paths of upsertAgentByPaneSuffix.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { upsertAgentByPaneSuffix, type UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('upsertAgentByPaneSuffix: bare-name mailbox repoint on register', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function baseParams(
    overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
  ): UpsertAgentByPaneSuffixParams {
    return {
      displayName: 'alpha',
      role: null,
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      terminalHandle: 'term_a',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_a',
      originHostId: 'local',
      ...overrides
    }
  }

  it('T-A4: a fresh register repoints unread bare-name mail with NULL pane key into agent:<id>', () => {
    const db = rawDb()
    db.prepare(
      `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, type, priority, read, sequence)
       VALUES ('m1', 'legacy_r', 'current_delivery', 'someone', 'alpha', 'hi', 'status', 'normal', 0, 1)`
    ).run()

    const result = upsertAgentByPaneSuffix(db, baseParams())
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') {
      throw new Error('expected created')
    }
    expect(result.repointedMessages).toBe(1)

    const moved = db.prepare('SELECT to_handle FROM messages WHERE id = ?').get('m1') as {
      to_handle: string
    }
    expect(moved.to_handle).toBe(`agent:${result.agent.id}`)

    const audit = db
      .prepare(
        "SELECT outcome, reason_code FROM agent_audit WHERE verb = 'mailbox_repoint' AND agent_id = ?"
      )
      .get(result.agent.id) as { outcome: string; reason_code: string } | undefined
    expect(audit?.outcome).toBe('ok')
    expect(audit?.reason_code).toContain('alpha')
  })

  it('a bare-name row that already has a recipient_pane_key is left alone (not the F-5b shape)', () => {
    const db = rawDb()
    db.prepare(
      `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, type, priority, read, sequence, recipient_pane_key)
       VALUES ('m2', 'legacy_r', 'current_delivery', 'someone', 'alpha', 'hi', 'status', 'normal', 0, 1, 'tabX:leaf-x')`
    ).run()

    const result = upsertAgentByPaneSuffix(db, baseParams())
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') {
      throw new Error('expected created')
    }
    expect(result.repointedMessages).toBe(0)
    const untouched = db.prepare('SELECT to_handle FROM messages WHERE id = ?').get('m2') as {
      to_handle: string
    }
    expect(untouched.to_handle).toBe('alpha')
  })

  it('a re-mint (rename) also repoints bare-name mail addressed to the NEW name', () => {
    const db = rawDb()
    const first = upsertAgentByPaneSuffix(db, baseParams({ displayName: 'first-name' }))
    expect(first.outcome).toBe('created')

    db.prepare(
      `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, type, priority, read, sequence)
       VALUES ('m3', 'legacy_r', 'current_delivery', 'someone', 'second-name', 'hi', 'status', 'normal', 0, 2)`
    ).run()

    const renamed = upsertAgentByPaneSuffix(
      db,
      baseParams({ displayName: 'second-name', terminalHandle: 'term_a_new' })
    )
    expect(renamed.outcome).toBe('reminted')
    if (renamed.outcome !== 'reminted') {
      throw new Error('expected reminted')
    }
    expect(renamed.repointedMessages).toBe(1)
    const moved = db.prepare('SELECT to_handle FROM messages WHERE id = ?').get('m3') as {
      to_handle: string
    }
    expect(moved.to_handle).toBe(`agent:${renamed.agent.id}`)
  })
})
