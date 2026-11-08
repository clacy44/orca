// After a restore that rebound or launched at least one chair, the RPC handler must (1) push fresh
// live-session marks to the renderer and (2) queue the restored panes for a visible tab. Driven
// through the REAL handler and a REAL runtime; only `requestChairRestore` (the sole IO per action)
// and the two post-run runtime methods are spied.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAIRS_RESTORE_METHODS } from './chairs-restore'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const restoreMethod = CHAIRS_RESTORE_METHODS.find((m) => m.name === 'orchestration.chairs.restore')
if (!restoreMethod) {
  throw new Error('orchestration.chairs.restore not registered')
}

const HOST_ID = 'local'

describe('chairs restore RPC post-run work', () => {
  let dir: string
  let db: OrchestrationDb

  afterEach(async () => {
    db?.close()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function setup(): Promise<{
    runtime: OrcaRuntimeService
    path: string
    order: string[]
    publish: ReturnType<typeof vi.spyOn>
    materialize: ReturnType<typeof vi.spyOn>
  }> {
    dir = await mkdtemp(join(tmpdir(), 'chairs-restore-post-run-'))
    const path = join(dir, 'chairs.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        chairs: [{ name: 'chair-a', worktree: '/repo', agent: 'claude', conversationId: 'conv-1' }]
      })
    )
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getOrchestrationCompatibilityHostId').mockReturnValue(HOST_ID)
    const order: string[] = []
    const publish = vi
      .spyOn(runtime, 'publishLiveAgentSessionMarks')
      .mockImplementation(async () => {
        order.push('publish')
      })
    const materialize = vi
      .spyOn(runtime, 'materializeRestoredAgentPanes')
      .mockImplementation(async () => {
        order.push('materialize')
      })
    return { runtime, path, order, publish, materialize }
  }

  const run = (runtime: OrcaRuntimeService, path: string, dryRun: boolean): Promise<unknown> =>
    restoreMethod!.handler({ manifestPath: path, dryRun }, {
      runtime
    } as RpcContext) as Promise<unknown>

  // Lets queued microtasks and zero-delay timers drain before an absence assertion.
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

  it('publishes marks and materializes panes once each, after requestChairRestore', async () => {
    const { runtime, path, order, publish, materialize } = await setup()
    vi.spyOn(runtime, 'requestChairRestore').mockImplementation(async () => {
      order.push('restore')
      return {
        ok: true,
        paneKey: 'tab-a:leaf-a',
        agentId: 'agt_restored',
        holderPaneKey: null,
        adoptionSignal: null
      }
    })

    await run(runtime, path, false)

    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledTimes(1)
      expect(materialize).toHaveBeenCalledTimes(1)
    })
    expect(order[0]).toBe('restore')
    expect(order.slice(1).sort()).toEqual(['materialize', 'publish'])
  })

  it('does neither when no chair was restored', async () => {
    const { runtime, path, publish, materialize } = await setup()
    vi.spyOn(runtime, 'requestChairRestore').mockResolvedValue({
      ok: false,
      reason: 'restore_target_live_elsewhere',
      holderPaneKey: 'tab:x'
    })

    await run(runtime, path, false)
    await flush()

    expect(publish).not.toHaveBeenCalled()
    expect(materialize).not.toHaveBeenCalled()
  })

  it('does neither on a dry run', async () => {
    const { runtime, path, publish, materialize } = await setup()
    const requestChairRestore = vi.spyOn(runtime, 'requestChairRestore')

    await run(runtime, path, true)
    await flush()

    expect(requestChairRestore).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(materialize).not.toHaveBeenCalled()
  })
})
