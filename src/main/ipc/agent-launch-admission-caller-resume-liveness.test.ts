// 10z.5 R287 (chair ruling D-R241): the caller_resume arm refuses a `claude --resume X` when X's
// holder runs claude in its foreground, or a hook report of X stands under DEC-3. Rules 1-2 only;
// the project-scope write gate is agent-launch-admission-caller-resume-project-scope.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import type { ControllerInventory } from '../runtime/orchestration/agent-process-identity'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import type { CallerResumeLivenessDeps } from './agent-launch-admission-caller-resume'
import { resolveResumeTranscript } from '../startup/resolve-resume-transcript'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

vi.mock('../startup/resolve-resume-transcript', () => ({
  resolveResumeTranscript: vi.fn(async () => ({ path: '/fake/transcript.jsonl', hasTurn: true }))
}))

const X = '44444444-4444-4444-8444-444444444444'
const HOLDER = 'tab1:leaf-victim'
const CLAIMANT = 'tab1:leaf-a'
const OTHER = 'tab2:66666666-6666-4666-8666-666666666666'
const HOST_ID = 'local'
const CALLER: LaunchAdmission = { kind: 'caller' }
const MESSAGE_START = `Claude session ${X} is already running in pane ${HOLDER}`
const TAIL = 'Orca refused to start a second process on the same conversation.'
const ROUND = (ptyIds: string[]): ControllerInventory => ({
  allLivePtyIds: new Set(ptyIds),
  terminalIdentityByPtyId: new Map()
})

type Deps = {
  [K in keyof CallerResumeLivenessDeps]: ReturnType<typeof vi.fn>
} & CallerResumeLivenessDeps

describe('10z.5 R287: caller-resume liveness refusal', () => {
  let orchestrationDb: OrchestrationDb | undefined
  afterEach(() => {
    orchestrationDb?.close()
    vi.mocked(resolveResumeTranscript)
      .mockReset()
      .mockImplementation(async () => ({ path: '/fake/transcript.jsonl', hasTurn: true }))
  })

  function freshDb(withHolder = true): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    if (withHolder) {
      orchestrationDb.recordLaunch({
        hostId: HOST_ID,
        paneKey: HOLDER,
        agentType: 'claude',
        sessionId: X,
        launchGeneration: 'gen-0',
        executionHostId: HOST_ID,
        evidence: 'host_launch'
      })
    }
    return orchestrationDb
  }
  function rawDb(db: OrchestrationDb): Database.Database {
    return (db as unknown as { db: Database.Database }).db
  }
  function lastAudit(db: OrchestrationDb) {
    return rawDb(db).prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`).get() as {
      verb: string
      outcome: string
      reason_code: string
      actor_pane_key: string
    }
  }
  function deps(overrides: Partial<CallerResumeLivenessDeps> = {}): Deps {
    return {
      findConnectedPtyForPane: vi.fn((paneKey: string) =>
        paneKey === HOLDER ? { ptyId: 'pty-holder' } : undefined
      ),
      getPersistedPtyIdForLeaf: vi.fn(() => undefined),
      confirmClaudeForegroundOnPane: vi.fn(async () => false),
      liveReportPanesForSession: vi.fn(() => []),
      takeControllerInventoryForSweep: vi.fn(async () => null),
      terminalHandleForPane: vi.fn(() => null),
      manifestChairForSession: vi.fn(async () => null),
      ...overrides
    } as unknown as Deps
  }
  function admit(
    db: OrchestrationDb,
    callerResume: CallerResumeLivenessDeps | null,
    notices: string[] = [],
    admission: LaunchAdmission = CALLER,
    command = `claude --resume ${X}`
  ) {
    const spawn: PtySpawnOptions = {
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      paneKey: CLAIMANT,
      command
    }
    return admitAgentLaunch(() => db, spawn, admission, {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: (_pane, _verb, reason) => notices.push(reason),
      contestedLineage: () => {},
      findConnectedPtyForPane: (paneKey) =>
        callerResume
          ? callerResume.findConnectedPtyForPane(paneKey) !== undefined
          : paneKey === HOLDER,
      callerResume
    })
  }
  function expectHolderIntact(db: OrchestrationDb) {
    expect(db.newestLaunchForPane(HOST_ID, CLAIMANT)).toBeUndefined()
    expect(db.newestLaunchForPane(HOST_ID, HOLDER)?.session_id).toBe(X)
    expect(db.paneHoldingSession(HOST_ID, X)).toBe(HOLDER)
  }

  it('a claude-foreground holder refuses with the exact message, audit row naming the holder, nothing recorded, no notice', async () => {
    const db = freshDb()
    const d = deps({ confirmClaudeForegroundOnPane: vi.fn(async () => true) })
    const notices: string[] = []
    const error = await admit(db, d, notices).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'resume_target_owned_by_another_pane',
      reasonCode: 'resume_target_owned_by_another_pane',
      message: `${MESSAGE_START}; ${TAIL}`,
      data: {
        sessionId: X,
        holderPaneKey: HOLDER,
        holderTerminal: null,
        via: 'claude_foreground',
        chair: null,
        nextSteps: [
          `Use pane ${HOLDER}, or close it first.`,
          'After that pane is closed, run this resume again.'
        ]
      }
    })
    expect(d.confirmClaudeForegroundOnPane).toHaveBeenCalledWith(HOLDER)
    expect(lastAudit(db)).toMatchObject({
      verb: 'launch_refused',
      outcome: 'refused',
      actor_pane_key: CLAIMANT,
      reason_code: `resume_target_owned_by_another_pane holder=${HOLDER} via=claude_foreground`
    })
    expect(notices).toEqual([])
    expectHolderIntact(db)
  })

  it('a resolved handle and a manifest chair produce the handle and chair-restore next steps', async () => {
    const db = freshDb()
    const d = deps({
      confirmClaudeForegroundOnPane: vi.fn(async () => true),
      terminalHandleForPane: vi.fn(() => 'term_abc'),
      manifestChairForSession: vi.fn(async () => ({ name: 'vps-oversight' }))
    })
    await expect(admit(db, d)).rejects.toMatchObject({
      message: `${MESSAGE_START} (term_abc); ${TAIL}`,
      data: {
        holderTerminal: 'term_abc',
        chair: 'vps-oversight',
        nextSteps: [
          'Use that pane, or close it first: orca terminal close --terminal term_abc',
          'After that pane is closed, recover the chair with `orca chairs restore --only vps-oversight` — run it twice at least 10 s apart.'
        ]
      }
    })
  })

  it.each([
    ['a shell foreground', vi.fn(async () => false)],
    [
      'an unknown or failing read',
      vi.fn(async () => {
        throw new Error('no confirm')
      })
    ]
  ])(
    '%s on a connected holder is not live: unrecorded without_live_agent, spawn proceeds',
    async (_n, confirm) => {
      const db = freshDb()
      const notices: string[] = []
      const admitted = await admit(db, deps({ confirmClaudeForegroundOnPane: confirm }), notices)
      expect(admitted.spawnOptions.command).toBe(`claude --resume ${X}`)
      expect(lastAudit(db)).toMatchObject({
        verb: 'launch_unrecorded',
        outcome: 'admitted',
        reason_code: 'resume_target_owned_by_pane_without_live_agent'
      })
      expect(notices).toEqual(['resume_target_owned_by_pane_without_live_agent'])
      expectHolderIntact(db)
    }
  )

  it("the unrecorded audit row carries X's attributed identity in agent_id", async () => {
    const db = freshDb()
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-victim',
      role: null,
      hostId: HOST_ID,
      paneKey: HOLDER,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: HOST_ID
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    await admit(db, deps())
    const row = rawDb(db).prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`).get() as {
      agent_id: string | null
    }
    expect(row.agent_id).toBe(created.agent.id)
  })

  it('a holder with no connected pty keeps without_live_pty and never reads the foreground', async () => {
    const db = freshDb()
    const d = deps({ findConnectedPtyForPane: vi.fn(() => undefined) })
    await admit(db, d)
    expect(d.confirmClaudeForegroundOnPane).not.toHaveBeenCalled()
    expect(lastAudit(db).reason_code).toBe('resume_target_owned_by_pane_without_live_pty')
  })

  describe('rule 2: a hook report elsewhere (DEC-3, verbatim)', () => {
    const report = { paneKey: OTHER, executionHostId: HOST_ID }

    it('a standing report (null inventory round) refuses via hook_report, naming the reporter', async () => {
      const db = freshDb()
      const d = deps({ liveReportPanesForSession: vi.fn(() => [report]) })
      await expect(admit(db, d)).rejects.toMatchObject({
        message: `Claude session ${X} is still reported live by pane ${OTHER}; ${TAIL}`,
        data: { via: 'hook_report', holderPaneKey: OTHER }
      })
      expect(d.liveReportPanesForSession).toHaveBeenCalledWith(X, { excludePaneKey: HOLDER })
      expect(lastAudit(db).reason_code).toBe(
        `resume_target_owned_by_another_pane holder=${OTHER} via=hook_report`
      )
      expectHolderIntact(db)
    })

    it('a report whose pty is present in the round stands', async () => {
      const db = freshDb()
      const d = deps({
        liveReportPanesForSession: vi.fn(() => [report]),
        takeControllerInventoryForSweep: vi.fn(async () => ROUND(['pty-other'])),
        findConnectedPtyForPane: vi.fn((p: string) =>
          p === OTHER ? { ptyId: 'pty-other' } : undefined
        )
      })
      await expect(admit(db, d)).rejects.toMatchObject({ data: { via: 'hook_report' } })
    })

    it('a report whose pty is absent over a non-null round is discounted: admitted unrecorded', async () => {
      const db = freshDb()
      const d = deps({
        liveReportPanesForSession: vi.fn(() => [report]),
        takeControllerInventoryForSweep: vi.fn(async () => ROUND([])),
        getPersistedPtyIdForLeaf: vi.fn(() => 'pty-gone'),
        findConnectedPtyForPane: vi.fn(() => undefined)
      })
      const admitted = await admit(db, d)
      expect(admitted.spawnOptions.command).toBe(`claude --resume ${X}`)
      expect(d.takeControllerInventoryForSweep).toHaveBeenCalledTimes(1)
      expect(lastAudit(db).reason_code).toBe('resume_target_owned_by_pane_without_live_pty')
    })

    it("the holder's and the claimant's own reports never count; the inventory is not taken for an empty list", async () => {
      const db = freshDb()
      const all = [
        { paneKey: HOLDER, executionHostId: HOST_ID },
        { paneKey: CLAIMANT, executionHostId: HOST_ID }
      ]
      const d = deps({
        liveReportPanesForSession: vi.fn((_s: string, o?: { excludePaneKey?: string }) =>
          all.filter((r) => r.paneKey !== o?.excludePaneKey)
        )
      })
      await admit(db, d)
      expect(d.takeControllerInventoryForSweep).not.toHaveBeenCalled()
      expect(lastAudit(db).verb).toBe('launch_unrecorded')
    })

    it('a null reporter list stands (DEC-3 default): refused, no inventory round', async () => {
      const db = freshDb()
      const d = deps({ liveReportPanesForSession: vi.fn(() => null) })
      await expect(admit(db, d)).rejects.toMatchObject({ data: { via: 'hook_report' } })
      expect(d.takeControllerInventoryForSweep).not.toHaveBeenCalled()
    })

    it('with no holder, a standing reporter still refuses', async () => {
      const db = freshDb(false)
      const d = deps({ liveReportPanesForSession: vi.fn(() => [report]) })
      await expect(admit(db, d)).rejects.toMatchObject({ data: { via: 'hook_report' } })
      expect(d.confirmClaudeForegroundOnPane).not.toHaveBeenCalled()
      expect(db.newestLaunchForPane(HOST_ID, CLAIMANT)).toBeUndefined()
    })
  })

  it('the refusal runs before the transcript preflight: a live holder with a failing preflight is refused', async () => {
    const db = freshDb()
    vi.mocked(resolveResumeTranscript).mockImplementation(async () => null)
    const d = deps({ confirmClaudeForegroundOnPane: vi.fn(async () => true) })
    await expect(admit(db, d)).rejects.toMatchObject({
      code: 'resume_target_owned_by_another_pane'
    })
    expect(resolveResumeTranscript).not.toHaveBeenCalled()
  })

  it("a null callerResume (unwired) skips rules 1-2: today's unrecorded behaviour", async () => {
    const db = freshDb()
    await admit(db, null)
    expect(lastAudit(db).reason_code).toBe('resume_target_owned_by_pane_without_live_agent')
  })

  it('SELF_RESUME never calls the deps (HOST_RESUME is pinned in agent-launch-admission-host-resume-adoption.test.ts, the fence-exempt file)', async () => {
    const db = freshDb()
    const d = deps({
      confirmClaudeForegroundOnPane: vi.fn(async () => true),
      liveReportPanesForSession: vi.fn(() => [{ paneKey: OTHER, executionHostId: HOST_ID }])
    })
    const own = '55555555-5555-4555-8555-555555555555'
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: CLAIMANT,
      agentType: 'claude',
      sessionId: own,
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    await admit(db, d, [], CALLER, `claude --resume ${own}`)
    for (const fn of Object.values(d)) {
      expect(fn).not.toHaveBeenCalled()
    }
  })
})
