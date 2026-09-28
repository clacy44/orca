// 10z.5 R287 (T13 partial, T14): the identity a session is attributed to on this host, and the
// host-scoped newest-launch read it rests on. Pref resolution (R289) is a separate module.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { attributedIdentityForSession } from './caller-resume-launch-preferences'
import { OrchestrationDb } from './db'

const HOST = 'local'
const EXEC = 'local'
const X = '44444444-4444-4444-8444-444444444444'
const PANE_A = 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tab-b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('attributedIdentityForSession / newestHostScopedLaunchForSession', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  function fresh(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }
  function register(d: OrchestrationDb, name: string, paneKey: string): string {
    const created = d.upsertAgentByPaneSuffix({
      displayName: name,
      role: null,
      hostId: HOST,
      paneKey,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: HOST
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    return created.agent.id
  }
  function launch(d: OrchestrationDb, paneKey: string, executionHostId = EXEC, agentId?: string) {
    const result = d.recordLaunch({
      hostId: HOST,
      paneKey,
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-1',
      executionHostId,
      evidence: 'host_launch'
    })
    if (!result.ok) {
      throw new Error('fixture setup failed')
    }
    if (agentId) {
      d.setLaunchAgentId({ seq: result.row.seq }, agentId)
    }
    return result.row.seq
  }

  it('no launch row and no holder: undefined', () => {
    expect(attributedIdentityForSession(fresh(), HOST, EXEC, X)).toBeUndefined()
  })

  it("falls back to the holder's registered row when no launch row carries an agent id", () => {
    const d = fresh()
    const id = register(d, 'chair-a', PANE_A)
    launch(d, PANE_A)
    expect(attributedIdentityForSession(d, HOST, EXEC, X)?.id).toBe(id)
  })

  it('prefers the newest host-scoped launch row with a non-null agent id', () => {
    const d = fresh()
    const id = register(d, 'chair-a', PANE_A)
    launch(d, PANE_A, EXEC, id)
    expect(
      d.newestHostScopedLaunchForSession(HOST, EXEC, X, { requireAgentId: true })?.agent_id
    ).toBe(id)
    expect(attributedIdentityForSession(d, HOST, EXEC, X)?.id).toBe(id)
  })

  it('ignores a launch row of another execution host', () => {
    const d = fresh()
    const id = register(d, 'chair-a', PANE_A)
    launch(d, PANE_A, 'ssh-elsewhere', id)
    expect(d.newestHostScopedLaunchForSession(HOST, EXEC, X)).toBeUndefined()
  })

  it('excludePaneKey drops that pane row and its holder claim', () => {
    const d = fresh()
    const id = register(d, 'chair-a', PANE_A)
    launch(d, PANE_A, EXEC, id)
    expect(attributedIdentityForSession(d, HOST, EXEC, X, PANE_A)).toBeUndefined()
    expect(attributedIdentityForSession(d, HOST, EXEC, X, PANE_B)?.id).toBe(id)
    expect(
      d.newestHostScopedLaunchForSession(HOST, EXEC, X, { excludePaneKey: PANE_A })
    ).toBeUndefined()
  })

  it('a tombstoned or quarantined identity is not attributed', () => {
    const d = fresh()
    const id = register(d, 'chair-a', PANE_A)
    launch(d, PANE_A, EXEC, id)
    const raw = (d as unknown as { db: Database.Database }).db
    raw.prepare(`UPDATE agents SET quarantined = 1 WHERE id = ?`).run(id)
    expect(attributedIdentityForSession(d, HOST, EXEC, X)).toBeUndefined()
    raw
      .prepare(`UPDATE agents SET quarantined = 0, tombstoned_at = datetime('now') WHERE id = ?`)
      .run(id)
    expect(attributedIdentityForSession(d, HOST, EXEC, X)).toBeUndefined()
  })

  it('a derived identity is not attributed', () => {
    const d = fresh()
    const id = register(d, 'chair-a', PANE_A)
    launch(d, PANE_A, EXEC, id)
    ;(d as unknown as { db: Database.Database }).db
      .prepare(`UPDATE agents SET derived = 1 WHERE id = ?`)
      .run(id)
    expect(attributedIdentityForSession(d, HOST, EXEC, X)).toBeUndefined()
  })
})
