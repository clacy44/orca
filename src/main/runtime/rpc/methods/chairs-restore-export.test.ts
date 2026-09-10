// S10-21d bD C1 (D-R168 MEDIUM-1 fix): `orchestration.chairs.export`'s manifest-entry
// model/effort capture. Drives the real handler out of CHAIRS_RESTORE_METHODS against a real
// OrcaRuntimeService + OrchestrationDb (the shape chairs-restore.test.ts's own header comment
// says the handlers need — chairs-restore-e2e.test.ts covers restore; this covers export).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAIRS_RESTORE_METHODS } from './chairs-restore'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { ChairsManifest } from '../../orchestration/chairs-manifest'
import { AGENT_DIRECTORY_READ_CAP } from '../../orchestration/agent-directory'

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

describe('S10-21d bD C1: orchestration.chairs.export captures pref_model/pref_effort', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let dir: string
  const hostId = 'local'

  afterEach(async () => {
    db?.close()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function setup(): Promise<void> {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getOrchestrationCompatibilityHostId').mockReturnValue(hostId)
    ctx = { runtime }
    dir = await mkdtemp(join(tmpdir(), 'chairs-export-test-'))
  }

  function registerChair(name: string, paneKey: string, worktreeId: string | null = 'wt-1'): void {
    db.upsertAgentByPaneSuffix({
      displayName: name,
      role: null,
      hostId,
      paneKey,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: hostId
    })
  }

  type ExportHandlerResult = {
    manifest: ChairsManifest
    skipped: { name: string; reason: 'no_pane' | 'no_launch_row' | 'no_worktree' }[]
  }

  async function runExportFull(force: boolean): Promise<ExportHandlerResult> {
    const path = join(dir, 'chairs.json')
    const result = (await exportMethod!.handler(
      { manifestPath: path, force },
      ctx
    )) as ExportHandlerResult
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as ChairsManifest
    expect(onDisk).toEqual(result.manifest)
    return result
  }

  async function runExport(force: boolean): Promise<ChairsManifest> {
    return (await runExportFull(force)).manifest
  }

  it('a newest launch row carrying pref_model + pref_effort emits both keys in the manifest entry', async () => {
    await setup()
    registerChair('chair-with-prefs', 'tab1:leaf-a')
    db.recordLaunch({
      hostId,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-with-prefs',
      launchGeneration: 'gen-1',
      executionHostId: hostId,
      evidence: 'host_launch',
      prefs: { model: 'opus', effort: 'high', source: 'launch' }
    })
    const manifest = await runExport(false)
    expect(manifest.chairs).toHaveLength(1)
    expect(manifest.chairs[0].model).toBe('opus')
    expect(manifest.chairs[0].effort).toBe('high')
  })

  it('a row with NULL prefs emits neither key', async () => {
    await setup()
    registerChair('chair-no-prefs', 'tab1:leaf-b')
    db.recordLaunch({
      hostId,
      paneKey: 'tab1:leaf-b',
      agentType: 'claude',
      sessionId: 'sess-no-prefs',
      launchGeneration: 'gen-1',
      executionHostId: hostId,
      evidence: 'host_launch'
    })
    const manifest = await runExport(false)
    expect(manifest.chairs).toHaveLength(1)
    expect(manifest.chairs[0]).not.toHaveProperty('model')
    expect(manifest.chairs[0]).not.toHaveProperty('effort')
  })

  it('a row with an out-of-set effort omits effort and keeps model', async () => {
    await setup()
    registerChair('chair-bad-effort', 'tab1:leaf-c')
    db.recordLaunch({
      hostId,
      paneKey: 'tab1:leaf-c',
      agentType: 'claude',
      sessionId: 'sess-bad-effort',
      launchGeneration: 'gen-1',
      executionHostId: hostId,
      evidence: 'host_launch',
      // [forced deviation, see RETURN] recordLaunch's own prefs.effort type is `string`, not the
      // manifest's ChairsManifestEffort union — writing a value outside that set through the DB
      // layer directly is the only way to construct the "unexpected stored value" the brief's
      // third test case requires; a real caller cannot reach this state through the typed RPC
      // surface, which is exactly why the export path must validate rather than trust it.
      prefs: { model: 'opus', effort: 'not-a-real-effort', source: 'launch' }
    })
    const manifest = await runExport(false)
    expect(manifest.chairs).toHaveLength(1)
    expect(manifest.chairs[0].model).toBe('opus')
    expect(manifest.chairs[0]).not.toHaveProperty('effort')
  })
})

describe('G1-10o B4/C28 fix: export loudly reports chairs it cannot represent', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let dir: string
  const hostId = 'local'

  afterEach(async () => {
    db?.close()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function setup(): Promise<void> {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getOrchestrationCompatibilityHostId').mockReturnValue(hostId)
    ctx = { runtime }
    dir = await mkdtemp(join(tmpdir(), 'chairs-export-skip-test-'))
  }

  function registerChair(name: string, paneKey: string, worktreeId: string | null): void {
    db.upsertAgentByPaneSuffix({
      displayName: name,
      role: null,
      hostId,
      paneKey,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: hostId
    })
  }

  function rawDb(): {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown
      all: (...args: unknown[]) => unknown[]
      run: (...args: unknown[]) => unknown
    }
  } {
    return (db as unknown as { db: ReturnType<typeof rawDb> }).db
  }

  it('a chair with a worktree but no worktree recorded is skipped and reported; others still export', async () => {
    await setup()
    registerChair('chair-good', 'tab1:leaf-a', 'wt-1')
    db.recordLaunch({
      hostId,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-good',
      launchGeneration: 'gen-1',
      executionHostId: hostId,
      evidence: 'host_launch'
    })
    registerChair('chair-no-worktree', 'tab1:leaf-b', null)
    db.recordLaunch({
      hostId,
      paneKey: 'tab1:leaf-b',
      agentType: 'claude',
      sessionId: 'sess-no-worktree',
      launchGeneration: 'gen-1',
      executionHostId: hostId,
      evidence: 'host_launch'
    })
    const path = join(dir, 'chairs.json')
    const result = (await exportMethod!.handler({ manifestPath: path, force: false }, ctx)) as {
      manifest: ChairsManifest
      skipped: { name: string; reason: string }[]
    }
    expect(result.manifest.chairs.map((c) => c.name)).toEqual(['chair-good'])
    expect(result.skipped).toEqual([{ name: 'chair-no-worktree', reason: 'no_worktree' }])
  })

  // [D-R170 L2] Tightened to the specific error code (not just the error class — every
  // refusal on this handler throws OrchestrationError) and asserts no file was written.
  // [D-R170 M2 — NOT applied, see deviation in RETURN] This still refuses a host with EXACTLY
  // 200 real chairs (a complete, non-truncated read) — the review's own smallest fix for that
  // over-refusal (request AGENT_DIRECTORY_READ_CAP + 1, refuse only when agents.length exceeds
  // the cap) does not work: listAgents' OWN internal clamp
  // (Math.min(Math.max(params.limit ?? 100, 1), AGENT_DIRECTORY_READ_CAP), agent-directory.ts)
  // caps the read at 200 regardless of the requested limit, so agents.length can never exceed
  // 200 and the proposed `>` guard would never fire — silently re-opening the truncation hole
  // for a host with MORE than 200 chairs. Kept at `>=` (pre-D-R170 behavior) so the guard stays
  // loud.
  it('a directory at the listAgents hard cap (200) refuses rather than writing a silently short manifest', async () => {
    await setup()
    for (let i = 0; i < 200; i++) {
      const paneKey = `tab1:leaf-${i}`
      registerChair(`chair-${i}`, paneKey, 'wt-1')
      db.recordLaunch({
        hostId,
        paneKey,
        agentType: 'claude',
        sessionId: `sess-${i}`,
        launchGeneration: 'gen-1',
        executionHostId: hostId,
        evidence: 'host_launch'
      })
    }
    const path = join(dir, 'chairs.json')
    await expect(
      exportMethod!.handler({ manifestPath: path, force: false }, ctx)
    ).rejects.toMatchObject({ code: 'chairs_export_truncated' })
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  // [D-R170 L4] no_pane and no_launch_row were previously untested — only no_worktree was.
  // pane_key only goes NULL via a tombstone path in production (agent-retire.ts, etc.), which
  // export's own query excludes (`tombstoned_at IS NULL`) — set it directly to exercise the
  // no_pane skip branch against a live, non-tombstoned row.
  it('a chair with no pane recorded is skipped and reported as no_pane', async () => {
    await setup()
    registerChair('chair-no-pane', 'tab1:leaf-nopane', 'wt-1')
    rawDb().prepare(`UPDATE agents SET pane_key = NULL WHERE display_name = ?`).run('chair-no-pane')
    const path = join(dir, 'chairs.json')
    const result = (await exportMethod!.handler({ manifestPath: path, force: false }, ctx)) as {
      manifest: ChairsManifest
      skipped: { name: string; reason: string }[]
    }
    expect(result.manifest.chairs).toEqual([])
    expect(result.skipped).toEqual([{ name: 'chair-no-pane', reason: 'no_pane' }])
  })

  it('a chair with a pane but no launch row is skipped and reported as no_launch_row', async () => {
    await setup()
    registerChair('chair-no-launch', 'tab1:leaf-nolaunch', 'wt-1')
    const path = join(dir, 'chairs.json')
    const result = (await exportMethod!.handler({ manifestPath: path, force: false }, ctx)) as {
      manifest: ChairsManifest
      skipped: { name: string; reason: string }[]
    }
    expect(result.manifest.chairs).toEqual([])
    expect(result.skipped).toEqual([{ name: 'chair-no-launch', reason: 'no_launch_row' }])
  })
})

// [D-R171 NM-5 fix] Pins the value the export's truncation threshold now imports directly from
// listAgents' own clamp, instead of the independent (registration-ceiling) literal. Top-level,
// not inside the describe above — that block's afterEach unconditionally closes `db`, which
// this assertion never opens.
it('AGENT_DIRECTORY_READ_CAP is 200', () => {
  expect(AGENT_DIRECTORY_READ_CAP).toBe(200)
})
