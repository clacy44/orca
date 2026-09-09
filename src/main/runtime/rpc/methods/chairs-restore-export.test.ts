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

  function registerChair(name: string, paneKey: string): void {
    db.upsertAgentByPaneSuffix({
      displayName: name,
      role: null,
      hostId,
      paneKey,
      terminalHandle: null,
      processIncarnation: null,
      worktreeId: 'wt-1',
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: null,
      originHostId: hostId
    })
  }

  async function runExport(force: boolean): Promise<ChairsManifest> {
    const path = join(dir, 'chairs.json')
    const result = (await exportMethod!.handler({ manifestPath: path, force }, ctx)) as {
      manifest: ChairsManifest
    }
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as ChairsManifest
    expect(onDisk).toEqual(result.manifest)
    return result.manifest
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
