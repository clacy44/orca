// D-30a / Ruling 36 (train 10z.9, arm H): a HOST_RESUME relaunch whose command carries the trailing
// re-anchor prompt is admitted exactly like one without it — the prompt is never read as a selector.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { DAEMON_DEATH_REANCHOR_PROMPT } from '../../shared/daemon-death-reanchor-prompt'

const HOST_ID = 'local'
const X = '33333333-3333-4333-8333-333333333333'
const COMMAND = `claude --resume ${X} --effort high '${DAEMON_DEATH_REANCHOR_PROMPT}'`
const ADMISSION: LaunchAdmission = {
  kind: 'host-resume',
  sessionId: X,
  predecessorPaneKey: 'tab1:leaf-old',
  executionHostId: HOST_ID,
  launchGeneration: 'gen-1'
}

describe('D-30a T4: HOST_RESUME admission with the trailing re-anchor prompt', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function rawDb(): Database.Database {
    return (db as unknown as { db: Database.Database }).db
  }

  function ctx() {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {},
      findConnectedPtyForPane: () => false,
      callerResume: null
    }
  }

  function opts(): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', command: COMMAND }
  }

  function seedHolder(paneKey: string): void {
    db!.recordLaunch({
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: X,
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
  }

  it('(a) is recorded as host_resume for the ticket session, the command untouched', async () => {
    db = new OrchestrationDb(':memory:')
    seedHolder('tab1:leaf-old')
    const admitted = await admitAgentLaunch(() => db!, opts(), ADMISSION, ctx())
    expect(admitted.classification).toBe('host_resume')
    expect(admitted.spawnOptions.command).toBe(COMMAND)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')?.session_id).toBe(X)
    const refusals = rawDb()
      .prepare(
        `SELECT reason_code FROM agent_audit
         WHERE verb IN ('launch_refused', 'launch_unrecorded')`
      )
      .all()
    expect(refusals).toEqual([])
  })

  it('(b) a session held by another pane is refused launch_record_write_failed, nothing superseded', async () => {
    db = new OrchestrationDb(':memory:')
    seedHolder('tab1:leaf-q')
    await expect(admitAgentLaunch(() => db!, opts(), ADMISSION, ctx())).rejects.toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'launch_record_write_failed'
    })
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-q')?.session_id).toBe(X)
    expect(
      rawDb()
        .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get(HOST_ID, 'tab1:leaf-q')
    ).toEqual({ session_id: X })
  })
})
