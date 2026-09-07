// S10-21c B2 (design §2 S6, chair synthesis S6): loud degradation at the sweep level.
// (b) `sweep_no_launch_row` — today audit-only — now ALSO writes a rate-clamped pane notice via
// `deps.writeHostNoticeToPane` (same primitive as `session-identity-mismatch-alarm.ts`'s
// `SessionIdentityMismatchAlarmDeps`/orca-runtime.ts's own `writeHostNoticeToPane`), alongside
// the existing `auditLayer3`. (a)'s companion: confirms the exact catch site
// (`restoreOneRegisteredPane`'s own `try { ensureAgentSession(...) } catch (err) { ... }`,
// restore-registered-agent-panes.ts ~193-206) converts a `LaunchAdmissionRefusedError` thrown
// out of `ensureAgentSession` (standing in for admission's real refusal path) into a Layer-3
// audit for that pane, without aborting the sweep for a second candidate.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { LaunchAdmissionRefusedError } from '../ipc/agent-launch-admission-errors'
import type {
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { ExecutionHostId } from '../../shared/execution-host'
import { runRestoreSweepBody } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21c B2/S6: loud degradation', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('sweep_no_launch_row writes BOTH the Layer-3 audit and one rate-clamped pane notice', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000aa'
    insertAgent(db, { id: 'agent-norow', display_name: 'chair-norow', pane_key: paneKey })
    const notices: { paneKey: string; text: string; opts: { rateKey: string } }[] = []
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        writeHostNoticeToPane: (pk, text, opts) => notices.push({ paneKey: pk, text, opts })
      })
    )
    expect(summary.layer3).toBe(1)
    expect(summary.deferredByReason['sweep_no_launch_row']).toBe(1)
    const auditRows = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code = 'sweep_no_launch_row'`)
      .all()
    expect(auditRows).toHaveLength(1)
    expect(notices).toHaveLength(1)
    expect(notices[0].paneKey).toBe(paneKey)
    expect(notices[0].opts.rateKey).toBeTruthy()
  })

  it('[D-R145 high 3] a throwing writeHostNoticeToPane on the no-row arm leaves summary.errors unchanged and the remaining candidates restored', async () => {
    const db = rawDb()
    const noRowPane = 'tab1:00000000-0000-4000-8000-0000000000ad'
    const okPane = 'tab2:00000000-0000-4000-8000-0000000000ae'
    insertAgent(db, { id: 'agent-ad', display_name: 'chair-ad', pane_key: noRowPane })
    insertAgent(db, { id: 'agent-ae', display_name: 'chair-ae', pane_key: okPane })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: okPane,
      agentType: 'claude',
      sessionId: 'sess-ae',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-ae',
        paneKey: okPane,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID as ExecutionHostId
      },
      disposition: 'created'
    })
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty:inc',
        writeHostNoticeToPane: () => {
          throw new Error('pane_notice_boom')
        }
      })
    )
    // The throw never escapes the loop: no-row pane still counts as a layer-3 deferral (never
    // `errors`), and the second candidate (a normal restore) still runs.
    expect(summary.errors).toBe(0)
    expect(summary.layer3).toBe(1)
    expect(summary.layer1 + summary.layer2).toBe(1)
    const auditRows = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code = 'sweep_no_launch_row'`)
      .all()
    expect(auditRows).toHaveLength(1)
    const noticeFailedRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE reason_code LIKE 'notice_failed:%pane_notice_boom%'`
      )
      .all()
    expect(noticeFailedRows).toHaveLength(1)
  })

  it('a restore_selector_lost refusal out of ensureAgentSession is a Layer-3 audit for that pane only — a second candidate still restores', async () => {
    const db = rawDb()
    const refusedPane = 'tab1:00000000-0000-4000-8000-0000000000ab'
    const okPane = 'tab2:00000000-0000-4000-8000-0000000000ac'
    insertAgent(db, { id: 'agent-ab', display_name: 'chair-ab', pane_key: refusedPane })
    insertAgent(db, { id: 'agent-ac', display_name: 'chair-ac', pane_key: okPane })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: refusedPane,
      agentType: 'claude',
      sessionId: 'sess-ab',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: okPane,
      agentType: 'claude',
      sessionId: 'sess-ac',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn(
      async (
        request: RuntimeEnsureAgentSessionRequest
      ): Promise<RuntimeEnsureAgentSessionResult> => {
        if (request.kind === 'explicit' && request.providerSession.id === 'sess-ab') {
          throw new LaunchAdmissionRefusedError('restore_selector_lost')
        }
        return {
          terminal: {
            handle: 'handle-ac',
            paneKey: okPane,
            worktreeId: 'wt-1',
            title: null,
            executionHostId: EXEC_HOST_ID as ExecutionHostId
          },
          disposition: 'created'
        }
      }
    )
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty:inc'
      })
    )
    expect(summary.layer3).toBe(1)
    expect(summary.layer1 + summary.layer2).toBe(1)
    expect(summary.errors).toBe(0) // caught by restoreOneRegisteredPane's OWN try/catch, not the outer one
    const auditRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE reason_code LIKE 'ensure_agent_session_failed:%restore_selector_lost%'`
      )
      .all()
    expect(auditRows).toHaveLength(1)
  })
})
