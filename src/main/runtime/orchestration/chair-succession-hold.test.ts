// S10-22a WAVE 2: hold/abort timer tests split out of chair-succession-execute.test.ts (line
// ratchet) — `holdSealRequest`/`runAbortTail`/`launchSuccessor` against a real `OrchestrationDb`
// + a real `OrcaRuntimeService` with `createAgentSession` mocked out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { holdSealRequest, settleHold, getHoldRecord } from './chair-succession-hold'
import { launchSuccessor } from './chair-succession-launch-successor'
import {
  createSealed,
  listActive,
  transition,
  read,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import { _resetRetiredHandlesIndexForTest } from './chair-succession-retired-index'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const VALID_CHECKPOINT = [
  'schema: orca.chair-checkpoint/1',
  '## Goal',
  'ship it',
  '## Completed and verified work',
  'none',
  '## Live units',
  'none',
  '## Blockers',
  'none',
  '## Unsaved rulings',
  'none',
  '## Queue',
  'none',
  '## Todo list',
  'none',
  '## Gotchas',
  'none',
  ''
].join('\n')

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HANDLE_A = 'term_a'

describe('S10-22a WAVE 2: chair-succession hold / abort', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let tmp: string
  let deps: ChairSuccessionDeps
  const hostId = 'local'

  beforeEach(async () => {
    db = new OrchestrationDb(':memory:')
    tmp = await mkdtemp(join(tmpdir(), 'orca-succession-hold-'))
    runtime = new OrcaRuntimeService({
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
    deps = {
      db,
      runtime,
      orcaHome: tmp,
      manifestPath: join(tmp, 'chairs.json')
    }
    _resetRetiredHandlesIndexForTest()
  })

  afterEach(async () => {
    db.close()
    await rm(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
    _resetRetiredHandlesIndexForTest()
  })

  const storeDeps: ChairSuccessionStoreDeps = { orcaHome: '' }

  beforeEach(() => {
    storeDeps.orcaHome = tmp
  })

  async function sealedLaunchingMeta(chair: string) {
    await mkdir(join(tmp, 'chairs'), { recursive: true })
    const meta = await createSealed(storeDeps, chair, {
      reason: 'batch_end',
      checkpointText: VALID_CHECKPOINT,
      checkpointSha: sha256(VALID_CHECKPOINT),
      charterPath: join(tmp, 'CHARTER.md'),
      charterSha: sha256('charter'),
      charterMode: 'reference',
      resumeContextText: 'resume text',
      incumbent: { paneKey: PANE_A, terminalHandle: HANDLE_A }
    })
    return transition(storeDeps, chair, meta.id, 'launching', {
      successor: { paneKey: 'tabB:b', terminalHandle: 'term_b' }
    })
  }

  it('chair review fix #1: hold registered before launch settles immediately on a fast launch failure (no 150s wait)', async () => {
    vi.useFakeTimers()
    await mkdir(join(tmp, 'chairs'), { recursive: true })
    const sealedMeta = await createSealed(storeDeps, 'chair-fast-fail', {
      reason: 'batch_end',
      checkpointText: VALID_CHECKPOINT,
      checkpointSha: sha256(VALID_CHECKPOINT),
      charterPath: join(tmp, 'CHARTER.md'),
      charterSha: sha256('charter'),
      charterMode: 'reference',
      resumeContextText: 'resume text',
      incumbent: { paneKey: PANE_A, terminalHandle: HANDLE_A }
    })
    vi.spyOn(runtime, 'createAgentSession').mockRejectedValue(new Error('spawn failed immediately'))
    // Same order the RPC handler now uses: register the hold FIRST (synchronously, before any
    // await), then launch — a launch that rejects on its first microtask must still find the
    // hold entry when its catch block calls `settleHold`.
    const holdPromise = holdSealRequest(deps, hostId, sealedMeta, undefined)
    void launchSuccessor(
      deps,
      hostId,
      {
        name: 'chair-fast-fail',
        worktree: 'id:wt-1',
        agent: 'claude',
        conversationId: 'sess-orig'
      },
      sealedMeta
    )
    // No `vi.advanceTimersByTimeAsync` call — if this ordering were wrong (launch before hold,
    // the pre-fix bug), the settle would be lost and this `await` would hang until the fake
    // timer is advanced past 150s, which never happens in this test.
    const outcome = await holdPromise
    expect(outcome).toMatchObject({ ok: false, code: 'succession_aborted' })
    expect((outcome as { reason: string }).reason).toContain('launch_failed')
    vi.useRealTimers()
  })

  // G1 repair M8 (D-R215 §Protocol step 4 "manifest else the row"): `launchSuccessor`'s
  // `createAgentSession` args — the exact prompt, background presentation, launch args, and
  // launch-prefs fallback to the INCUMBENT's own last-recorded prefs when the manifest sets
  // neither model nor effort.
  it('launchSuccessor: createAgentSession gets the exact prompt/background/agentArgs, and model/effort fall back to the incumbent launch row', async () => {
    await mkdir(join(tmp, 'chairs'), { recursive: true })
    const sealedMeta = await createSealed(storeDeps, 'chair-prefs', {
      reason: 'batch_end',
      checkpointText: VALID_CHECKPOINT,
      checkpointSha: sha256(VALID_CHECKPOINT),
      charterPath: join(tmp, 'CHARTER.md'),
      charterSha: sha256('charter'),
      charterMode: 'reference',
      resumeContextText: 'resume text',
      incumbent: { paneKey: PANE_A, terminalHandle: HANDLE_A }
    })
    db.recordLaunch({
      hostId,
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: 'sess-incumbent',
      launchGeneration: runtime.getLaunchGenerationId(),
      executionHostId: 'local',
      evidence: 'host_launch',
      prefs: { model: 'incumbent-model', effort: 'high', source: 'launch' }
    })
    const createSpy = vi.spyOn(runtime, 'createAgentSession').mockResolvedValue({
      terminal: { paneKey: 'tabB:b', handle: 'term_b' }
    } as never)
    const holdPromise = holdSealRequest(deps, hostId, sealedMeta, undefined)
    await launchSuccessor(
      deps,
      hostId,
      {
        name: 'chair-prefs',
        worktree: 'id:wt-1',
        agent: 'claude',
        conversationId: 'sess-orig',
        launchArgs: ['--flag-a', '--flag-b']
      },
      sealedMeta
    )
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: 'id:wt-1',
        agent: 'claude',
        prompt: `orca chairs succession-accept ${sealedMeta.id}`,
        promptDelivery: 'auto-submit',
        appendAgentArgs: '--flag-a --flag-b',
        presentation: 'background',
        launchPreferences: { model: 'incumbent-model', effort: 'high' }
      })
    )
    settleHold(sealedMeta.id, {
      ok: false,
      code: 'succession_aborted',
      successionId: sealedMeta.id,
      reason: 'test_cleanup'
    })
    await holdPromise
  })

  it('aborts on a 150s timeout, closing the successor pane', async () => {
    vi.useFakeTimers()
    const meta = await sealedLaunchingMeta('chair-timeout')
    const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
    await vi.advanceTimersByTimeAsync(150_000)
    const outcome = await holdPromise
    expect(outcome).toMatchObject({ ok: false, code: 'succession_aborted', reason: 'timeout' })
    expect(closeSpy).toHaveBeenCalledWith('term_b')
    const final = await read(storeDeps, 'chair-timeout', meta.id)
    expect(final?.state).toBe('aborted')
    vi.useRealTimers()
  })

  it('aborts when the incumbent connection drops first', async () => {
    const meta = await sealedLaunchingMeta('chair-drop')
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    const controller = new AbortController()
    const holdPromise = holdSealRequest(deps, hostId, meta, controller.signal)
    controller.abort()
    const outcome = await holdPromise
    expect(outcome).toMatchObject({
      ok: false,
      code: 'succession_aborted',
      reason: 'incumbent_dropped'
    })
    const final = await read(storeDeps, 'chair-drop', meta.id)
    expect(final?.state).toBe('aborted')
  })

  // G1 repair N1 (+p7's counterpart drop-while-sealed probe): before the fix, `runAbortTail`
  // treated every state other than `launching` as `already_terminal`, including `sealed` — a
  // drop or timeout while `createAgentSession` is still in flight left the record `sealed`
  // forever, and the launch landed afterwards with NO hold and NO close, wedging the chair.
  it('N1: incumbent drop while the record is still sealed aborts it, and closes the late-landing successor pane', async () => {
    await mkdir(join(tmp, 'chairs'), { recursive: true })
    const meta = await createSealed(storeDeps, 'chair-sealed-drop', {
      reason: 'batch_end',
      checkpointText: VALID_CHECKPOINT,
      checkpointSha: sha256(VALID_CHECKPOINT),
      charterPath: join(tmp, 'CHARTER.md'),
      charterSha: sha256('charter'),
      charterMode: 'reference',
      resumeContextText: 'resume text',
      incumbent: { paneKey: PANE_A, terminalHandle: HANDLE_A }
    })
    let resolveCreate!: (v: unknown) => void
    vi.spyOn(runtime, 'createAgentSession').mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      }) as never
    )
    const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    const controller = new AbortController()
    const holdPromise = holdSealRequest(deps, hostId, meta, controller.signal)
    const launchPromise = launchSuccessor(
      deps,
      hostId,
      {
        name: 'chair-sealed-drop',
        worktree: 'id:wt-1',
        agent: 'claude',
        conversationId: 'sess-orig'
      },
      meta
    )
    // The incumbent's connection drops while createAgentSession is still in flight.
    controller.abort()
    const outcome = await holdPromise
    expect(outcome).toMatchObject({
      ok: false,
      code: 'succession_aborted',
      reason: 'incumbent_dropped'
    })
    const midway = await read(storeDeps, 'chair-sealed-drop', meta.id)
    expect(midway?.state).toBe('aborted')
    // The launch lands only now.
    resolveCreate({ terminal: { paneKey: 'tabB:b', handle: 'term_b' } })
    await launchPromise
    const final = await read(storeDeps, 'chair-sealed-drop', meta.id)
    expect(final?.state).toBe('aborted') // never lands in `launching`
    expect(closeSpy).toHaveBeenCalledWith('term_b')
    const active = await listActive(storeDeps, 'chair-sealed-drop')
    expect(active).toEqual([])
  })

  // p7: a signal already aborted BEFORE the hold registers never fires its 'abort' event (an
  // AbortSignal does not replay past events to a listener added after the fact) — before the
  // fix, the hold stayed live for the full 150s timeout although the incumbent's connection was
  // already gone at registration time.
  it('p7: a pre-aborted signal finishes the hold immediately, not after the 150s timeout', async () => {
    const meta = await sealedLaunchingMeta('chair-preaborted')
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    const controller = new AbortController()
    controller.abort() // already aborted before holdSealRequest is even called
    const holdPromise = holdSealRequest(deps, hostId, meta, controller.signal)
    // No timer advance of any kind — before the fix this never settles without one (the abort
    // event never fires for an already-aborted signal), so this `await` would hang past this
    // test's own timeout.
    const outcome = await holdPromise
    expect(outcome).toMatchObject({
      ok: false,
      code: 'succession_aborted',
      reason: 'incumbent_dropped'
    })
    expect(getHoldRecord(meta.id)).toBeUndefined()
  })

  // G1 attempt-3 repair F10 (probe p1b): a signal already aborted when the hold registers
  // settles the hold via its async abort tail. If `launchSuccessor` runs AFTER that settle has
  // landed (getHoldRecord already undefined), spawning a pane just to close it again a moment
  // later is pure waste — checking the hold before `createAgentSession` avoids the spawn.
  it('F10: launchSuccessor never spawns when the hold already settled (pre-aborted signal)', async () => {
    const meta = await sealedLaunchingMeta('chair-preaborted-launch')
    const controller = new AbortController()
    controller.abort()
    const holdPromise = holdSealRequest(deps, hostId, meta, controller.signal)
    await holdPromise // the async abort tail has now fully settled and cleared the hold.
    expect(getHoldRecord(meta.id)).toBeUndefined()
    const createSpy = vi.spyOn(runtime, 'createAgentSession')
    await launchSuccessor(
      deps,
      hostId,
      {
        name: 'chair-preaborted-launch',
        worktree: 'id:wt-1',
        agent: 'claude',
        conversationId: 'sess-orig'
      },
      meta
    )
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('settleHold releases the hold without running the abort tail once confirm already did', async () => {
    const meta = await sealedLaunchingMeta('chair-confirm-race')
    const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
    settleHold(meta.id, { ok: true, confirmed: true, successionId: meta.id })
    const outcome = await holdPromise
    expect(outcome).toEqual({ ok: true, confirmed: true, successionId: meta.id })
    const final = await read(storeDeps, 'chair-confirm-race', meta.id)
    expect(final?.state).toBe('launching') // confirm itself (not exercised here) would advance it
  })

  // G1 attempt-3 repair (Q8 residual): the abort tail's own audit write throws (a real DB
  // fault, e.g. `transitionLocked` failing before its write, or the write itself), so
  // `runAbortTail` rejects; the `.catch` handler's OWN audit write hits the identical fault.
  // Before this repair, that made the `.catch` handler itself throw, so the `.then` that
  // settles/clears the hold never ran — the hold leaked and the incumbent's `succeed` call
  // never resolved. Real timers, no fake-timer advance: if this hangs, the fault reproduced.
  it('Q8 residual: a throwing abort-tail audit still settles the hold, never leaks it', async () => {
    const meta = await sealedLaunchingMeta('chair-abort-audit-throws')
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    vi.spyOn(db, 'writeAgentAudit').mockImplementation(() => {
      throw new Error('disk full')
    })
    const controller = new AbortController()
    const holdPromise = holdSealRequest(deps, hostId, meta, controller.signal)
    controller.abort()
    const outcome = await Promise.race([
      holdPromise,
      new Promise<'TIMED_OUT'>((resolve) => setTimeout(() => resolve('TIMED_OUT'), 2000))
    ])
    expect(outcome).not.toBe('TIMED_OUT')
    expect(outcome).toMatchObject({ ok: false, code: 'succession_aborted' })
    expect(getHoldRecord(meta.id)).toBeUndefined()
  })
})
