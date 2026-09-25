// S10-22a WAVE 2 (Wave 2 contract A7): restore, export and succession-confirm
// (chair-succession-accept.ts's `writeManifestLastSessionId`) must share ONE `withPaneLock` key,
// `chairs-manifest:<host>`.
//
// [G1-10z L5 repair] The prior version of this file proved nothing about production code — both
// sides were hand-written closures merely commented "mirrors X", so any drift in the REAL key
// string or REAL lock scope on either side would pass silently. This drives the restore side
// through the REAL `orchestration.chairs.restore` RPC handler (dryRun — no launch mocking
// needed, the lock is taken before the manifest is even parsed) and the succession side through
// the REAL shared primitives (`writeFileAtomic`, `parseChairsManifest`) at the REAL
// `chairs-manifest:${hostId}` key `hostIdFor` computes — not `chair-succession-accept.ts`'s own
// `writeManifestLastSessionId` verbatim (unexported, and under another worker's edit lock for
// this dispatch), flagged as the one remaining gap.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAIRS_RESTORE_METHODS, writeFileAtomic } from './chairs-restore'
import { withPaneLock } from '../../../ipc/agent-launch-admission-lock'
import { parseChairsManifest, type ChairsManifest } from '../../orchestration/chairs-manifest'
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

/** The real primitives `writeManifestLastSessionId` (chair-succession-accept.ts) uses, at the
 * real key — read -> patch one chair's lastSessionId -> atomic write, all under the lock. */
async function successionStyleWrite(path: string, chair: string, sessionId: string): Promise<void> {
  return withPaneLock(`chairs-manifest:${HOST_ID}`, async () => {
    const raw = await readFile(path, 'utf8')
    const parsed = parseChairsManifest(JSON.parse(raw))
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    const entry = parsed.manifest.chairs.find((c) => c.name === chair)
    if (!entry) {
      throw new Error(`no such chair ${chair}`)
    }
    entry.lastSessionId = sessionId
    await writeFileAtomic(path, `${JSON.stringify(parsed.manifest, null, 2)}\n`)
  })
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

  it("the succession-style write waits for the restore call's lock hold to release, and sees its manifest", async () => {
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

    const order: string[] = []
    // The lock is taken BEFORE the manifest is even read (chairs-restore.ts) — a dryRun call
    // still exercises the real lock-acquire/hold/release path with no launch mocking needed.
    const restoreCall = (
      restoreMethod!.handler({ manifestPath: path, dryRun: true }, ctx) as Promise<unknown>
    ).then((result) => {
      order.push('restore:done')
      return result
    })
    const successionWrite = successionStyleWrite(path, 'chair-a', 'sess-from-succession').then(
      () => {
        order.push('succession:done')
      }
    )

    await Promise.all([restoreCall, successionWrite])

    // FIFO — restore was submitted first on the same real key, so it fully released the lock
    // before the succession-style write's own `withPaneLock` call could acquire it.
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
