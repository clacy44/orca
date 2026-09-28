// S10-21f b2-10q C2b: the caller_resume collision arm's reason-code split — a `resume_target_
// owned_by_another_pane` collision now tells a live holder pane (connected pty) apart from
// `resume_target_owned_by_pane_without_live_pty` (no connected pty), via a new SYNC
// ctx.findConnectedPtyForPane. No behaviour change: both cases still return `unrecorded`, spawn
// still proceeds. Split into its own file (MAX-LINES) — agent-launch-admission.test.ts already
// covers the live-holder case; this proves the dead-holder sibling only. [10z.5 R287, D-R241] The
// second case now proves the live-holder REFUSAL (claude in the holder's foreground).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type * as NodeCrypto from 'node:crypto'

const MINTED_A = '11111111-1111-4111-8111-111111111111'
const VICTIM_SESSION_ID = '44444444-4444-4444-8444-444444444444'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn(() => MINTED_A) }
})

vi.mock('../startup/resolve-resume-transcript', () => ({
  resolveResumeTranscript: vi.fn(async () => ({ path: '/fake/transcript.jsonl', hasTurn: true }))
}))

const CALLER: LaunchAdmission = { kind: 'caller' }
const HOST_ID = 'local'

describe('S10-21f b2-10q C2b: resume_target_owned_by_pane_without_live_pty', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function freshDb(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }

  function rawDb(db: OrchestrationDb): Database.Database {
    return (db as unknown as { db: Database.Database }).db
  }

  function ctx(overrides: Partial<Parameters<typeof admitAgentLaunch>[3]> = {}) {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {},
      findConnectedPtyForPane: () => false,
      callerResume: null,
      ...overrides
    }
  }

  function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', ...overrides }
  }

  it('the SAME collision against a victim pane with NO connected pty is UNRECORDED with the dead-holder reason code, same no-supersede behaviour', async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-victim',
      agentType: 'claude',
      sessionId: VICTIM_SESSION_ID,
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${VICTIM_SESSION_ID}` }),
      CALLER,
      ctx({
        notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }),
        findConnectedPtyForPane: () => false
      })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${VICTIM_SESSION_ID}`)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-victim')?.session_id).toBe(VICTIM_SESSION_ID)
    expect(notices).toEqual([
      {
        paneKey: 'tab1:leaf-a',
        verb: 'launch_unrecorded',
        reasonCode: 'resume_target_owned_by_pane_without_live_pty'
      }
    ])
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.outcome).toBe('admitted')
    expect(auditRow.reason_code).toBe('resume_target_owned_by_pane_without_live_pty')
  })
  it("10z.5 R287, D-R241 (flips S10-21c B3c's admit): a caller's `claude --resume X` naming a pane whose CLAUDE runs in the foreground is REFUSED (resume_target_owned_by_another_pane, via claude_foreground) — audited as launch_refused, nothing recorded for the claimant, no notice, the victim untouched", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-victim',
      agentType: 'claude',
      sessionId: VICTIM_SESSION_ID,
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    // [D-R241] The victim is live only through its claude foreground: the delivery gate's confirm.
    const callerResume = {
      findConnectedPtyForPane: (paneKey: string) =>
        paneKey === 'tab1:leaf-victim' ? { ptyId: 'pty-victim' } : undefined,
      getPersistedPtyIdForLeaf: () => undefined,
      confirmClaudeForegroundOnPane: async (paneKey: string) => paneKey === 'tab1:leaf-victim',
      liveReportPanesForSession: () => [],
      takeControllerInventoryForSweep: async () => null,
      terminalHandleForPane: () => null,
      manifestChairForSession: async () => null
    }
    const attempt = admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${VICTIM_SESSION_ID}` }),
      CALLER,
      ctx({
        notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }),
        findConnectedPtyForPane: (paneKey) => paneKey === 'tab1:leaf-victim',
        callerResume
      })
    )
    await expect(attempt).rejects.toMatchObject({
      code: 'resume_target_owned_by_another_pane',
      message: `Claude session ${VICTIM_SESSION_ID} is already running in pane tab1:leaf-victim; Orca refused to start a second process on the same conversation.`
    })
    // Nothing recorded for the claimant pane.
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    // The victim keeps both its launch row and its current_sessions row.
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-victim')?.session_id).toBe(VICTIM_SESSION_ID)
    const victimCurrent = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-victim') as { session_id: string }
    expect(victimCurrent.session_id).toBe(VICTIM_SESSION_ID)
    // No pane exists for the refused launch, so no notice.
    expect(notices).toEqual([])
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.outcome).toBe('refused')
    expect(auditRow.reason_code).toBe(
      'resume_target_owned_by_another_pane holder=tab1:leaf-victim via=claude_foreground'
    )
  })
})
