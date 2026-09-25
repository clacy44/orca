// S10-22a G1-10z attempt-4 repair round: split out of chair-succession-accept.test.ts (line
// ratchet) — findings H1, H2, H4, H6 (G1-10z-succession-attacker-attempt4.md) plus the
// pre-existing takeover-failure test they sit beside thematically. Same DB-backed harness (real
// `OrchestrationDb` + real `OrcaRuntimeService`, `createAgentSession`/`closeTerminal`/
// `waitForTerminal` mocked per test) as the parent file, duplicated here per this repo's own
// split convention (chair-succession-hold.test.ts does the same from chair-succession-execute.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { holdSealRequest } from './chair-succession-hold'
import { acceptSuccession } from './chair-succession-accept'
import {
  createSealed,
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

describe('S10-22a G1-10z attempt-4: chair-succession-accept (H1/H2/H4/H6)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let tmp: string
  let deps: ChairSuccessionDeps
  const hostId = 'local'

  beforeEach(async () => {
    db = new OrchestrationDb(':memory:')
    tmp = await mkdtemp(join(tmpdir(), 'orca-succession-accept-g1a4-'))
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

    // H1 (G1-10z attempt-4): the takeover re-points the incumbent's own row onto the successor
    // pane (same id) — it must not count against DIRECTORY_LIVE_CAP even when a registration
    // during the 150s hold window pushed the directory to the cap in the meantime (p11a).
    // Without the register-agent-for-pane.ts fix this rejects with succession_takeover_failed.
    it('H1: a same-name dead-pane takeover succeeds even when the directory reached the cap during the hold window', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      for (let i = 0; i < 199; i += 1) {
        const leaf = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
        registerChair(`filler-${i}`, `tabF${i}:${leaf}`, `term_f${i}`)
      }
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

      expect(result.chair).toBe('chair-x')
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.pane_key).toBe(SUCCESSOR_PANE)
      const confirmedMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(confirmedMeta?.state).toBe('confirmed')
    })

    // H2 (G1-10z attempt-4, probe p10 D): a THROW from the takeover write (not a refused
    // { ok: false }) must hit the same abort/settle/succession_takeover_failed path — the
    // incumbent's pane is already closed by this point either way.
    it('H2: a throw from the takeover write aborts the record and settles the hold, instead of escaping raw', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(db, 'upsertAgentByPaneSuffix').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
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
      ).rejects.toMatchObject({ code: 'succession_takeover_failed' })

      expect(closeSpy).toHaveBeenCalledWith(HANDLE_A)
      expect(closeSpy).not.toHaveBeenCalledWith(SUCCESSOR_HANDLE)
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('aborted')
      expect(finalMeta?.abortReason).toContain('takeover_failed_after_close')

      const holdOutcome = await holdPromise
      expect(holdOutcome).toMatchObject({
        ok: false,
        code: 'succession_aborted',
        reason: 'takeover_failed'
      })
    })

    // N2 (G1-10z polish-recheck, probe P2): a throw from a POST-upsert step inside
    // registerAgentForPane (here, the `register` audit write) arrives AFTER the re-point already
    // committed — the row already sits on the successor pane. This must NOT abort a done
    // takeover; it must continue into the post-takeover steps with a warning.
    it('N2: a throw from a post-upsert step after the takeover already committed continues, not aborts', async () => {
      await writeManifest('chair-x')
      const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      const realAudit = db.writeAgentAudit.bind(db)
      vi.spyOn(db, 'writeAgentAudit').mockImplementation((row) => {
        if (row.verb === 'register' && row.outcome !== 'name_taken') {
          throw new Error('SQLITE_BUSY: database is locked (post-upsert register audit)')
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

      expect(result.chair).toBe('chair-x')
      expect(result.agentId).toBe(agentId)
      expect(result.warnings).toContain('takeoverCommittedDespiteThrow')
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.pane_key).toBe(SUCCESSOR_PANE)
      expect(row?.id).toBe(agentId)
      const confirmedMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(confirmedMeta?.state).toBe('confirmed')
      const run = db.getRun(runId)
      expect(run?.coordinator_pane_key).toBe(SUCCESSOR_PANE)
    })

    // R2-L2 (G1-10z polish-recheck round 2, probe P7b): the post-throw re-read guard must key on
    // a boolean, not the message string — `new Error('')` has an empty message, and
    // `registrationThrowReason && !registration` would then skip the re-read even though a throw
    // did occur, leaving a committed takeover aborted (round-1 N2's end state).
    it('R2-L2: a post-upsert throw with an EMPTY message still reaches the re-read and continues', async () => {
      await writeManifest('chair-x')
      const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      const realAudit = db.writeAgentAudit.bind(db)
      // [G1-10z R2-L2] probe P7b's exact shape: a throw whose message is the EMPTY string — the
      // boolean guard (not the message string) must still route this into the re-read.
      const emptyErrorMessage = ''
      vi.spyOn(db, 'writeAgentAudit').mockImplementation((row) => {
        if (row.verb === 'register' && row.outcome !== 'name_taken') {
          throw new Error(emptyErrorMessage)
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

      expect(result.chair).toBe('chair-x')
      expect(result.agentId).toBe(agentId)
      expect(result.warnings).toContain('takeoverCommittedDespiteThrow')
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.pane_key).toBe(SUCCESSOR_PANE)
      expect(row?.id).toBe(agentId)
      const confirmedMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(confirmedMeta?.state).toBe('confirmed')
    })

    // R2-L3 (G1-10z polish-recheck round 2, probe P7c): the re-read itself can throw (a locked
    // DB) — that must fall through to the abort/settle path below, not escape raw and leave the
    // hold wedged `confirming` forever (the pre-H2 wedge, resurrected one level deeper).
    it('R2-L3: a throw from the post-throw re-read still aborts the record and settles the hold', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(db, 'upsertAgentByPaneSuffix').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })
      const realGetAgentByName = db.getAgentByName.bind(db)
      let getAgentByNameCalls = 0
      vi.spyOn(db, 'getAgentByName').mockImplementation((forHostId, displayName) => {
        getAgentByNameCalls += 1
        // First call is registerAgentForPane's own isSameNameDeadPaneTakeover lookup; the
        // second is the post-throw re-read under test.
        if (getAgentByNameCalls === 2) {
          throw new Error('SQLITE_BUSY: database is locked (re-read)')
        }
        return realGetAgentByName(forHostId, displayName)
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
      ).rejects.toMatchObject({ code: 'succession_takeover_failed' })

      expect(closeSpy).toHaveBeenCalledWith(HANDLE_A)
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('aborted')

      const holdOutcome = await holdPromise
      expect(holdOutcome).toMatchObject({
        ok: false,
        code: 'succession_aborted',
        reason: 'takeover_failed'
      })
    })

    // H6 (G1-10z attempt-4): the takeover-failure audit write used to be unguarded — a throwing
    // audit skipped the settle below it, leaving the record wedged with no hold outcome.
    it('H6: a throwing takeover-failure audit still settles the hold and throws succession_takeover_failed', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) =>
        paneKey === PANE_A
          ? { terminalHandle: HANDLE_A, lastAgentStatus: null, observedLive: true }
          : { terminalHandle: null, lastAgentStatus: null, observedLive: false }
      )
      vi.spyOn(db, 'writeAgentAudit').mockImplementation(() => {
        throw new Error('SQLITE_FULL: database or disk is full')
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
      ).rejects.toMatchObject({ code: 'succession_takeover_failed' })

      const holdOutcome = await holdPromise
      expect(holdOutcome).toMatchObject({
        ok: false,
        code: 'succession_aborted',
        reason: 'takeover_failed'
      })
    })

    // H6 (G1-10z attempt-4): the incumbent_exit_timeout audit write used to be unguarded — a
    // throwing audit skipped the settle below it, leaving the successor with a raw DB error
    // instead of the "stand down" throw it depends on.
    it('H6: a throwing incumbent_exit_timeout audit still settles the hold and throws succession_incumbent_exit_timeout', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('timeout'))
      vi.spyOn(db, 'writeAgentAudit').mockImplementation(() => {
        throw new Error('SQLITE_FULL: database or disk is full')
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

      const holdOutcome = await holdPromise
      expect(holdOutcome).toMatchObject({
        ok: false,
        code: 'succession_aborted',
        reason: 'incumbent_exit_timeout'
      })
    })

    // H6 (G1-10z attempt-4, probe p15c): the `confirmed` audit write used to share the
    // transition's own try block — a throw from JUST the audit (transition itself succeeded)
    // raised the false `confirmTransitionFailed` warning although the record was actually
    // confirmed. Assert the record is confirmed and the warning names the audit, not the
    // transition.
    it('H6: a throwing confirmed-audit write does not report confirmTransitionFailed on a successful transition', async () => {
      await writeManifest('chair-x')
      registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      const realAudit = db.writeAgentAudit.bind(db)
      vi.spyOn(db, 'writeAgentAudit').mockImplementation((row) => {
        if (row.outcome === 'confirmed') {
          throw new Error('SQLITE_FULL: database or disk is full')
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

      expect(result.warnings ?? []).not.toContain('confirmTransitionFailed')
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('confirmed')
    })

    // H4 (G1-10z attempt-4, probe p10 C): the post-confirm outstanding-mailbox/run reads ran
    // unguarded — a DB fault there used to throw raw although the record is already `confirmed`
    // and the chair row already moved. Assert it resolves with a warning instead.
    it('H4: outstanding-delivery read throws after confirm -> accept still resolves with a warning', async () => {
      await writeManifest('chair-x')
      const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(db, 'getOutstandingMailboxDelivery').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
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
      expect(result.warnings).toContain('outstandingDeliveryReadFailed')
      expect(result.obligations.outstandingDeliveryIds).toEqual([])
      const row = db.getAgentByName(hostId, 'chair-x')
      expect(row?.pane_key).toBe(SUCCESSOR_PANE)
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('confirmed')
    })

    // [G1-10z polish-recheck N5 repair] the H4 `getRun` guard was untested — a mutant that
    // rethrows in its catch left every existing suite green (G1-10z-succession-polish-recheck.md
    // (1) table, H4 row). Assert accept still resolves, with `generation: 0` and the warning.
    it('H4: getRun throws after confirm -> accept still resolves with generation 0 and a warning', async () => {
      await writeManifest('chair-x')
      const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
      const runId = bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x', runId)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: HANDLE_A,
        condition: 'exit'
      } as never)
      vi.spyOn(db, 'getRun').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
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
      expect(result.generation).toBe(0)
      expect(result.warnings).toContain('runGenerationReadFailed')
      const finalMeta = await read({ orcaHome: tmp }, 'chair-x', meta.id)
      expect(finalMeta?.state).toBe('confirmed')
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
  })
})
