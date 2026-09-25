// [S10-22a Wave 2 contract, "Startup scan (A10)"; G1-10z B4 repair] Proves the hook is a single
// shared function that BOTH the serve path and the desktop path call — before this repair, `orca
// serve` never ran the succession scan or loaded the retired-handle index at all (only the
// desktop-only sweep body did). This test exercises the hook directly, the way `orca serve`'s
// call site (`runStartupRestoreSweep`, src/main/index.ts) reaches it — no window, no desktop
// sweep lock, nothing desktop-specific in the dependency surface.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  runChairSuccessionStartupHook,
  type ChairSuccessionStartupHookRuntime
} from './chair-succession-startup-hook'
import {
  _resetRetiredHandlesIndexForTest,
  retiredHandleChair
} from '../runtime/orchestration/chair-succession-retired-index'
import {
  createSealed,
  read,
  type ChairSuccessionStoreDeps
} from '../runtime/orchestration/chair-succession-store'

let orcaHome: string
let db: OrchestrationDb

function fakeRuntime(): ChairSuccessionStartupHookRuntime {
  return {
    closeTerminal: async () => ({ closed: true }) as never,
    cancelMessageWaiters: () => {},
    getOrchestrationDb: () => db
  } as unknown as ChairSuccessionStartupHookRuntime
}

beforeEach(() => {
  orcaHome = mkdtempSync(join(tmpdir(), 'orca-succession-hook-'))
  db = new OrchestrationDb(':memory:')
  _resetRetiredHandlesIndexForTest()
})

afterEach(() => {
  rmSync(orcaHome, { recursive: true, force: true })
  db.close()
  _resetRetiredHandlesIndexForTest()
})

describe('runChairSuccessionStartupHook (shared by serve AND desktop)', () => {
  it('serve-path shape: no window/desktop-sweep-lock dependency — loads the retired-handle index and scans successions', async () => {
    const chairDir = join(orcaHome, 'chairs', 'chair-serve')
    mkdirSync(chairDir, { recursive: true })
    writeFileSync(
      join(chairDir, 'retired-handles.json'),
      JSON.stringify([
        { handle: 'old-handle-serve', succession: 'succ_test000001', at: '2026-01-01T00:00:00Z' }
      ])
    )
    const storeDeps: ChairSuccessionStoreDeps = { orcaHome }
    const meta = await createSealed(storeDeps, 'chair-serve', {
      reason: 'batch_end',
      checkpointText: 'schema: orca.chair-checkpoint/1\n',
      checkpointSha: 'a'.repeat(64),
      charterPath: '/repo/CHARTER.md',
      charterSha: 'b'.repeat(64),
      charterMode: 'reference',
      resumeContextText: '# SUCCESSION CONTEXT succ_test\n',
      incumbent: {
        paneKey: 'pane-incumbent',
        terminalHandle: 'handle-incumbent',
        sessionId: 'sess-1'
      }
    })

    await runChairSuccessionStartupHook(fakeRuntime(), orcaHome)

    // The index was loaded — proves B4's other half (Mail A3's retired-handle rewrite) now works
    // on the serve path too, not only after the desktop-only sweep body.
    expect(retiredHandleChair('old-handle-serve')).toBe('chair-serve')
    // The scan ran — a sealed record with no successor ever launched is resolved to aborted.
    const after = await read(storeDeps, 'chair-serve', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
  })

  it('never throws when getOrchestrationDb() is unarmed (serve calling before the store attaches)', async () => {
    const throwingRuntime: ChairSuccessionStartupHookRuntime = {
      closeTerminal: async () => ({ closed: true }) as never,
      getOrchestrationDb: () => {
        throw new Error('orchestration db not armed yet')
      }
    } as unknown as ChairSuccessionStartupHookRuntime

    await expect(runChairSuccessionStartupHook(throwingRuntime, orcaHome)).resolves.toBeUndefined()
  })

  it('a missing chairs/ directory is a silent no-op (no chair has ever succeeded on this host)', async () => {
    await expect(
      runChairSuccessionStartupHook(fakeRuntime(), join(orcaHome, 'never-created'))
    ).resolves.toBeUndefined()
  })
})
