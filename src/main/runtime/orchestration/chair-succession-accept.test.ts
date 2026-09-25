// S10-22a G1 repair round: split out of chair-succession-execute.test.ts (line ratchet) — the
// accept/confirm half of the DB-backed harness (real `OrchestrationDb` + real
// `OrcaRuntimeService`, `createAgentSession`/`closeTerminal`/`waitForTerminal` mocked per test).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
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
  retiredHandlesPath,
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
    terminalHandle: string,
    role: string | null = null
  ): { agentId: string } {
    const result = db.upsertAgentByPaneSuffix({
      displayName: chairName,
      role,
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

    it('Q8: a confirm triggers the post-confirm purge, trimming an over-cap retired-handles.json', async () => {
      await writeManifest('chair-purge')
      registerChair('chair-purge', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      db.recordLaunch({
        hostId,
        paneKey: SUCCESSOR_PANE,
        agentType: 'claude',
        sessionId: 'sess-purge',
        launchGeneration: runtime.getLaunchGenerationId(),
        executionHostId: 'local',
        evidence: 'host_launch'
      })
      const meta = await sealedLaunching('chair-purge', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      const retiredPath = retiredHandlesPath({ orcaHome: tmp }, 'chair-purge')
      await mkdir(join(tmp, 'chairs', 'chair-purge'), { recursive: true })
      const overCap = Array.from({ length: 60 }, (_, i) => ({
        handle: `stale-handle-${i}`,
        succession: `stale-succession-${i}`,
        at: new Date(0).toISOString()
      }))
      await writeFile(retiredPath, JSON.stringify(overCap, null, 2))
      void holdSealRequest(deps, hostId, meta, undefined)

      await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-purge',
        hostId
      })

      const retired = JSON.parse(await readFile(retiredPath, 'utf8'))
      // 60 seeded + 1 appended by accept = 61, purged down to the 50-entry cap.
      expect(retired.length).toBe(50)
      expect(retired.at(-1)).toMatchObject({ handle: HANDLE_A, succession: meta.id })
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

    // G1 repair N4: a non-`timeout` rejection (e.g. a renderer graph sync dropping the leaf) does
    // NOT by itself prove the incumbent exited — before this fix, accept treated any rejection
    // other than the literal string `timeout` as "exited, proceed", even while the takeover's own
    // liveness predicate still reports the incumbent alive.
    // Real timers deliberately — the liveness poll bound is 10s of REAL Date.now() (accept.ts's
    // own `INCUMBENT_EXIT_TIMEOUT_MS`), and interleaving it with fake timers against a real-I/O
    // async chain (chair-lock, fs reads/writes) is unreliable; this test's own timeout is raised
    // to allow the real ~10s to elapse.
    it('N4: a stale-handle rejection with the incumbent still live aborts exactly like a timeout, never proceeds', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('terminal_handle_stale'))
      // The leaf vanished from the graph, but the runtime's own liveness predicate still
      // reports a connected handle — the PTY never actually exited.
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
        terminalHandle: HANDLE_A,
        lastAgentStatus: 'working',
        observedLive: true
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
      ).rejects.toMatchObject({ code: 'succession_incumbent_exit_timeout' })
      expect(closeSpy).toHaveBeenCalledWith(HANDLE_A)
      expect(closeSpy).not.toHaveBeenCalledWith(SUCCESSOR_HANDLE)
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('aborted')
      expect(finalMeta?.abortReason).toBe('incumbent_exit_timeout')
      await holdPromise
    }, 15_000)

    // Positive control for N4: a stale-handle rejection where the liveness predicate DOES confirm
    // the incumbent is gone must still proceed with the takeover (not every non-timeout rejection
    // is now treated as a failure).
    it('N4: a stale-handle rejection confirmed dead by the liveness predicate still proceeds with the takeover', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('terminal_handle_stale'))
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
        terminalHandle: null,
        lastAgentStatus: null,
        observedLive: false
      })
      void holdSealRequest(deps, hostId, meta, undefined)
      const result = await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-succ',
        hostId
      })
      expect(result.chair).toBe('chair-x')
    })

    // G1 repair N7: steps after the takeover (bindRun, retired-handle append, the `confirmed`
    // transition, the post-confirm purge) must never throw past the caller — the identity has
    // already moved. Before this fix, a `bindRun` throw (consumer_fenced/legacy_read_only)
    // propagated straight out of `acceptSuccession`, leaving the record stuck `confirming` and
    // the new chair with an error instead of ACCEPTED.
    it('N7: a bindRun failure after the takeover is swallowed into a warning, not thrown — still ACCEPTED', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(db, 'bindRun').mockImplementation(() => {
        throw new Error('consumer_fenced')
      })
      void holdSealRequest(deps, hostId, meta, undefined)
      const result = await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-succ',
        hostId
      })
      expect(result.chair).toBe('chair-x')
      expect(result.warnings).toContain('runBindFailed')
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('confirmed')
    })

    // G1 repair N15: the manifest is not the only role source — a chair whose role exists only on
    // its (incumbent) agents row must not lose it just because the manifest never set one.
    it('N15: a role present only on the incumbent agents row survives the takeover when the manifest sets none', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A, 'facilitator')
      const runId = bindRunTo(PANE_A, HANDLE_A)
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

    // G1 repair N16: a manifest write failure must surface to the caller, not just an audit row —
    // silence here left the next reboot's `chairs restore` resuming the pre-succession session.
    it('N16: a manifest write failure surfaces as manifestWriteFailed + a warning, still ACCEPTED', async () => {
      // A SEPARATE, chmod'd-read-only directory for the manifest — isolates the failure to the
      // manifest write alone; `tmp` (orcaHome) stays writable so the confirm transition and
      // retired-handle append (also under `tmp`) can still land normally.
      const manifestDir = await mkdtemp(join(tmpdir(), 'orca-succession-manifest-ro-'))
      const manifestPath = join(manifestDir, 'chairs.json')
      await writeFile(join(tmp, 'CHARTER.md'), 'the charter\n')
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          chairs: [
            {
              name: 'chair-x',
              worktree: 'id:wt-1',
              agent: 'claude',
              conversationId: 'sess-orig',
              succession: { enabled: true, charterPath: join(tmp, 'CHARTER.md') }
            }
          ]
        })
      )
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      deps.manifestPath = manifestPath
      await chmod(manifestDir, 0o500) // read+execute only — writeFileAtomic's tmp-write cannot land
      try {
        void holdSealRequest(deps, hostId, meta, undefined)
        const result = await acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: SUCCESSOR_PANE,
          callerTerminalHandle: SUCCESSOR_HANDLE,
          callerSessionId: 'sess-succ',
          hostId
        })
        expect(result.manifestWriteFailed).toBe(true)
        expect(result.warnings).toContain('manifestWriteFailed')
        const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
        expect(finalMeta?.state).toBe('confirmed')
      } finally {
        await chmod(manifestDir, 0o700)
        await rm(manifestDir, { recursive: true, force: true })
      }
    })

    // G1 attempt-3 repair F5 (probe p10 A): the failure-audit helper itself was unguarded — a DB
    // fault that fails bindRun (e.g. SQLITE_BUSY) can fail the SAME audit write, and accept used
    // to throw after the identity already moved (the chair row is on the successor pane). Assert
    // it never throws past the takeover: the caller gets an ACCEPTED-shaped result with a warning.
    it('F5: bindRun AND its failure audit both fail -> accept still resolves, never throws after the takeover', async () => {
      await writeManifest('chair-x')
      const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(db, 'bindRun').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })
      const realAudit = db.writeAgentAudit.bind(db)
      vi.spyOn(db, 'writeAgentAudit').mockImplementation((row) => {
        if (row.outcome === 'run_bind_failed') {
          throw new Error('SQLITE_BUSY: database is locked')
        }
        return realAudit(row)
      })
      void holdSealRequest(deps, hostId, meta, undefined)
      const result = await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-succ',
        hostId
      })
      expect(result.agentId).toBe(agentId)
      expect(result.warnings).toContain('runBindFailed')
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.pane_key).toBe(SUCCESSOR_PANE)
    })

    // G1 attempt-3 repair F5 (probe p10 B): accept's final resume-context.md read ran unguarded
    // AFTER `confirmed` — an I/O fault there used to reject accept although the takeover already
    // committed. Assert it resolves instead, with a warning and no `resumeContext`.
    it('F5: resume-context.md unreadable after confirm -> accept still resolves although confirmed', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      await rm(join(tmp, 'chairs', 'chair-x', 'successions', meta.id, 'resume-context.md'))
      void holdSealRequest(deps, hostId, meta, undefined)
      const result = await acceptSuccession(deps, {
        successionId: meta.id,
        callerPaneKey: SUCCESSOR_PANE,
        callerTerminalHandle: SUCCESSOR_HANDLE,
        callerSessionId: 'sess-succ',
        hostId
      })
      expect(result.resumeContext).toBeUndefined()
      expect(result.warnings).toContain('resumeContextReadFailed')
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('confirmed')
    })

    // G1 attempt-3 repair F8 (probe p11b): `writeManifestLastSessionId` used to return silently
    // for a null caller session id — ACCEPTED with no `manifestWriteFailed` flag and no warning,
    // and restore then fell back to the manifest's `conversationId`. Assert the flag + warning are
    // now set, and the manifest is left untouched (never written a literal null/undefined).
    it('F8: a null caller session id sets manifestWriteFailed + a warning, manifest untouched', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
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
        callerSessionId: null,
        hostId
      })
      expect(result.manifestWriteFailed).toBe(true)
      expect(result.warnings).toContain('manifestWriteFailed')
      const manifest = JSON.parse(await readFile(deps.manifestPath!, 'utf8'))
      expect(manifest.chairs[0].lastSessionId).toBeUndefined()
    })
  })
})
