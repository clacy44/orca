// [S10-21d R118, C4] e2e for the per-pane model/effort persist-and-reapply slice: a real
// agent_launch_sessions row (via recordLaunch/updateLaunchPrefsForPane, the C1/C2 store
// primitives) is read back exactly as restore-registered-agent-panes.ts:210-229 (C3) reads it,
// and fed into buildAgentResumeStartupPlan (C3's tui-agent-startup.ts fix) to prove the actual
// relaunch ARGV carries the right flags — not merely that some intermediate object was called
// with the right shape.
//
// DEVIATION (recorded per dispatch instructions): the brief names "the existing sweep harness"
// (runRestoreSweep + a mocked ensureAgentSession, as used throughout
// restore-registered-agent-panes.test.ts). That harness's ensureAgentSession is a vi.fn() double
// standing in for the real OrcaRuntimeService method — using it here would only prove
// launchPreferences reaches the request object (already covered by the two R118 tests just added
// to restore-registered-agent-panes.test.ts), not that the argv itself carries the flags, which
// is what C4 actually asks for. Wiring a real OrcaRuntimeService end-to-end (real pty provider,
// real terminal creation) is out of proportion to this slice. This file instead chains the real
// production functions the sweep restore path actually calls, in the same order, without a
// mocked ensureAgentSession standing in for the part under test.
import type Database from '../sqlite/sync-database'
import { afterEach, describe, expect, it } from 'vitest'
import {
  recordLaunch,
  updateLaunchPrefsForPane,
  newestLaunchForPane,
  launchPreferencesFromRow
} from '../runtime/orchestration/agent-launch-sessions'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'

// Mirrors orca-runtime.ts's toAgentSessionOptions verbatim (model/effort only, this slice's scope).
function toSessionOptions(
  prefs: { model?: string; effort?: string } | undefined
): Record<string, string> | undefined {
  if (!prefs) {
    return undefined
  }
  const options = {
    ...(prefs.model ? { model: prefs.model } : {}),
    ...(prefs.effort ? { effort: prefs.effort } : {})
  }
  return Object.keys(options).length > 0 ? options : undefined
}

describe('S10-21d R118 C4: launch prefs survive a restart-sweep relaunch (e2e chain)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  // Real OrchestrationDb (the actual v43 schema, migrations included), not a hand-rolled
  // fixture — faithful to what the sweep restore path runs against in production.
  function freshDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function relaunchCommandFor(sqlite: Database.Database, paneKey: string): string | undefined {
    const row = newestLaunchForPane(sqlite, HOST_ID, paneKey)
    if (!row) {
      return undefined
    }
    return buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: row.session_id },
      cmdOverrides: {},
      sessionOptions: toSessionOptions(launchPreferencesFromRow(row)),
      platform: 'linux'
    })?.launchCommand
  }

  it('a pane launched with {model X, effort max} relaunches with both flags after a restart', () => {
    const sqlite = freshDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000e1'
    recordLaunch(sqlite, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-e1',
      launchGeneration: 'gen-1',
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch',
      prefs: { model: 'claude-opus-4-8', effort: 'max', source: 'launch' }
    })
    const command = relaunchCommandFor(sqlite, paneKey)
    expect(command).toContain("'--model' 'claude-opus-4-8'")
    expect(command).toContain("'--effort' 'max'")
  })

  it('a pane whose statusline later reported effort xhigh relaunches with xhigh (observed wins over the launch-time value)', () => {
    const sqlite = freshDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000e2'
    recordLaunch(sqlite, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-e2',
      launchGeneration: 'gen-1',
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch',
      prefs: { effort: 'max', source: 'launch' }
    })
    updateLaunchPrefsForPane(sqlite, HOST_ID, paneKey, { effort: 'xhigh', source: 'observed' })
    const command = relaunchCommandFor(sqlite, paneKey)
    expect(command).toContain("'--effort' 'xhigh'")
    expect(command).not.toContain("'max'")
  })

  it('launch ultracode + an observed xhigh echo still relaunches with ultracode (DEC-9)', () => {
    const sqlite = freshDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000e3'
    recordLaunch(sqlite, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-e3',
      launchGeneration: 'gen-1',
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch',
      prefs: { effort: 'ultracode', source: 'launch' }
    })
    updateLaunchPrefsForPane(sqlite, HOST_ID, paneKey, { effort: 'xhigh', source: 'observed' })
    const command = relaunchCommandFor(sqlite, paneKey)
    expect(command).toContain("'--effort' 'ultracode'")
    expect(command).not.toContain('xhigh')
  })

  it('a pane with no stored prefs relaunches with a byte-identical command (no flags)', () => {
    const sqlite = freshDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000e4'
    recordLaunch(sqlite, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-e4',
      launchGeneration: 'gen-1',
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const command = relaunchCommandFor(sqlite, paneKey)
    expect(command).toBe(`claude '--resume' 'sess-e4'`)
  })
})
