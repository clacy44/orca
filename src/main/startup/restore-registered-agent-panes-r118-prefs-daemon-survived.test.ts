// [S10-21d Gate-3 fix, C2] Chained e2e for the defect the Gate-3 verifier found and the chair
// agreed on: the daemon-survived arm (agent-daemon-respawn-handle-refresh.ts's
// `currentLaunchGeneration` branch) inserted a NEW `agent_launch_sessions` row via
// `recordLaunchInTransaction` WITHOUT the pane's stored prefs, so every desktop relaunch (the
// routine daemon-survived path) silently nulled a pane's pref_model/pref_effort/pref_source —
// and a chair launched with --effort ultracode was restored as xhigh once the DEC-9
// `preserveUltracode` guard (agent-launch-sessions.ts's `updateLaunchPrefsForPane`) could no
// longer see a 'launch'-sourced 'ultracode' on the newest row.
//
// This chains the REAL production path, same shape as
// restore-registered-agent-panes-s7-daemon-survived.test.ts (`restoreOneRegisteredPane` ->
// `skipped_daemon_survived` -> the real, un-mocked `refreshAgentHandleAfterRespawn`, via
// `vi.spyOn` with no `mockImplementation` so the call-through is the actual write) — then feeds
// the resulting newest row through `launchPreferencesFromRow` and the real
// `orchestration.chairs.export` RPC handler, exactly as production reads it
// (restore-registered-agent-panes.ts:230, chairs-restore.ts:307/335-339).
//
// RED AT 263355b7b4 (this worker's own red-at-base run, before the fix in
// agent-daemon-respawn-handle-refresh.ts and agent-restore-rebind.ts): see this commit's own
// body for the verbatim failure output — every assertion below that reads prefs back off the
// post-daemon-survived newest row failed, because that row's pref_model/pref_effort/pref_source
// were NULL.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  recordLaunch,
  updateLaunchPrefsForPane,
  newestLaunchForPane,
  launchPreferencesFromRow
} from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import { CHAIRS_RESTORE_METHODS } from '../runtime/rpc/methods/chairs-restore'
import type { RpcContext } from '../runtime/rpc/core'
import type { ChairsManifest } from '../runtime/orchestration/chairs-manifest'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const exportMethod = CHAIRS_RESTORE_METHODS.find((m) => m.name === 'orchestration.chairs.export')
if (!exportMethod) {
  throw new Error('orchestration.chairs.export not registered')
}

const REAL_PTY_ID = '214dd5c0-7235-4fed-99c9-9d9480fca577::/home/ubuntu@@Zb7_DmyB'
const REAL_INCARNATION_ID = '80808080-8080-4808-8808-808080808088'
const REAL_PROCESS_INCARNATION = `${REAL_PTY_ID}:${REAL_INCARNATION_ID}`

describe('S10-21d Gate-3 fix: daemon-survived relaunch preserves pane prefs', () => {
  let orchestrationDb: OrchestrationDb | undefined
  let dir: string | undefined

  afterEach(async () => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  async function exportManifest(): Promise<ChairsManifest> {
    dir = await mkdtemp(join(tmpdir(), 'chairs-export-daemon-survived-test-'))
    const path = join(dir, 'chairs.json')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(orchestrationDb!)
    vi.spyOn(runtime, 'getOrchestrationCompatibilityHostId').mockReturnValue(HOST_ID)
    const ctx = { runtime } as RpcContext
    const result = (await exportMethod!.handler({ manifestPath: path, force: false }, ctx)) as {
      manifest: ChairsManifest
    }
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as ChairsManifest
    expect(onDisk).toEqual(result.manifest)
    return result.manifest
  }

  async function driveDaemonSurvived(
    db: Database.Database,
    agentId: string,
    paneKey: string,
    terminalHandle: string
  ): Promise<void> {
    insertAgent(db, {
      id: agentId,
      display_name: agentId,
      pane_key: paneKey,
      process_incarnation: REAL_PROCESS_INCARNATION
    })
    const inventory = emptyInventory({
      allLivePtyIds: new Set([REAL_PTY_ID]),
      terminalIdentityByPtyId: new Map([
        [REAL_PTY_ID, { handle: terminalHandle, incarnationId: REAL_INCARNATION_ID }]
      ])
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { notifyRebindDelivery: vi.fn() }),
      orchestrationDb!,
      HOST_ID,
      agentId,
      REAL_PROCESS_INCARNATION,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
  }

  it('ultracode survives a daemon-survived relaunch, an observed xhigh echo, and the chairs export (DEC-9)', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000f1'
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-f1',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch',
      prefs: { model: 'claude-opus-4-8', effort: 'ultracode', source: 'launch' }
    })

    await driveDaemonSurvived(db, 'agent-f1', paneKey, 'term_fresh_f1')

    // The daemon-survived arm's own INSERT is now the pane's newest row — it must still carry
    // the launch-time prefs, not NULL.
    const afterDaemonSurvived = newestLaunchForPane(db, HOST_ID, paneKey)
    expect(afterDaemonSurvived?.pref_model).toBe('claude-opus-4-8')
    expect(afterDaemonSurvived?.pref_effort).toBe('ultracode')
    expect(afterDaemonSurvived?.pref_source).toBe('launch')

    // A live statusline report arrives next, echoing 'xhigh' (the observed signal cannot tell
    // ultracode and xhigh apart) — DEC-9's preserveUltracode must still refuse to downgrade it,
    // and it can only see that guard if the row it reads (the one the daemon-survived arm just
    // wrote) still says 'launch'/'ultracode'.
    updateLaunchPrefsForPane(db, HOST_ID, paneKey, { effort: 'xhigh', source: 'observed' })
    const afterObservedEcho = newestLaunchForPane(db, HOST_ID, paneKey)
    expect(afterObservedEcho?.pref_effort).toBe('ultracode')
    expect(afterObservedEcho?.pref_source).toBe('launch')

    expect(launchPreferencesFromRow(afterObservedEcho!)).toEqual({
      model: 'claude-opus-4-8',
      effort: 'ultracode'
    })

    const manifest = await exportManifest()
    expect(manifest.chairs).toHaveLength(1)
    expect(manifest.chairs[0].effort).toBe('ultracode')
    expect(manifest.chairs[0].model).toBe('claude-opus-4-8')
  })

  it('a plain {model opus, effort max} survives a daemon-survived relaunch', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-0000000000f2'
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-f2',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch',
      prefs: { model: 'opus', effort: 'max', source: 'launch' }
    })

    await driveDaemonSurvived(db, 'agent-f2', paneKey, 'term_fresh_f2')

    const afterDaemonSurvived = newestLaunchForPane(db, HOST_ID, paneKey)
    expect(afterDaemonSurvived?.pref_model).toBe('opus')
    expect(afterDaemonSurvived?.pref_effort).toBe('max')
    expect(afterDaemonSurvived?.pref_source).toBe('launch')
    expect(launchPreferencesFromRow(afterDaemonSurvived!)).toEqual({
      model: 'opus',
      effort: 'max'
    })

    const manifest = await exportManifest()
    expect(manifest.chairs).toHaveLength(1)
    expect(manifest.chairs[0].effort).toBe('max')
    expect(manifest.chairs[0].model).toBe('opus')
  })
})
