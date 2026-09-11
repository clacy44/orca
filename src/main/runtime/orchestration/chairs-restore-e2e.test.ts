// S10-21d b4 (design-r105-r112 ITEM 2, tests row; s10-21d-design-v1 DEC-2): true end to end,
// against a REAL `OrcaRuntimeService` + a real (stubbed-provider) `createTerminal`, the same
// harness shape restore-sweep-t11-end-to-end.test.ts already proved sound — but driving
// `requestChairRestore` (this brief's own rail), never the boot-time sweep. Two-chair manifest ->
// two panes, two launch rows with evidence 'host_restore', two registered names, recorded ==
// minted; re-run -> skip_live, zero new panes/rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { _resetRestoreSweepLockForTest } from '../restore-sweep-lock'
import { runChairsRestore, type ChairsRestoreExecutorDeps } from './chairs-restore-execute'
import { resolveResumeTranscript } from '../../startup/resolve-resume-transcript'
import type { ChairsManifest } from './chairs-manifest'
import type { ControllerInventory } from './agent-process-identity'
import { parsePaneKey } from '../../../shared/stable-pane-id'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

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

function buildDeps(runtime: OrcaRuntimeService, db: OrchestrationDb): ChairsRestoreExecutorDeps {
  const hostId = runtime.getOrchestrationCompatibilityHostId()
  return {
    hostId,
    machineId: hostId,
    getAgentByName: (h, name) => db.getAgentByName(h, name),
    paneHoldingSession: (h, sessionId) => db.paneHoldingSession(h, sessionId),
    newestLaunchForPane: (h, paneKey) => db.newestLaunchForPane(h, paneKey),
    isPaneLive: (paneKey) => {
      const signals = runtime.getAgentDirectoryLivenessSignals(paneKey)
      return signals.terminalHandle !== null || signals.observedLive
    },
    requestChairRestore: (request) => runtime.requestChairRestore(request),
    hasLiveHookReportOfSession: (sessionId) => runtime.hasLiveHookReportOfSession(sessionId),
    hasResumableTranscriptTurn: async (agentType, sessionId) => {
      const result = await resolveResumeTranscript(agentType, sessionId)
      return result !== null && 'hasTurn' in result && result.hasTurn
    }
  }
}

describe('S10-21d b4 e2e: two-chair manifest through requestChairRestore, then an idempotent re-run', () => {
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

  it('restores both chairs, then a re-run against the same manifest is fully idempotent', async () => {
    db = new OrchestrationDb(':memory:')
    tempHome = await mkdtemp(join(tmpdir(), 'orca-chairs-e2e-'))
    process.env.HOME = tempHome
    expect(homedir()).toBe(tempHome)
    const projectDir = join(tempHome, '.claude', 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    for (const sessionId of ['sess-e2e-a', 'sess-e2e-b']) {
      await writeFile(
        join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
      )
    }

    const runtime = new OrcaRuntimeService({
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
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
    // [DEVIATION, see RETURN] `db.recordLaunch` is normally written by the REAL pty controller's
    // spawn confirmation (pty.ts's `launchAdmissionBundle`, reached over IPC by the real spawn
    // implementation) — unreachable from a bare test double, exactly like
    // restore-sweep-t11-end-to-end.test.ts's own harness, which never asserts a launch row for
    // the same reason. This fake performs that one write itself, from the SAME
    // `launchAdmission` descriptor `createTerminal` already built (`opts.launchAdmission`),
    // so the assertions below exercise the real `db.recordLaunch`/`evidence: 'host_restore'`
    // path at the DB layer even though the IPC hop that normally drives it is out of reach here.
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

    const manifest: ChairsManifest = {
      version: 1,
      chairs: [
        { name: 'chair-e2e-a', worktree: 'id:wt-1', agent: 'claude', conversationId: 'sess-e2e-a' },
        { name: 'chair-e2e-b', worktree: 'id:wt-1', agent: 'claude', conversationId: 'sess-e2e-b' }
      ]
    }
    const deps = buildDeps(runtime, db)

    const first = await runChairsRestore(manifest, deps)
    expect(first.exitNonZero).toBe(false)
    expect(first.rows.map((r) => r.kind)).toEqual(['launch', 'launch'])
    for (const row of first.rows) {
      if (row.kind === 'error' || row.kind === 'refuse') {
        throw new Error(`unexpected row kind ${row.kind}`)
      }
      expect(row.ok).toBe(true)
      expect(row.recorded).toBe(row.minted)
      expect(row.paneLive).toBe(true)
    }
    expect(manifest.chairs[0].lastSessionId).toBe('sess-e2e-a')
    expect(manifest.chairs[1].lastSessionId).toBe('sess-e2e-b')

    const hostId = runtime.getOrchestrationCompatibilityHostId()
    const rowA = db.getAgentByName(hostId, 'chair-e2e-a')
    const rowB = db.getAgentByName(hostId, 'chair-e2e-b')
    expect(rowA?.pane_key).not.toBeNull()
    expect(rowB?.pane_key).not.toBeNull()
    expect(db.newestLaunchForPane(hostId, rowA!.pane_key!)?.evidence).toBe('host_restore')
    expect(db.newestLaunchForPane(hostId, rowB!.pane_key!)?.evidence).toBe('host_restore')

    const agentsBefore = db.listAgents({ hostId }).agents.length

    const second = await runChairsRestore(manifest, deps)
    expect(second.exitNonZero).toBe(false)
    expect(second.rows.map((r) => r.kind)).toEqual(['skip_live', 'skip_live'])
    for (const row of second.rows) {
      if (row.kind === 'error' || row.kind === 'refuse') {
        throw new Error(`unexpected row kind ${row.kind}`)
      }
      expect(row.ok).toBe(true)
    }
    expect(db.listAgents({ hostId }).agents.length).toBe(agentsBefore)
  })

  // [S10-21f b2-10q R143] A dead holder normally adopts; a live hook report of the same session
  // elsewhere used to refuse it unconditionally (`live_report_elsewhere`) even when that
  // reporter's own pty has since died. This proves the discount end to end: requestChairRestore
  // -> resolveHolderAdoption -> the real host_restore admission arm -> the db write.
  it('[R143] a dead holder is adoptable despite a stale report elsewhere once that reporter pane resolves an absent pty', async () => {
    db = new OrchestrationDb(':memory:')
    tempHome = await mkdtemp(join(tmpdir(), 'orca-chairs-e2e-r143-'))
    process.env.HOME = tempHome
    const projectDir = join(tempHome, '.claude', 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const sessionId = 'sess-r143'
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
    )

    const runtime = new OrcaRuntimeService({
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
    runtime.setOrchestrationDb(db)
    stubLaunchScope(runtime)
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

    const hostId = runtime.getOrchestrationCompatibilityHostId()
    const holderPaneKey = `tab-old:${randomUUID()}`
    const holderPtyId = `pty-${randomUUID()}`
    const holderIncarnationId = randomUUID()
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-r143',
      role: null,
      hostId,
      paneKey: holderPaneKey,
      terminalHandle: null,
      processIncarnation: `${holderPtyId}:${holderIncarnationId}`,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: hostId
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const launched = db.recordLaunch({
      hostId,
      paneKey: holderPaneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration: 'gen-r143-prior',
      executionHostId: hostId,
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }

    // The reporter pane: NOT the holder, reports the session as live, but its own pty is
    // ABSENT from the round and not connected now — the exact fixture R143 exists for.
    const reporterPaneKey = `tab-reporter:${randomUUID()}`
    const reporterPtyId = `pty-reporter-${randomUUID()}`
    const reporterParsed = parsePaneKey(reporterPaneKey)
    if (!reporterParsed) {
      throw new Error('fixture reporter pane key unparsable')
    }
    runtime.setLiveReportPanesForSessionCheck((sid, opts) => {
      if (sid !== sessionId || opts?.excludePaneKey === reporterPaneKey) {
        return []
      }
      return [{ paneKey: reporterPaneKey, executionHostId: hostId }]
    })
    // No connected pty anywhere (holder or reporter) — matches the dead-holder fixture shape.
    vi.spyOn(runtime, 'findConnectedPtyForPane').mockReturnValue(undefined)
    vi.spyOn(runtime, 'getPersistedPtyIdForLeaf').mockImplementation((tabId, leafId) =>
      tabId === reporterParsed.tabId && leafId === reporterParsed.leafId ? reporterPtyId : undefined
    )
    // Neither the holder's nor the reporter's pty is listed live.
    const deadInventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)

    const result = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId,
      displayName: 'chair-r143'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('unreachable')
    }
    expect(result.holderPaneKey).toBe(holderPaneKey)
    expect(result.adoptionSignal).toBe('IDENTITY')
    expect(db.newestLaunchForPane(hostId, result.paneKey)?.evidence).toBe('host_restore')
  })
})
