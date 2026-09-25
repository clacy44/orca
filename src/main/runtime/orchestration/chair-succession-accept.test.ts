// S10-22a G1 repair round: split out of chair-succession-execute.test.ts (line ratchet) — the
// accept/confirm half of the DB-backed harness (real `OrchestrationDb` + real
// `OrcaRuntimeService`, `createAgentSession`/`closeTerminal`/`waitForTerminal` mocked per test).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { holdSealRequest, settleHold, runAbortTail, getHoldRecord } from './chair-succession-hold'
import { acceptSuccession } from './chair-succession-accept'
import {
  createSealed,
  transition,
  read,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import {
  retiredHandleChair,
  _resetRetiredHandlesIndexForTest
} from './chair-succession-retired-index'

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

describe('S10-22a WAVE 2: chair-succession-accept', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let tmp: string
  let deps: ChairSuccessionDeps
  const hostId = 'local'

  beforeEach(async () => {
    db = new OrchestrationDb(':memory:')
    tmp = await mkdtemp(join(tmpdir(), 'orca-succession-accept-'))
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

  async function writeManifest(
    chairName: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await writeFile(
      deps.manifestPath!,
      JSON.stringify({
        version: 1,
        chairs: [
          {
            name: chairName,
            worktree: 'id:wt-1',
            agent: 'claude',
            conversationId: 'sess-orig',
            succession: { enabled: true, charterPath: join(tmp, 'CHARTER.md') },
            ...extra
          }
        ]
      })
    )
    await writeFile(join(tmp, 'CHARTER.md'), 'the charter\n')
  }

  function registerChair(
    chairName: string,
    paneKey: string,
    terminalHandle: string
  ): { agentId: string } {
    const result = db.upsertAgentByPaneSuffix({
      displayName: chairName,
      role: null,
      hostId,
      paneKey,
      terminalHandle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: terminalHandle,
      originHostId: hostId,
      isPaneLive: () => false
    })
    if (result.outcome === 'name_taken') {
      throw new Error('unexpected name_taken in test setup')
    }
    return { agentId: result.agent.id }
  }

  function bindRunTo(paneKey: string, handle: string): string {
    const run = db.createRun({
      objective: 'ship it',
      coordinatorHandle: handle,
      coordinatorPaneKey: paneKey
    })
    return run.id
  }

  const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const HANDLE_A = 'term_a'

  describe('accept / confirm', () => {
    const SUCCESSOR_PANE = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const SUCCESSOR_HANDLE = 'term_b'

    async function sealedLaunching(chair: string, runId?: string) {
      const storeDeps: ChairSuccessionStoreDeps = { orcaHome: tmp }
      await mkdir(join(tmp, 'chairs'), { recursive: true })
      const meta = await createSealed(storeDeps, chair, {
        reason: 'batch_end',
        checkpointText: VALID_CHECKPOINT,
        checkpointSha: sha256(VALID_CHECKPOINT),
        charterPath: join(tmp, 'CHARTER.md'),
        charterSha: sha256('charter'),
        charterMode: 'reference',
        resumeContextText: 'resume text for the successor',
        incumbent: { paneKey: PANE_A, terminalHandle: HANDLE_A },
        ...(runId ? { runId } : {})
      })
      return transition(storeDeps, chair, meta.id, 'launching', {
        successor: {
          paneKey: SUCCESSOR_PANE,
          terminalHandle: SUCCESSOR_HANDLE,
          sessionId: 'sess-succ'
        }
      })
    }

    it('confirms: same agent id, Run rebound, waiters cancelled, retired handle recorded, manifest written', async () => {
      await writeManifest('chair-x')
      const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      db.recordLaunch({
        hostId,
        paneKey: SUCCESSOR_PANE,
        agentType: 'claude',
        sessionId: 'sess-succ',
        launchGeneration: runtime.getLaunchGenerationId(),
        executionHostId: 'local',
        evidence: 'host_launch'
      })
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      const cancelSpy = vi.spyOn(runtime, 'cancelMessageWaiters')
      // G1 repair B5: accept now trusts ONLY the in-process hold for incumbent identity — a live
      // hold must exist before `acceptSuccession` will act at all.
      void holdSealRequest(deps, hostId, meta, undefined)

      const result = await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-succ',
        hostId
      })

      expect(result.agentId).toBe(agentId)
      expect(result.chair).toBe('chair-x')
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.id).toBe(agentId)
      expect(row?.pane_key).toBe(SUCCESSOR_PANE)
      const run = db.getRun(runId)
      expect(run?.coordinator_pane_key).toBe(SUCCESSOR_PANE)
      expect(cancelSpy).toHaveBeenCalledWith(`run:${runId}`)
      const retired = JSON.parse(
        await readFile(join(tmp, 'chairs', 'chair-x', 'retired-handles.json'), 'utf8')
      )
      expect(retired.at(-1)).toMatchObject({ handle: HANDLE_A, succession: meta.id })
      const confirmedMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(confirmedMeta?.state).toBe('confirmed')
      const manifest = JSON.parse(await readFile(deps.manifestPath!, 'utf8'))
      expect(manifest.chairs[0].lastSessionId).toBe('sess-succ')
      // Item 1: retired-handle index refreshed synchronously by accept, no restart needed.
      expect(retiredHandleChair(HANDLE_A)).toBe('chair-x')
      // R238: obligations reflect meta/db truthfully rather than the old `{}` placeholder.
      expect(result.obligations).toEqual({
        ackedDeliveryIds: [],
        outstandingDeliveryIds: [],
        retiredHandle: HANDLE_A,
        pendingPeerQuestionThreadIds: [],
        pactTurnsHeld: 0
      })
    })

    it('chair review fix #3: takeover failure after the incumbent is closed aborts the record and leaves the successor pane open', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      // Force `registerAgentForPane`'s takeover to fail: report the INCUMBENT's own pane as
      // still live (its `closeTerminal` above is mocked, not a real kill), so
      // `upsertAgentByPaneSuffix` refuses `name_taken` with `holderPaneDead: false` instead of
      // reminting.
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) =>
        paneKey === PANE_A
          ? { terminalHandle: HANDLE_A, lastAgentStatus: null, observedLive: true }
          : { terminalHandle: null, lastAgentStatus: null, observedLive: false }
      )
      // Registered as if `succeed`'s RPC call were still holding open, exactly as it is for real
      // during the accept window — proves `settleHold` actually reaches it (not a no-op).
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)

      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_takeover_failed' })

      // The incumbent's own closeTerminal WAS still called (Act order unchanged)...
      expect(closeSpy).toHaveBeenCalledWith(HANDLE_A)
      // ...but the successor pane must NEVER be closed on this path — that would strand both.
      expect(closeSpy).not.toHaveBeenCalledWith(SUCCESSOR_HANDLE)
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('aborted')
      expect(finalMeta?.abortReason).toContain('takeover_failed_after_close')

      // The hold must have settled with reason takeover_failed directly — no 150s timeout needed.
      const holdOutcome = await holdPromise
      expect(holdOutcome).toMatchObject({
        ok: false,
        code: 'succession_aborted',
        reason: 'takeover_failed'
      })
    })

    it('refuses accept from the wrong pane', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: 'tabC:wrong-pane',
          callerTerminalHandle: 'term_wrong',
          callerSessionId: 'sess-wrong',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_wrong_pane' })
      settleHold(meta.id, {
        ok: false,
        code: 'succession_aborted',
        successionId: meta.id,
        reason: 'test_cleanup'
      })
      await holdPromise
    })

    it('refuses accept for an unknown succession id', async () => {
      await expect(
        acceptSuccession(deps, {
          successionId: 'succ_doesnotexist',
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_unknown' })
    })

    // G1 repair M6: the manifest's `role` must survive the dead-pane takeover.
    it('passes the manifest role through the takeover, not undefined', async () => {
      await writeManifest('chair-x', { role: 'facilitator' })
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      db.recordLaunch({
        hostId,
        paneKey: SUCCESSOR_PANE,
        agentType: 'claude',
        sessionId: 'sess-succ',
        launchGeneration: runtime.getLaunchGenerationId(),
        executionHostId: 'local',
        evidence: 'host_launch'
      })
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      void holdSealRequest(deps, hostId, meta, undefined)
      const result = await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-succ',
        hostId
      })
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.id).toBe(result.agentId)
      expect(row?.role).toBe('facilitator')
    })

    // G1 repair L3: the incumbent no longer holding the Run it sealed with (e.g. some other pane
    // rebound it in the window between seal and accept) must refuse, not silently rebind again.
    it('refuses succession_run_moved when the incumbent no longer holds the sealed Run', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      // The Run moved off the incumbent's pane before accept ever ran.
      db.bindRun({
        runId,
        coordinatorHandle: 'term_elsewhere',
        coordinatorPaneKey: 'tabZ:elsewhere'
      })
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_run_moved' })
      // Refused BEFORE any mutation — the record is still `launching`, the hold still live.
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('launching')
      expect(getHoldRecord(meta.id)).toBeDefined()
      settleHold(meta.id, {
        ok: false,
        code: 'succession_aborted',
        successionId: meta.id,
        reason: 'test_cleanup'
      })
      await holdPromise
    })

    it('refuses succession_expired once the launching window has passed', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      // Backdate createdAt directly on disk — `transition()`'s patch has no createdAt slot (by
      // design: createdAt is immutable after createSealed).
      const metaPath = join(tmp, 'chairs', 'chair-x', 'successions', meta.id, 'meta.json')
      const raw = JSON.parse(await readFile(metaPath, 'utf8'))
      raw.createdAt = new Date(Date.now() - 200_000).toISOString()
      await writeFile(metaPath, JSON.stringify(raw, null, 2))
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_expired' })
      settleHold(meta.id, {
        ok: false,
        code: 'succession_aborted',
        successionId: meta.id,
        reason: 'test_cleanup'
      })
      await holdPromise
    })

    // G1 repair B3: the abort tail winning the chair lock first must leave `accept` refusing
    // cleanly (`succession_not_launching`), never racing to close the same panes twice.
    it('B3: accept after the abort tail already ran refuses succession_not_launching, closes nothing twice', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
      // Simulates the hold's own timeout/drop path firing first and winning the chair lock.
      await runAbortTail(deps, hostId, 'chair-x', meta.id, 'incumbent_dropped')
      expect(closeSpy).toHaveBeenCalledWith(SUCCESSOR_HANDLE)
      closeSpy.mockClear()
      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_not_launching' })
      // Accept must never close ANYTHING once the tail already won — both panes are already dealt
      // with by the tail alone.
      expect(closeSpy).not.toHaveBeenCalled()
      settleHold(meta.id, {
        ok: false,
        code: 'succession_aborted',
        successionId: meta.id,
        reason: 'test_cleanup'
      })
      await holdPromise
    })

    // G1 repair B3: the reverse interleaving — the tail firing once accept has already moved the
    // record to `confirming` must be a pure no-op (`already_terminal`), never close the successor
    // accept is about to use.
    it('B3: the abort tail firing once a record is confirming is a no-op, closes nothing', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      await transition({ orcaHome: tmp }, 'chair-x', meta.id, 'confirming')
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      const outcome = await runAbortTail(deps, hostId, 'chair-x', meta.id, 'incumbent_dropped')
      expect(outcome).toMatchObject({ reason: 'already_terminal' })
      expect(closeSpy).not.toHaveBeenCalled()
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('confirming')
    })

    // G1 repair B6: `closeTerminal` returning does not mean the PTY has actually exited — bound
    // wait, abort loudly on timeout, and NEVER report success with a possibly-still-live
    // incumbent. The successor pane is left open (never closed) for manual recovery.
    it('B6: aborts loudly on succession_incumbent_exit_timeout when the incumbent never exits, leaving the successor pane open', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('timeout'))
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_incumbent_exit_timeout' })
      expect(closeSpy).toHaveBeenCalledWith(HANDLE_A)
      expect(closeSpy).not.toHaveBeenCalledWith(SUCCESSOR_HANDLE)
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('aborted')
      expect(finalMeta?.abortReason).toBe('incumbent_exit_timeout')
      const holdOutcome = await holdPromise
      expect(holdOutcome).toMatchObject({
        ok: false,
        code: 'succession_aborted',
        reason: 'incumbent_exit_timeout'
      })
    })
  })
})
