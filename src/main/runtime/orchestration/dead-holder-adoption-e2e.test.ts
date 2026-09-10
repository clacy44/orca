// S10-21d b3c (D-R163 M3 negatives 1/2/6): the dead-holder adoption rail
// (`requestChairRestore` -> `resolveHolderAdoption` -> the HOST_RESUME/`host_restore` admission
// arm), driven truly end to end against a REAL `OrcaRuntimeService` + a real (stubbed-provider)
// `createTerminal` — same harness shape chairs-restore-e2e.test.ts already proved sound for the
// plain (no-holder) restore, extended here to a holder that DEAD-HOLDER-ADOPTION's own DEC-3
// conjuncts must actually resolve as dead (never a mocked verdict at the `resolveHolderAdoption`
// unit level — that predicate already has its own pure-function tests in
// dead-holder-adoption.test.ts; this file proves the WIRING: identity -> inventory ->
// `resolveIncumbentDeath` -> the write -> the audit trail, all against one real DB).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { _resetRestoreSweepLockForTest } from '../restore-sweep-lock'
import type { ControllerInventory } from './agent-process-identity'
import { checkHostResumeHolderUnmoved } from '../../ipc/agent-launch-admission-host-resume'
import { LaunchAdmissionRefusedError } from '../../ipc/agent-launch-admission-errors'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const HOST_ID = 'local'
const HOLDER_GEN = 'gen-holder-prior'
const SESSION_ID = 'sess-dead-holder'

function stubLaunchScope(runtime: OrcaRuntimeService): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
      id: string
      path: string
      connectionId: string | null
      repo: null
      folderWorkspace: null
    }>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

// [DEVIATION, see RETURN] Same fake `db.recordLaunch`-performing pty controller
// chairs-restore-e2e.test.ts uses, for the same reason: the real write happens over an IPC hop
// (pty.ts's `launchAdmissionBundle`) unreachable from a bare test double.
function installRecordingPtyController(runtime: OrcaRuntimeService, db: OrchestrationDb): void {
  runtime.setPtyController({
    spawn: async (opts) => {
      const id = randomUUID()
      const admission = (opts as { launchAdmission?: { kind: string } }).launchAdmission
      if (admission && admission.kind === 'host-resume') {
        const hostResume = admission as unknown as {
          sessionId: string
          predecessorPaneKey: string | null
          executionHostId: string
          launchGeneration: string
          evidence?: 'sweep_record' | 'host_restore'
        }
        const { tabId, leafId } = opts as { tabId: string; leafId: string }
        db.recordLaunch({
          hostId: runtime.getOrchestrationCompatibilityHostId(),
          paneKey: `${tabId}:${leafId}`,
          agentType: 'claude',
          sessionId: hostResume.sessionId,
          launchGeneration: hostResume.launchGeneration,
          executionHostId: hostResume.executionHostId,
          evidence: hostResume.evidence ?? 'sweep_record',
          ...(hostResume.predecessorPaneKey
            ? { supersedePaneKey: hostResume.predecessorPaneKey }
            : {})
        })
      }
      return { id, isReattach: false }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
}

function makeRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    }),
    getWorkspaceSession: () => ({ tabsByWorktree: {} }),
    getAllWorktreeMeta: () => ({}),
    getRepos: () => []
  } as never)
}

describe('D-R163 M3 negatives 1/2/6: dead-holder adoption, wired end to end', () => {
  let db: OrchestrationDb
  let originalHome: string | undefined
  let tempHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
  })

  afterEach(async () => {
    db?.close()
    _resetRestoreSweepLockForTest()
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true })
      tempHome = undefined
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    }
  })

  /** Seeds a registered holder pane with a launch row under `HOLDER_GEN` and a real-shaped
   * process_incarnation, plus a resumable on-disk transcript for `SESSION_ID` — the fixture
   * both negatives 1/2/6 (dead) and negative 2 (live) share; only the inventory each installs
   * afterward decides `agentAlive`'s verdict. */
  async function seedHolder(
    holderPtyId: string,
    holderIncarnationId: string
  ): Promise<{ holderPaneKey: string }> {
    tempHome = await mkdtemp(join(tmpdir(), 'orca-dead-holder-e2e-'))
    process.env.HOME = tempHome
    expect(homedir()).toBe(tempHome)
    const projectDir = join(tempHome, '.claude', 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
    )
    const holderPaneKey = `tab-old:${randomUUID()}`
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-dead',
      role: null,
      hostId: HOST_ID,
      paneKey: holderPaneKey,
      terminalHandle: null,
      processIncarnation: `${holderPtyId}:${holderIncarnationId}`,
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
    const launched = db.recordLaunch({
      hostId: HOST_ID,
      paneKey: holderPaneKey,
      agentType: 'claude',
      sessionId: SESSION_ID,
      launchGeneration: HOLDER_GEN,
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    return { holderPaneKey }
  }

  function rawDb(): {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown
      all: (...args: unknown[]) => unknown[]
    }
  } {
    return (db as unknown as { db: ReturnType<typeof rawDb> }).db
  }

  it('negative 1: dead holder, all conjuncts satisfied -> one host_restore row, supersede, holder row intact, both audit rows present', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    installRecordingPtyController(runtime, db)

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const { holderPaneKey } = await seedHolder(holderPtyId, holderIncarnationId)
    const holderAgentIdBefore = db.getAgentByPaneKey(HOST_ID, holderPaneKey)?.id
    expect(holderAgentIdBefore).toBeDefined()

    // Identity present, but ABSENT from this (non-null) round -> agentAlive() = 'dead' ->
    // decideEarlyRows 'proceed' status 'dead' -> collectSweepEvidence attaches agentIdentity
    // dead -> resolveIncumbentDeath signal 'IDENTITY'.
    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('unreachable')
    }
    expect(result.holderPaneKey).toBe(holderPaneKey)
    expect(result.adoptionSignal).toBe('IDENTITY')
    const newPaneKey = result.paneKey

    // Exactly one launch row for the new pane, evidence host_restore, same session id.
    const newRow = db.newestLaunchForPane(HOST_ID, newPaneKey)
    expect(newRow?.session_id).toBe(SESSION_ID)
    expect(newRow?.evidence).toBe('host_restore')
    const newPaneRowCount = rawDb()
      .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?')
      .get(newPaneKey) as { n: number }
    expect(newPaneRowCount.n).toBe(1)

    // supersedePaneKey did its job: the holder's current_sessions row is GONE.
    expect(
      rawDb()
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get(HOST_ID, holderPaneKey)
    ).toBeUndefined()
    // The session now names the new pane as its sole current holder.
    expect(
      rawDb()
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, SESSION_ID)
    ).toEqual({ pane_key: newPaneKey })

    // The holder's OWN launch row is untouched (supersede only ever moves current_sessions).
    const holderRow = rawDb()
      .prepare(
        'SELECT session_id, evidence, launch_generation FROM agent_launch_sessions WHERE pane_key = ?'
      )
      .get(holderPaneKey) as { session_id: string; evidence: string; launch_generation: string }
    expect(holderRow).toEqual({
      session_id: SESSION_ID,
      evidence: 'host_launch',
      launch_generation: HOLDER_GEN
    })

    // Both audit rows: session_adopted names the new pane, the death signal, the holder generation.
    const adoptedAudit = rawDb()
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'session_adopted' AND actor_pane_key = ?`)
      .get(newPaneKey) as { outcome: string; reason_code: string } | undefined
    expect(adoptedAudit?.outcome).toBe('adopted')
    expect(adoptedAudit?.reason_code).toContain('signal=IDENTITY')
    expect(adoptedAudit?.reason_code).toContain(`holder=${holderPaneKey}`)
    expect(adoptedAudit?.reason_code).toContain(`holder_generation=${HOLDER_GEN}`)

    const supersededAudit = rawDb()
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'superseded' AND actor_pane_key = ?`)
      .get(holderPaneKey) as { agent_id: string | null; outcome: string } | undefined
    expect(supersededAudit?.outcome).toBe('superseded')
    expect(supersededAudit?.agent_id).toBe(holderAgentIdBefore)
  })

  it('negative 2: a LIVE holder is refused restore_target_live_elsewhere, no write of any kind', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    const spawnSpy = vi.fn()
    runtime.setPtyController({
      spawn: spawnSpy,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const { holderPaneKey } = await seedHolder(holderPtyId, holderIncarnationId)

    // The round POSITIVELY identifies the holder's own pty:incarnation -> agentAlive() = 'alive'
    // -> decideEarlyRows 'skipped_daemon_survived' -> incumbent {dead:false, reason:'live'}.
    const liveInventory: ControllerInventory = {
      allLivePtyIds: new Set([holderPtyId]),
      terminalIdentityByPtyId: new Map([
        [holderPtyId, { handle: 'h', incarnationId: holderIncarnationId }]
      ])
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(liveInventory)

    const auditCountBefore = (
      rawDb().prepare('SELECT COUNT(*) as n FROM agent_audit').get() as { n: number }
    ).n
    const launchCountBefore = (
      rawDb().prepare('SELECT COUNT(*) as n FROM agent_launch_sessions').get() as { n: number }
    ).n

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    expect(result).toEqual({
      ok: false,
      reason: 'restore_target_live_elsewhere',
      holderPaneKey
    })
    expect(spawnSpy).not.toHaveBeenCalled()
    // No launch row, no current_sessions change, no audit row of any kind.
    expect(
      (rawDb().prepare('SELECT COUNT(*) as n FROM agent_launch_sessions').get() as { n: number }).n
    ).toBe(launchCountBefore)
    expect(
      (rawDb().prepare('SELECT COUNT(*) as n FROM agent_audit').get() as { n: number }).n
    ).toBe(auditCountBefore)
    expect(
      rawDb()
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, SESSION_ID)
    ).toEqual({ pane_key: holderPaneKey })
  })

  it('negative 6: the 6th adoption for one holder within an hour is refused by the rate clamp', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    installRecordingPtyController(runtime, db)

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const { holderPaneKey } = await seedHolder(holderPtyId, holderIncarnationId)
    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)

    // Pre-consume the holder's own rate budget (5 per rolling hour) directly against the same
    // clamp `requestChairRestore` itself bumps — the 6th call below must be the one that trips it.
    for (let i = 0; i < 5; i += 1) {
      const bump = db.checkAndBumpRate({
        subjectKey: holderPaneKey,
        verb: 'session_adopt',
        windowMs: 3_600_000,
        limit: 5
      })
      expect(bump.allowed).toBe(true)
    }

    const launchCountBefore = (
      rawDb().prepare('SELECT COUNT(*) as n FROM agent_launch_sessions').get() as { n: number }
    ).n

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    expect(result).toEqual({ ok: false, reason: 'adoption_rate_limited' })
    // Refused before minting a ticket or writing a row — no new launch row anywhere.
    expect(
      (rawDb().prepare('SELECT COUNT(*) as n FROM agent_launch_sessions').get() as { n: number }).n
    ).toBe(launchCountBefore)
    expect(
      rawDb()
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, SESSION_ID)
    ).toEqual({ pane_key: holderPaneKey })
  })

  it('[G1-10o B6/C38 fix, D-R170 M12] register-failed-after-supersede writes an audit row naming the holder AND the specific register failure', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    installRecordingPtyController(runtime, db)

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const { holderPaneKey } = await seedHolder(holderPtyId, holderIncarnationId)
    const holderAgentIdBefore = db.getAgentByPaneKey(HOST_ID, holderPaneKey)?.id
    expect(holderAgentIdBefore).toBeDefined()

    // Quarantine the holder's identity: registerAgentForPane's name-collision guard locks the
    // name regardless of pane liveness (agent-directory.ts:215-226), so the eventual register
    // for the new pane returns name_taken even though the holder pane itself is dead.
    db.setAgentQuarantine({ id: holderAgentIdBefore!, quarantined: true, reasonCode: 'test' })

    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)
    const noticeSpy = vi.spyOn(runtime, 'writeHostNoticeToPane')

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    // [D-R170 M13] The "Session adopted" pane notice must never fire on the register-failed
    // exit — a refused restore must not print a success banner into the pane it refused.
    expect(noticeSpy).not.toHaveBeenCalled()

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('unreachable')
    }
    expect(result.reason).toContain('register_failed')
    expect(result.reason).toContain('name_taken')

    // The supersede already committed (destructive act happened inside ensureAgentSession before
    // registration was attempted) — the session now names a pane with no registered agent.
    const sessionRow = rawDb()
      .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
      .get(HOST_ID, SESSION_ID) as { pane_key: string } | undefined
    expect(sessionRow?.pane_key).toBeDefined()
    expect(sessionRow?.pane_key).not.toBe(holderPaneKey)

    // [D-R170 M12] A session_adopted audit row still exists, and (unlike before) its
    // reason_code names the specific failure (register_failed:name_taken) rather than only the
    // holder — distinguishing it from restore_pane_key_missing and from the other register
    // failure reasons (directory_full, invalid_name).
    const adoptedAudit = rawDb()
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'session_adopted' AND actor_pane_key = ?`)
      .get(sessionRow?.pane_key) as
      | { agent_id: string | null; outcome: string; reason_code: string }
      | undefined
    expect(adoptedAudit?.agent_id).toBeNull()
    expect(adoptedAudit?.outcome).toBe('adopted_unregistered')
    expect(adoptedAudit?.reason_code).toContain(`holder=${holderPaneKey}`)
    expect(adoptedAudit?.reason_code).toContain('exit=register_failed:name_taken')

    // The superseded audit row still names the holder's identity.
    const supersededAudit = rawDb()
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'superseded' AND actor_pane_key = ?`)
      .get(holderPaneKey) as { agent_id: string | null; outcome: string } | undefined
    expect(supersededAudit?.outcome).toBe('superseded')
    expect(supersededAudit?.agent_id).toBe(holderAgentIdBefore)
  })

  it('[D-R172 MEDIUM-1 fix] ensureAgentSession throwing an error that is NOT a launch-admission refusal is treated conservatively: a superseded row IS written even though the holder is untouched', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    installRecordingPtyController(runtime, db)

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const { holderPaneKey } = await seedHolder(holderPtyId, holderIncarnationId)
    const holderAgentIdBefore = db.getAgentByPaneKey(HOST_ID, holderPaneKey)?.id
    expect(holderAgentIdBefore).toBeDefined()

    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)
    // A generic, unclassified throw — NOT a `LaunchAdmissionRefusedError` — from somewhere in
    // ensureAgentSession. [D-R172 MEDIUM-1] the chair-restore catch can only distinguish
    // `LaunchAdmissionRefusedError` (always pre-commit, agent-launch-admission.ts:144-147) from
    // everything else; an unrecognized error class defaults to the conservative assumption
    // (binding NOT intact) even on a path, like this one, where the throw in fact never reached
    // the supersede DELETE. This is the named, accepted trade-off of the interim fix, not a bug:
    // see the real-refusal case below for the one this fix DOES get right.
    vi.spyOn(runtime, 'ensureAgentSession').mockRejectedValue(new Error('boom'))

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('unreachable')
    }
    expect(result.reason).toContain('ensure_agent_session_failed')
    expect(result.reason).toContain('boom')

    // The holder's binding is untouched: still the session's sole current holder.
    expect(
      rawDb()
        .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
        .get(HOST_ID, SESSION_ID)
    ).toEqual({ pane_key: holderPaneKey })

    // [D-R171 M12] The adoption-attempt row still names the specific underlying error.
    const adoptedAudit = rawDb()
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'session_adopted' AND actor_pane_key IS NULL`
      )
      .get() as { outcome: string; reason_code: string } | undefined
    expect(adoptedAudit?.outcome).toBe('adopted_ensure_failed')
    expect(adoptedAudit?.reason_code).toContain('exit=ensure_agent_session_failed:boom')

    // [D-R172 MEDIUM-1] A superseded row IS written for an unrecognized error class, per the
    // conservative default above — a known imprecision of the interim fix.
    const supersededAudit = rawDb()
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'superseded' AND actor_pane_key = ?`)
      .get(holderPaneKey) as { outcome: string } | undefined
    expect(supersededAudit?.outcome).toBe('superseded')
  })

  it("[D-R172 MEDIUM-1 fix] a REAL restore_holder_moved refusal (holder moves between the predicate and the admission) writes the adoption-attempt row but NO 'superseded' row against the holder", async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    installRecordingPtyController(runtime, db)

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const { holderPaneKey } = await seedHolder(holderPtyId, holderIncarnationId)
    const holderAgentIdBefore = db.getAgentByPaneKey(HOST_ID, holderPaneKey)?.id
    expect(holderAgentIdBefore).toBeDefined()

    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)

    const rawWrite = rawDb() as unknown as {
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
    }
    // Simulate the holder moving between `requestChairRestore`'s own predicate read
    // (`chair-restore.ts:92`, already resolved to `holderPaneKey` above) and the admission's
    // in-lock re-check: only NOW — at the point `ensureAgentSession` is entered, standing in for
    // that re-check per the file-level DEVIATION note (the fake pty controller bypasses the real
    // IPC-hop admission stack) — does the session's `current_sessions` row move to a DIFFERENT
    // pane than the one the adoption decision was made against.
    vi.spyOn(runtime, 'ensureAgentSession').mockImplementation(async () => {
      const movedToPaneKey = `tab-new:${randomUUID()}`
      rawWrite
        .prepare('UPDATE current_sessions SET pane_key = ? WHERE host_id = ? AND session_id = ?')
        .run(movedToPaneKey, HOST_ID, SESSION_ID)

      // Drive the REAL predicate `checkHostResumeHolderUnmoved` (agent-launch-admission-host-
      // resume.ts) against this exact db state, proving it genuinely yields
      // `restore_holder_moved` for this fixture rather than assuming it.
      const realRefusal = checkHostResumeHolderUnmoved(db, HOST_ID, 'gen-new', SESSION_ID, {
        evidence: 'host_restore',
        predecessorPaneKey: holderPaneKey,
        executionHostId: HOST_ID,
        launchGeneration: 'gen-new'
      })
      expect(realRefusal).toBe('restore_holder_moved')
      if (!realRefusal) {
        throw new Error('unreachable: asserted above')
      }

      // The real admission arm's `refuse()` (agent-launch-admission.ts:144-147) throws exactly
      // this class for exactly this reason code.
      throw new LaunchAdmissionRefusedError(realRefusal)
    })

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('unreachable')
    }
    expect(result.reason).toContain('ensure_agent_session_failed')
    expect(result.reason).toContain('restore_holder_moved')

    // The adoption-attempt row IS written.
    const adoptedAudit = rawDb()
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'session_adopted' AND actor_pane_key IS NULL`
      )
      .get() as { outcome: string; reason_code: string } | undefined
    expect(adoptedAudit?.outcome).toBe('adopted_ensure_failed')
    // [D-R172 MEDIUM-2] `reason_code` is capped at 200 chars, which truncates this particular
    // message before 'restore_holder_moved' — asserted on `result.reason` above instead, which
    // carries the untruncated message.
    expect(adoptedAudit?.reason_code).toContain('exit=ensure_agent_session_failed')

    // No 'superseded' row against the holder: `LaunchAdmissionRefusedError` is recognized as
    // pre-commit, so `holderBindingIntact` is true and the superseded write is skipped.
    const supersededAudit = rawDb()
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'superseded' AND actor_pane_key = ?`)
      .get(holderPaneKey)
    expect(supersededAudit).toBeUndefined()
  })

  it('[D-R172 MEDIUM-2 fix] a multi-KB ensureAgentSession error message yields a reason_code capped at 200 chars', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime()
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    installRecordingPtyController(runtime, db)

    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    await seedHolder(holderPtyId, holderIncarnationId)

    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)
    // A pathological, environment-controlled error message (5 KB) — `agent_audit.reason_code`
    // is append-only (db.ts's ABORT triggers on UPDATE/DELETE), so this must not mint an
    // unbounded, unremovable row.
    const hugeMessage = 'x'.repeat(5 * 1024)
    vi.spyOn(runtime, 'ensureAgentSession').mockRejectedValue(new Error(hugeMessage))

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId: SESSION_ID,
      displayName: 'chair-dead'
    })

    expect(result.ok).toBe(false)

    const adoptedAudit = rawDb()
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'session_adopted' AND actor_pane_key IS NULL`
      )
      .get() as { reason_code: string } | undefined
    expect(adoptedAudit?.reason_code).toBeDefined()
    expect(adoptedAudit!.reason_code.length).toBeLessThanOrEqual(200)
  })
})
