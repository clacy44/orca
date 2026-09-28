// 10z.5 R290 (T18): a pane caller-resumed into a session whose registered identity is bound to
// another pane. Durable evidence only; the successor-pane nudge (host_launch) is never matched.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

const HOST = 'local'
const EXEC = 'local'
const X = '66666666-6666-4666-8666-666666666666'
const PANE_A = 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_P = 'tab-p:pppppppp-pppp-4ppp-8ppp-pppppppppppp'

describe('paneCallerResumedIntoHeldIdentity', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  const raw = (d: OrchestrationDb) => (d as unknown as { db: Database.Database }).db

  // Identity A registered on PANE_A and attributed to X through A's own launch row.
  function fixture(): { d: OrchestrationDb; agentId: string } {
    const d = new OrchestrationDb(':memory:')
    db = d
    const created = d.upsertAgentByPaneSuffix({
      displayName: 'chair-a',
      role: null,
      hostId: HOST,
      paneKey: PANE_A,
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
    const launched = d.recordLaunch({
      hostId: HOST,
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-1',
      executionHostId: EXEC,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch failed')
    }
    d.setLaunchAgentId({ seq: launched.row.seq }, created.agent.id)
    return { d, agentId: created.agent.id }
  }

  // P's own launch row for X. A still holds X, so the fixture releases A's claim first.
  function launchP(d: OrchestrationDb, evidence: 'caller_resume' | 'host_launch'): void {
    raw(d).prepare('DELETE FROM current_sessions WHERE pane_key = ?').run(PANE_A)
    const result = d.recordLaunch({
      hostId: HOST,
      paneKey: PANE_P,
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-1',
      executionHostId: EXEC,
      evidence
    })
    if (!result.ok) {
      throw new Error('fixture launch failed')
    }
  }

  function unrecorded(d: OrchestrationDb, reason: string, agentId: string | null): void {
    d.writeAgentAudit({
      agentId,
      actorPaneKey: PANE_P,
      actorHostId: HOST,
      verb: 'launch_unrecorded',
      outcome: 'admitted',
      reasonCode: reason
    })
  }

  it('branch (a): newest launch row caller_resume for X, X attributed to A bound elsewhere -> true', () => {
    const { d } = fixture()
    launchP(d, 'caller_resume')
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(true)
  })

  it('branch (b): no launch row, unrecorded audit row without_live_pty or without_live_agent -> true', () => {
    const { d, agentId } = fixture()
    unrecorded(d, 'resume_target_owned_by_pane_without_live_pty', agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(true)
    unrecorded(d, 'resume_target_owned_by_pane_without_live_agent', agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(true)
  })

  it('a host_launch newest row (the successor-pane nudge) -> false', () => {
    const { d } = fixture()
    launchP(d, 'host_launch')
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
  })

  it('other unrecorded reasons, a null agent_id, and an unknown pane -> false', () => {
    const { d, agentId } = fixture()
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
    unrecorded(d, 'resume_target_outside_pane_project', agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
    unrecorded(d, 'resume_target_owned_by_pane_without_live_pty', null)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
  })

  it('A bound to P itself -> false', () => {
    const { d, agentId } = fixture()
    raw(d).prepare('UPDATE agents SET pane_key = ? WHERE id = ?').run(PANE_P, agentId)
    unrecorded(d, 'resume_target_owned_by_pane_without_live_pty', agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
  })

  it('a derived or tombstoned A -> false, on both branches', () => {
    const { d, agentId } = fixture()
    unrecorded(d, 'resume_target_owned_by_pane_without_live_pty', agentId)
    raw(d).prepare('UPDATE agents SET derived = 1 WHERE id = ?').run(agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
    raw(d)
      .prepare("UPDATE agents SET derived = 0, tombstoned_at = datetime('now') WHERE id = ?")
      .run(agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)

    const other = fixture()
    launchP(other.d, 'caller_resume')
    raw(other.d).prepare('UPDATE agents SET derived = 1 WHERE id = ?').run(other.agentId)
    expect(other.d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
  })

  it('an agent row with a null pane_key -> false', () => {
    const { d, agentId } = fixture()
    unrecorded(d, 'resume_target_owned_by_pane_without_live_pty', agentId)
    raw(d).prepare('UPDATE agents SET pane_key = NULL WHERE id = ?').run(agentId)
    expect(d.paneCallerResumedIntoHeldIdentity(HOST, PANE_P)).toBe(false)
  })
})
