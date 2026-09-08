// S10-21a C7b, T2: Layer 2 rebind end to end against a REAL `createTerminal` — the admission's
// HOST_RESUME row is written at spawn and `rebindRestoredPane` binds it, the mark is written.
// This is the fence D-R110 (η) found absent: every prior test drove either `rebindRestoredPane`
// in isolation or a deps-mocked `ensureAgentSession`, never the real path B1/B2/B3 actually
// broke. Mail-repoint counts are NOT asserted here (a fixture using `db.insertMessage` needs a
// seeded `runs` row this test does not set up) — `agent-restore-rebind.test.ts` already covers
// `pendingOnOldHandle` against `rebindRestoredPane` directly.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRestoreSweep, type RestoreSweepDeps } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const HOST_ID = 'local'
const EXEC_HOST_ID = 'local'
const PRIOR_GEN = 'gen-prior'

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

function buildDeps(runtime: OrcaRuntimeService): RestoreSweepDeps {
  return {
    getOrchestrationDb: () => runtime.getOrchestrationDb(),
    getOrchestrationCompatibilityHostId: () => runtime.getOrchestrationCompatibilityHostId(),
    getLaunchGenerationId: () => runtime.getLaunchGenerationId(),
    findConnectedLeafOccupant: (leafId, connectionId) =>
      runtime.findConnectedLeafOccupant(leafId, connectionId ?? null),
    findConnectedPtyForPane: (paneKey) => runtime.findConnectedPtyForPane(paneKey),
    isLeafInPersistedLayout: (tabId, leafId, hostId) =>
      runtime.isLeafInPersistedLayout(tabId, leafId, hostId ?? null),
    getPersistedPtyIdForLeaf: (tabId, leafId, hostId) =>
      runtime.getPersistedPtyIdForLeaf(tabId, leafId, hostId ?? null),
    ensureAgentSession: (request, caller, internal) =>
      runtime.ensureAgentSession(request, caller, internal),
    takeControllerInventoryForSweep: () => runtime.takeControllerInventoryForSweep(),
    getSelfResumeWatermark: () => runtime.getSelfResumeWatermark(),
    collectIncumbentEvidence: (paneKey, ptyId, now, preFetchedInventory) =>
      runtime.collectIncumbentEvidence(paneKey, ptyId, now, preFetchedInventory),
    getTerminalProcessIncarnation: (handle) => runtime.getTerminalProcessIncarnation(handle),
    // [S10-21c B2, design §2 S4/S8] Orthogonal to what T2 proves (the real spawn/admission path)
    // — permissive stand-ins, same reasoning as `collectIncumbentEvidence`'s override below.
    resolveResumeTranscript: async () => ({ path: 'stub-transcript.jsonl', hasTurn: true }),
    resolveTabWorktreeId: () => 'wt-1',
    mintRestoreTicket: (payload) => runtime.mintRestoreTicket(payload),
    notifyRebindDelivery: (agentId) => runtime.notifyRebindDelivery(agentId),
    writeHostNoticeToPane: () => {},
    // [S10-21c B6, design §2 S9] Real runtime method — no notifier installed in this fixture, so
    // the queue accumulates but nothing drains it; not what this file proves.
    recordRestoredPaneForDesktopMaterialization: (surface) =>
      runtime.recordRestoredPaneForDesktopMaterialization(surface)
  }
}

describe('S10-21a C7b, T2: Layer 2 rebind against a real createTerminal', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
    _resetRestoreSweepLockForTest()
  })

  it('mints a fresh pane, rebinds the registered agent onto it, writes the mark, one rebind audit row', async () => {
    db = new OrchestrationDb(':memory:')
    // `ensureAgentSession` requires `this.store` (throws `runtime_unavailable` otherwise,
    // BEFORE `createTerminal`'s own pty-controller check ever runs) — a minimal settings-only
    // stub is enough for the resume path this test drives.
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never)
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    const spawnedPtyId = randomUUID()
    runtime.setPtyController({
      spawn: async () => ({ id: spawnedPtyId, isReattach: false }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const predPaneKey = `tab-old:${randomUUID()}`
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-t2',
      role: null,
      hostId: HOST_ID,
      paneKey: predPaneKey,
      terminalHandle: 'term_old',
      processIncarnation: 'inc-old',
      worktreeId: 'wt-1',
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: HOST_ID
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const agentId = created.agent.id
    const launched = db.recordLaunch({
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-t2',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    // The incumbent-death SETTLE window (D3, REBIND_SETTLE_MS=10s) is orthogonal to what T2
    // proves (the real spawn/admission path B1/B2/B3 broke) and is already covered by
    // incumbent-death.test.ts / collect-incumbent-evidence.test.ts — overridden here to a
    // proven-dead verdict (D1) so this test does not need a real 10s wait to be deterministic.
    const deps = buildDeps(runtime)
    deps.collectIncumbentEvidence = async (paneKey) => ({
      paneKey,
      d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
      d2: { inventory: 'unknown' },
      d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
    })
    // [S10-21a C7i] the settings-only store stub above has no `getAllWorktreeMeta`/`getRepos` —
    // the real `takeControllerInventoryForSweep` needs both (via `getResolvedWorktreeMap`).
    // Overridden here, same reasoning as `collectIncumbentEvidence` above: orthogonal to what T2
    // proves, already covered by orca-runtime-take-controller-inventory-for-sweep.test.ts.
    // [S10-21a C7k, Ruling 34 Addendum 28, item 2 — SCENARIO_CORRECTION, forced deviation] was
    // `async () => null` — item 2 makes a null round defer EVERY candidate (row 2), regardless of
    // identity, which this fixture's own null round would now trigger unconditionally. An empty
    // but non-null round preserves T2's own stated intent (the round's content is orthogonal to
    // what T2 proves) while satisfying the new hard "null always defers" rule.
    deps.takeControllerInventoryForSweep = async () => ({
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    })
    const summary = await runRestoreSweep(deps)

    expect(summary.errors).toBe(0)
    expect(summary.layer2).toBe(1)
    const row = db.getAgentByIdIncludingTombstoned(agentId)
    expect(row?.pane_key).not.toBe(predPaneKey)
    expect(row?.pane_key).not.toBeNull()
    expect(db.getSweepRestoreMark(HOST_ID, predPaneKey)).toBe(true)
    const rawDb = (db as unknown as { db: Database.Database }).db
    const rebindAudit = rawDb
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all()
    expect(rebindAudit).toHaveLength(1)
  })

  // [S10-21a C7k, Ruling 34 Addendum 28, item 1] D-R118: the identity verdict must dominate the
  // REAL d1/d2/d3 evidence bundle `OrcaRuntimeService.collectIncumbentEvidence` assembles — not
  // a test-only override of it, which is why T2 above deliberately overrides
  // `collectIncumbentEvidence`/`takeControllerInventoryForSweep` and this test does not.
  it('same ptyId, different incarnation -> restore completes (layer1/layer2), one rebind audit, never refused incumbent_alive', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never)
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    const spawnedPtyId = randomUUID()
    runtime.setPtyController({
      spawn: async () => ({ id: spawnedPtyId, isReattach: false }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const predPaneKey = `tab-old:${randomUUID()}`
    const reusedPtyId = 'pty-reused-by-daemon'
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-t-identity',
      role: null,
      hostId: HOST_ID,
      paneKey: predPaneKey,
      terminalHandle: 'term_old',
      // The registered agent's OWN identity: this ptyId, an OLD incarnation. [S10-21c B-final
      // F1, SCENARIO_CORRECTION] UUID-shaped incarnation id — the new explicit shape check
      // (D-R159 finding 1) requires one; the test's own point (same ptyId, DIFFERENT
      // incarnation -> provably dead) is orthogonal to whether the id looks like a UUID.
      processIncarnation: `${reusedPtyId}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1`,
      worktreeId: 'wt-1',
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: HOST_ID
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const agentId = created.agent.id
    const launched = db.recordLaunch({
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-t-identity',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    const deps = buildDeps(runtime)
    // The REAL `collectIncumbentEvidence` — no override. Its own d1/d2/d3 read no proven exit,
    // no leaf-liveness signal, and (via the round below) the ptyId present — none of which, on
    // their own, are proof of death (D-R118's whole point: identity must dominate this).
    deps.takeControllerInventoryForSweep = async () => ({
      allLivePtyIds: new Set([reusedPtyId]),
      // The daemon relists the SAME ptyId under a NEW incarnation — provably not this agent.
      terminalIdentityByPtyId: new Map([
        [reusedPtyId, { handle: 'term_new', incarnationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2' }]
      ])
    })
    const summary = await runRestoreSweep(deps)

    expect(summary.errors).toBe(0)
    expect(summary.layer1 + summary.layer2).toBe(1)
    const row = db.getAgentByIdIncludingTombstoned(agentId)
    expect(row?.pane_key).not.toBeNull()
    const rawDb = (db as unknown as { db: Database.Database }).db
    const contestedAudit = rawDb
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'contested'`)
      .all()
    expect(contestedAudit).toHaveLength(0)
    const remintedAudit = rawDb
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all()
    expect(remintedAudit).toHaveLength(1)
  })

  // [S10-21c B6, design §2 S9; D-R153-b6 F3] Drives the real `materializeRestoredAgentPanes`
  // wiring the sweep-side test (restore-registered-agent-panes-s9-desktop-materialize.test.ts)
  // never exercises — `this.notifier` and `this.ptysById` are the runtime's own state, not deps.
  it('S10-21c B6, design §2 S9: materializeRestoredAgentPanes reveals the recorded surface exactly once; a second call issues none', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never)
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    const spawnedPtyId = randomUUID()
    runtime.setPtyController({
      spawn: async () => ({ id: spawnedPtyId, incarnationId: 'inc-s9', isReattach: false }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const predPaneKey = `tab-old:${randomUUID()}`
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-s9',
      role: null,
      hostId: HOST_ID,
      paneKey: predPaneKey,
      terminalHandle: 'term_old_s9',
      processIncarnation: 'inc-old-s9',
      worktreeId: 'wt-1',
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old_s9',
      originHostId: HOST_ID
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const launched = db.recordLaunch({
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-s9',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    const deps = buildDeps(runtime)
    deps.collectIncumbentEvidence = async (paneKey) => ({
      paneKey,
      d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
      d2: { inventory: 'unknown' },
      d3: { liveNow: false, firstObservedNotLiveAt: null, now: 0 }
    })
    deps.takeControllerInventoryForSweep = async () => ({
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    })
    const summary = await runRestoreSweep(deps)
    expect(summary.layer2).toBe(1)

    // Echoes back whatever identity the drain asked for — this proves the WIRING (the recorded
    // surface reaches the real reveal call with a matching identity), not the mismatch-refusal
    // logic already covered by restore-sweep-desktop-materialize-queue.test.ts.
    const revealTerminalSession = vi.fn((worktreeId: string, opts: Record<string, unknown>) =>
      Promise.resolve({
        tabId: opts.tabId,
        identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await runtime.materializeRestoredAgentPanes()
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)

    await runtime.materializeRestoredAgentPanes()
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })
})

// [S10-21c B-final F9, D-R159 finding 9] materializeRestoredAgentPanes' getOrchestrationDb()
// retry — own describe (no `db` fixture needed, the queue is empty and the drain has nothing to
// reveal either way; only the retry/warn behaviour is under test).
describe('S10-21c B-final F9: materializeRestoredAgentPanes getOrchestrationDb() retry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function bareRuntime(): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never)
    runtime.setNotifier({ revealTerminalSession: vi.fn() } as never)
    return runtime
  }

  it('a SECOND getOrchestrationDb() throw warns exactly once (desktop_materialize_audit_unavailable) and still drains (never throws) — fails at base: base warns on the FIRST throw with no retry', async () => {
    const runtime = bareRuntime()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(runtime, 'getOrchestrationDb').mockImplementation(() => {
      throw new Error('db unavailable')
    })
    await expect(runtime.materializeRestoredAgentPanes()).resolves.toBeUndefined()
    expect(runtime.getOrchestrationDb).toHaveBeenCalledTimes(2)
    const auditUnavailableCalls = warn.mock.calls.filter(
      (call) => call[0] === '[restore-sweep] desktop_materialize_audit_unavailable'
    )
    expect(auditUnavailableCalls).toHaveLength(1)
  })

  it('a transient (first-call-only) getOrchestrationDb() throw is recovered by the retry — no warning, db attached', async () => {
    const runtime = bareRuntime()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realDb = new OrchestrationDb(':memory:')
    let calls = 0
    vi.spyOn(runtime, 'getOrchestrationDb').mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        throw new Error('transient')
      }
      return realDb
    })
    await expect(runtime.materializeRestoredAgentPanes()).resolves.toBeUndefined()
    expect(runtime.getOrchestrationDb).toHaveBeenCalledTimes(2)
    const auditUnavailableCalls = warn.mock.calls.filter(
      (call) => call[0] === '[restore-sweep] desktop_materialize_audit_unavailable'
    )
    expect(auditUnavailableCalls).toHaveLength(0)
    realDb.close()
  })
})

// Own describe (no `db`/afterEach) — a source-grep assertion, not a runtime test.
describe('S10-21c B6, design §2 S9: index.ts wiring', () => {
  it('calls materializeRestoredAgentPanes from the renderer-startup handler and the end of the desktop sweep body', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    const handlerStart = source.indexOf(
      "ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup'"
    )
    const handlerEnd = source.indexOf('onDeferredRecoveryError', handlerStart)
    expect(handlerStart).toBeGreaterThanOrEqual(0)
    expect(handlerEnd).toBeGreaterThan(handlerStart)
    expect(source.slice(handlerStart, handlerEnd)).toContain(
      'await runtime?.materializeRestoredAgentPanes()'
    )
    // [S10-21c B6c, D-R155-b6b finding 1] Marks hydration BEFORE reconcile — must be the first
    // thing the handler body does, not buried inside the (twice-firing) reconcile closure.
    expect(source.slice(handlerStart, handlerStart + 500)).toContain(
      'markRendererHydratedForMaterialize(desktopMaterializeHydrationGate)'
    )

    const sweepBodyStart = source.indexOf('await runStartupRestoreSweepBody(runtime)')
    expect(sweepBodyStart).toBeGreaterThanOrEqual(0)
    // [S10-21c B6c, D-R155-b6b finding 1] Window widened from 600: the trigger is now gated on
    // shouldDrainAtEndOfSweep (renderer-hydration proof), pushing the call further from the anchor.
    const sweepBodyWindow = source.slice(sweepBodyStart, sweepBodyStart + 900)
    expect(sweepBodyWindow).toContain('releaseRestoreSweepLock()')
    expect(sweepBodyWindow).toContain('shouldDrainAtEndOfSweep(desktopMaterializeHydrationGate)')
    expect(sweepBodyWindow).toContain('await runtime.materializeRestoredAgentPanes()')
  })
})
