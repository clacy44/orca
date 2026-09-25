// S10-22a WAVE 2 (Wave 2 contract A7): restore, export and succession-confirm
// (chair-succession-accept.ts's `writeManifestLastSessionId`) must share ONE `withPaneLock` key,
// `chairs-manifest:<host>`.
//
// [G1-10z attempt-2 N6 repair] The attempt-1 L5 repair still proved nothing: the succession side
// stayed a hand-written closure (mirroring the REAL `writeManifestLastSessionId`, never calling
// it), and a `dryRun` restore returns before ever touching the manifest object or the write path
// — so the shared-key assertion passed even with the succession write on a DIFFERENT key
// entirely (p6: 5/5 runs "restore:done" then "succession:done" with no shared key at all,
// because dryRun's lock hold is too short to race against). This drives the succession side
// through the REAL exported `writeManifestLastSessionId` (chair-succession-manifest-session-
// write.ts) and the restore side through a REAL non-dry-run restore whose one `launch` action is
// held open on a deferred promise (via `runtime.requestChairRestore`, the sole IO
// `executeChairsRestorePlan` awaits per action) — long enough to prove the succession write
// cannot land while restore still holds `chairs-manifest:<host>`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAIRS_RESTORE_METHODS } from './chairs-restore'
import { writeManifestLastSessionId } from '../../orchestration/chair-succession-manifest-session-write'
import type { ChairsManifest } from '../../orchestration/chairs-manifest'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RequestChairRestoreOutcome } from '../../orchestration/chairs-restore-execute'

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('A7: chairs-manifest:<host> lock serializes a REAL restore call against a REAL succession-style write', () => {
  let dir: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(async () => {
    db?.close()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a REAL succession write cannot land while a REAL non-dry-run restore still holds the lock, and lands once it releases', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chairs-manifest-lock-'))
    const path = join(dir, 'chairs.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        chairs: [{ name: 'chair-a', worktree: '/repo', agent: 'claude', conversationId: 'conv-1' }]
      })
    )

    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getOrchestrationCompatibilityHostId').mockReturnValue(HOST_ID)
    const ctx = { runtime } as RpcContext

    // No agent is registered for `chair-a` and no pane holds its session, so the planner's only
    // action is `launch`, which the executor serves entirely through this one call — the sole
    // IO `executeChairsRestorePlan` awaits per action, and it runs INSIDE the `chairs-manifest:
    // <host>` lock (chairs-restore.ts). Held open here on a deferred promise so the lock's hold
    // window is long enough to race a real write against.
    const outcome = deferred<RequestChairRestoreOutcome>()
    const requestChairRestore = vi
      .spyOn(runtime, 'requestChairRestore')
      .mockReturnValue(outcome.promise)

    const order: string[] = []
    const restoreCall = (
      restoreMethod!.handler({ manifestPath: path, dryRun: false }, ctx) as Promise<unknown>
    ).then((result) => {
      order.push('restore:done')
      return result
    })

    // Give the restore call's lock acquisition + read + plan a turn to run and reach the held
    // `requestChairRestore` call — it must be inside the lock by the time we probe below.
    await vi.waitFor(() => expect(requestChairRestore).toHaveBeenCalled())

    // The REAL exported writer (chair-succession-manifest-session-write.ts), at the REAL
    // `chairs-manifest:${hostId}` key — not a hand-written stand-in.
    const successionWrite = writeManifestLastSessionId(
      path,
      HOST_ID,
      'chair-a',
      'sess-from-succession'
    ).then(() => {
      order.push('succession:done')
    })

    // While restore still holds the key, the succession write has NOT landed — race it against
    // a short timer rather than the restore call itself (which we don't want to await yet).
    const raced = await Promise.race([
      successionWrite.then(() => 'succession'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))
    ])
    expect(raced).toBe('timeout')
    const midOnDisk = JSON.parse(await readFile(path, 'utf8')) as ChairsManifest
    expect(midOnDisk.chairs[0].lastSessionId).toBeUndefined()

    outcome.resolve({
      ok: true,
      paneKey: 'tab-a:leaf-a',
      agentId: 'agt_restored',
      holderPaneKey: null,
      adoptionSignal: null
    })

    await Promise.all([restoreCall, successionWrite])

    // FIFO — restore was submitted first on the same real key, so it fully released the lock
    // before the succession write's own `withPaneLock` call could acquire it.
    expect(order).toEqual(['restore:done', 'succession:done'])

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as ChairsManifest
    expect(onDisk.chairs[0].lastSessionId).toBe('sess-from-succession')
  })

  it('a local-transport-only refusal (a paired caller) never even reaches the lock', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chairs-manifest-lock-forbidden-'))
    const path = join(dir, 'chairs.json')
    await writeFile(path, JSON.stringify({ version: 1, chairs: [] }))
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const ctx = { runtime, accessProfile: 'peer', clientKind: 'runtime' } as unknown as RpcContext

    await expect(
      restoreMethod!.handler({ manifestPath: path, dryRun: true }, ctx)
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
