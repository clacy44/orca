// S10-21a C7g (Ruling 34 Addendum 25): pty.ts's post-spawn-commit gate — the pane's newest
// daemon_died/rebind audit. Query SHAPE reused from agent-sweep-unrecorded-check.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const HOST_ID = 'local'
const PANE_KEY = 'tab1:leaf-a'

describe('S10-21a C7g: newestDaemonDeathOrRebindVerbForPane', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function freshDb(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }

  it('returns null when the pane has no daemon_died or rebind audit at all', () => {
    const db = freshDb()
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'launch_unrecorded',
      outcome: 'admitted',
      reasonCode: null
    })
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBeNull()
  })

  it("returns 'daemon_died' when that is the newest of the two verbs", () => {
    const db = freshDb()
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBe('daemon_died')
  })

  it("a later 'rebind' always outranks an earlier 'daemon_died' — the gate must not re-fire", () => {
    const db = freshDb()
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    db.writeAgentAudit({
      agentId: 'agent-1',
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'rebind',
      outcome: 'reminted',
      reasonCode: 'daemon respawn handle refresh'
    })
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBe('rebind')
  })

  it('is scoped per pane (suffix match), never bleeding across panes', () => {
    const db = freshDb()
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: 'tab2:leaf-b',
      actorHostId: HOST_ID,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBeNull()
  })

  it("[S10-21c B3b, D-R149 LOW 5] a REFUSED rebind (the gate's own refuse_fresh_session audit) does not outrank an earlier daemon_died — a later host_resume/self_resume_caller still refreshes", () => {
    const db = freshDb()
    // daemon_died: the pane's controller died.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    // plain `claude` (host_minted) reaches the gate and is refused a fresh session — this is
    // exactly the audit pty.ts writes for `refuse_fresh_session` (verb 'rebind', outcome
    // 'refused', reasonCode 'daemon_respawn_fresh_session'). Nothing was resolved.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'rebind',
      outcome: 'refused',
      reasonCode: 'daemon_respawn_fresh_session'
    })
    // The pane's daemon_died fact still stands — a subsequent `--resume <real id>` must still see
    // it and refresh, not see the refusal and stay silent.
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBe('daemon_died')
  })

  it('[S10-21c B3c, D-R151 MEDIUM 2] a CONTESTED rebind (incumbent_alive/predecessor_moved) does not outrank an earlier daemon_died either — nothing was rebound', () => {
    const db = freshDb()
    // daemon_died: the pane's controller died.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    // rebindRestoredPane's own contested-refusal audit (agent-restore-rebind.ts): verb 'rebind',
    // outcome 'contested', for either CONTESTED_REFUSAL_REASONS. Nothing was resolved.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: HOST_ID,
      verb: 'rebind',
      outcome: 'contested',
      reasonCode: 'incumbent_alive'
    })
    // The pane's daemon_died fact still stands — a subsequent host_resume/self_resume_caller must
    // still see it and refresh, not see the contested rebind and stay silent.
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBe('daemon_died')
  })

  it('[S10-21a C14b, D-R128 host_id scoping] is scoped per host, never bleeding across hosts sharing a pane suffix', () => {
    const db = freshDb()
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_KEY,
      actorHostId: 'other-host',
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, HOST_ID)).toBeNull()
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY, 'other-host')).toBe('daemon_died')
  })
})
