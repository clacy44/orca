// S10-21a C7b, T2: Layer 2 rebind end to end against a REAL `createTerminal` — the admission's
// HOST_RESUME row is written at spawn and `rebindRestoredPane` binds it, the mark is written.
// This is the fence D-R110 (η) found absent: every prior test drove either `rebindRestoredPane`
// in isolation or a deps-mocked `ensureAgentSession`, never the real path B1/B2/B3 actually
// broke. Mail-repoint counts are NOT asserted here (a fixture using `db.insertMessage` needs a
// seeded `runs` row this test does not set up) — `agent-restore-rebind.test.ts` already covers
// `pendingOnOldHandle` against `rebindRestoredPane` directly.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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
    mintRestoreTicket: (payload) => runtime.mintRestoreTicket(payload),
    notifyRebindDelivery: (agentId) => runtime.notifyRebindDelivery(agentId)
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
      // The registered agent's OWN identity: this ptyId, an OLD incarnation.
      processIncarnation: `${reusedPtyId}:inc-OLD`,
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
        [reusedPtyId, { handle: 'term_new', incarnationId: 'inc-NEW' }]
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
})
