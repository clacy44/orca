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
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY)).toBeNull()
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
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY)).toBe('daemon_died')
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
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY)).toBe('rebind')
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
    expect(db.newestDaemonDeathOrRebindVerbForPane(PANE_KEY)).toBeNull()
  })
})
