// S10-22b W-D1-DR1: split out of chair-succession-accept.test.ts (line ratchet, that file is at
// ~682 of 800 counted lines) — the F1 fix's own regression coverage: field ordering where the
// exit wait resolves on a SYNTHETIC exit while the daemon still lists the incumbent PTY.
//
// Harness mirrors pty.ts:5839-5870 (kill acks before the process dies, fires a synthetic -1
// exit) and daemon-pty-adapter.ts:1224 (`hasPty` false once killed) — a REAL OrcaRuntimeService
// and OrchestrationDb, nothing in the accept path mocked (closeTerminal/waitForTerminal/
// getAgentDirectoryLivenessSignals/registerAgentForPane all run for real), driven only by a fake
// pty controller + daemon-listing flag. Internals-cast idiom from s10-15-leafless-delivery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OrchestrationDb, type WriteAgentAuditParams } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
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

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const PTY_A = 'pty_incumbent'
const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUCCESSOR_PANE = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SUCCESSOR_HANDLE = 'term_successor'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; tabId?: string; paneKey?: string }
  ) => unknown
  issuePtyHandle: (pty: unknown) => string
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

describe('S10-22b W-D1-DR1: chair-succession-accept, headless exit-wait field ordering', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let tmp: string
  let deps: ChairSuccessionDeps
  const hostId = 'local'
  const daemon = { alive: true, listFails: false, lateOutput: false }
  // G1-10z1 N2: D2's SSH-down shape — the aggregate round (connectionId undefined) rejects while
  // the local round (connectionId null) still answers from the fake daemon.
  const d2 = { sshDown: false }
  let listCalls: string[]
  let HANDLE_A: string
  let auditRows: WriteAgentAuditParams[]

  beforeEach(async () => {
    db = new OrchestrationDb(':memory:')
    tmp = await mkdtemp(join(tmpdir(), 'orca-succession-headless-exit-'))
    daemon.alive = true
    daemon.listFails = false
    daemon.lateOutput = false
    d2.sshDown = false
    listCalls = []
    const session = getDefaultWorkspaceSession()
    runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      }),
      getWorkspaceSession: () => session,
      setWorkspaceSession: () => {},
      getAllWorktreeMeta: () => ({}),
      getRepos: () => []
    } as never)
    runtime.setOrchestrationDb(db)
    // Mirrors pty.ts:5839-5870 (kill acks before the process dies, fires a synthetic -1 exit
    // 5ms later, optionally followed by late output) and daemon-pty-adapter.ts:1224 (hasPty false
    // once killed).
    runtime.setPtyController({
      spawn: async () => ({ id: 'never' }),
      write: () => true,
      kill: (ptyId: string) => {
        setTimeout(() => {
          runtime.onPtyExit(ptyId, -1)
          if (daemon.lateOutput) {
            runtime.onPtyData(ptyId, 'Resume this session with: claude --resume x\r\n', Date.now())
          }
        }, 5)
        return true
      },
      hasPty: () => false,
      getForegroundProcess: async () => null,
      listProcesses: async (connectionId?: string | null) => {
        listCalls.push(connectionId === undefined ? 'aggregate' : 'local')
        if (connectionId === undefined && d2.sshDown) {
          throw new Error('ssh_provider_down')
        }
        if (daemon.listFails) {
          throw new Error('daemon_unreachable')
        }
        return daemon.alive
          ? [{ id: PTY_A, cwd: '/tmp/probe-worktree', worktreeId: WORKTREE_ID }]
          : []
      }
    } as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    HANDLE_A = internals(runtime).issuePtyHandle(
      internals(runtime).recordPtyWorktree(PTY_A, WORKTREE_ID, {
        connected: true,
        tabId: 'tabA',
        paneKey: PANE_A
      })
    )
    deps = {
      db,
      runtime,
      orcaHome: tmp,
      manifestPath: join(tmp, 'chairs.json')
    }
    _resetRetiredHandlesIndexForTest()
    auditRows = []
    const realWriteAgentAudit = db.writeAgentAudit.bind(db)
    vi.spyOn(db, 'writeAgentAudit').mockImplementation((row) => {
      auditRows.push(row)
      return realWriteAgentAudit(row)
    })
  })

  afterEach(async () => {
    db.close()
    await rm(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
    _resetRetiredHandlesIndexForTest()
  })

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

  async function sealedLaunching(chair: string, runId: string) {
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
      runId
    })
    return transition(storeDeps, chair, meta.id, 'launching', {
      successor: {
        paneKey: SUCCESSOR_PANE,
        terminalHandle: SUCCESSOR_HANDLE,
        sessionId: 'sess-succ'
      }
    })
  }

  async function seal(
    chair: string
  ): Promise<{ meta: Awaited<ReturnType<typeof sealedLaunching>>; agentId: string }> {
    const { agentId } = registerChair(chair, PANE_A, HANDLE_A)
    const runId = bindRunTo(PANE_A, HANDLE_A)
    const meta = await sealedLaunching(chair, runId)
    return { meta, agentId }
  }

  function accept(successionId: string) {
    return acceptSuccession(deps, {
      successionId,
      callerPaneKey: SUCCESSOR_PANE,
      callerTerminalHandle: SUCCESSOR_HANDLE,
      callerSessionId: 'sess-succ',
      hostId
    })
  }

  // ---- G1-10z1 B1/N5 helpers: F2's retry loop must clear `registration` between attempts ----
  function nameTakenOnFirstUpsert(
    chair: string,
    then: 'real' | 'throw',
    holderPaneDead = false
  ): { n: number } {
    const realUpsert = db.upsertAgentByPaneSuffix.bind(db)
    const calls = { n: 0 }
    vi.spyOn(db, 'upsertAgentByPaneSuffix').mockImplementation((upsertParams) => {
      calls.n += 1
      if (calls.n === 1) {
        return {
          outcome: 'name_taken',
          alternative: `${chair}-2`,
          livePaneKey: PANE_A,
          liveTerminalHandle: HANDLE_A,
          holderPaneDead
        } as never
      }
      if (then === 'throw') {
        throw new Error('SQLITE_BUSY: database is locked (upsert)')
      }
      return realUpsert(upsertParams)
    })
    return calls
  }
  // The lane's own N2 fault shape: a post-upsert step (the `register` audit) throws AFTER the
  // re-point already committed.
  function throwOnPostUpsertRegisterAudit(): void {
    vi.spyOn(db, 'writeAgentAudit').mockImplementation((row) => {
      auditRows.push(row)
      if (row.verb === 'register' && row.outcome !== 'name_taken') {
        throw new Error('SQLITE_BUSY: database is locked (post-upsert register audit)')
      }
      return OrchestrationDb.prototype.writeAgentAudit.call(db, row)
    })
  }
  async function runAccept(meta: Awaited<ReturnType<typeof sealedLaunching>>, chair: string) {
    const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
    let result: Awaited<ReturnType<typeof accept>> | undefined
    let caught: (Error & { code?: string; data?: { nextSteps?: string[] } }) | undefined
    try {
      result = await accept(meta.id)
    } catch (err) {
      caught = err as never
    }
    const finalMeta = (await read({ orcaHome: tmp }, chair, meta.id)) as
      | { state?: string; abortReason?: string }
      | undefined
    await holdPromise
    return { result, caught, finalMeta }
  }

  it('B1-a: a throw after the upsert committed, following an earlier name_taken, leaves the loop — ACCEPTED with takeoverCommittedDespiteThrow, Run on the successor pane', async () => {
    daemon.alive = false
    const { meta, agentId } = await seal('chair-b1a')
    const upserts = nameTakenOnFirstUpsert('chair-b1a', 'real')
    throwOnPostUpsertRegisterAudit()
    const { result, caught, finalMeta } = await runAccept(meta, 'chair-b1a')
    const row = db.getAgentByName(hostId, 'chair-b1a')
    const runRow = db.getRun(meta.runId as string)
    expect(caught).toBeUndefined()
    expect(result?.agentId).toBe(agentId)
    expect(result?.warnings).toContain('takeoverCommittedDespiteThrow')
    expect(finalMeta?.state).toBe('confirmed')
    expect(row?.pane_key).toBe(SUCCESSOR_PANE)
    expect(runRow?.coordinator_pane_key).toBe(SUCCESSOR_PANE)
    expect(upserts.n).toBe(2)
  }, 25_000)

  it('B1-b: a throwing upsert after an earlier name_taken is not retried — aborts naming the real error', async () => {
    daemon.alive = false
    const { meta } = await seal('chair-b1b')
    const upserts = nameTakenOnFirstUpsert('chair-b1b', 'throw')
    const { caught, finalMeta } = await runAccept(meta, 'chair-b1b')
    expect(caught).toMatchObject({ code: 'succession_takeover_failed' })
    expect(upserts.n).toBe(2)
    expect(finalMeta?.abortReason).toContain('SQLITE_BUSY: database is locked (upsert)')
    expect(finalMeta?.abortReason).not.toContain('name_taken')
  }, 25_000)

  it('N5: a name_taken whose holder is already dead is not retried', async () => {
    daemon.alive = false
    const { meta } = await seal('chair-n5')
    const upserts = nameTakenOnFirstUpsert('chair-n5', 'real', true)
    const start = Date.now()
    const { caught, finalMeta } = await runAccept(meta, 'chair-n5')
    const elapsed = Date.now() - start
    expect(caught).toMatchObject({ code: 'succession_takeover_failed' })
    expect(finalMeta?.abortReason).toContain('name_taken')
    expect(upserts.n).toBe(1)
    expect(elapsed).toBeLessThan(1_000)
  }, 5_000)

  it('T1: field ordering: the exit wait resolves on the synthetic -1 exit while the daemon still lists the incumbent — accept waits for the inventory to drop it, then confirms the same agent id', async () => {
    const { meta, agentId } = await seal('chair-t1')
    setTimeout(() => {
      daemon.alive = false
    }, 1_500)
    void holdSealRequest(deps, hostId, meta, undefined)

    const start = Date.now()
    const result = await accept(meta.id)
    const elapsed = Date.now() - start

    expect(result.agentId).toBe(agentId)
    const row = db.getAgentByName(hostId, 'chair-t1')
    expect(row?.pane_key).toBe(SUCCESSOR_PANE)
    const confirmedMeta = await read({ orcaHome: tmp }, 'chair-t1', meta.id)
    expect(confirmedMeta?.state).toBe('confirmed')
    expect(elapsed).toBeGreaterThanOrEqual(1_400)

    const successorAudits = auditRows.filter(
      (row) => row.actorPaneKey === SUCCESSOR_PANE && row.verb === 'register'
    )
    expect(successorAudits.some((row) => row.outcome === 'name_taken')).toBe(false)
    expect(successorAudits.filter((row) => row.outcome === 'reminted').length).toBe(1)
  }, 20_000)

  it('T2: the daemon lists the incumbent for the whole bound — aborts succession_incumbent_exit_timeout before any takeover; row stays on the incumbent pane; successor never closed', async () => {
    const { meta } = await seal('chair-t2')
    const closeSpy = vi.spyOn(runtime, 'closeTerminal')
    const holdPromise = holdSealRequest(deps, hostId, meta, undefined)

    await expect(accept(meta.id)).rejects.toMatchObject({
      code: 'succession_incumbent_exit_timeout'
    })

    const row = db.getAgentByName(hostId, 'chair-t2')
    expect(row?.pane_key).toBe(PANE_A)
    expect(
      auditRows.some(
        (auditRow) => auditRow.actorPaneKey === SUCCESSOR_PANE && auditRow.verb === 'register'
      )
    ).toBe(false)
    expect(closeSpy).not.toHaveBeenCalledWith(SUCCESSOR_HANDLE)
    const finalMeta = await read({ orcaHome: tmp }, 'chair-t2', meta.id)
    expect(finalMeta?.state).toBe('aborted')
    expect(finalMeta?.abortReason).toBe('incumbent_exit_timeout')
    const holdOutcome = await holdPromise
    expect(holdOutcome).toMatchObject({
      ok: false,
      code: 'succession_aborted',
      reason: 'incumbent_exit_timeout'
    })
  }, 20_000)

  it('T3: controller inventory unavailable — death is never inferred from runtime flags; aborts succession_incumbent_exit_timeout', async () => {
    daemon.listFails = true
    const { meta } = await seal('chair-t3')
    void holdSealRequest(deps, hostId, meta, undefined)

    await expect(accept(meta.id)).rejects.toMatchObject({
      code: 'succession_incumbent_exit_timeout'
    })

    const row = db.getAgentByName(hostId, 'chair-t3')
    expect(row?.pane_key).toBe(PANE_A)
    const finalMeta = await read({ orcaHome: tmp }, 'chair-t3', meta.id)
    expect(finalMeta?.state).toBe('aborted')
    expect(finalMeta?.abortReason).toBe('incumbent_exit_timeout')
  }, 20_000)

  it('T4: control: the daemon already reaped the incumbent when the exit lands — ACCEPTED promptly', async () => {
    daemon.alive = false
    const { meta, agentId } = await seal('chair-t4')
    void holdSealRequest(deps, hostId, meta, undefined)

    const start = Date.now()
    const result = await accept(meta.id)
    const elapsed = Date.now() - start

    expect(result.agentId).toBe(agentId)
    expect(elapsed).toBeLessThan(1_000)
  }, 20_000)

  it('T5: control: late output after the synthetic exit does not block once the daemon has reaped', async () => {
    daemon.alive = false
    daemon.lateOutput = true
    const { meta, agentId } = await seal('chair-t5')
    void holdSealRequest(deps, hostId, meta, undefined)

    const start = Date.now()
    const result = await accept(meta.id)
    const elapsed = Date.now() - start

    expect(result.agentId).toBe(agentId)
    const confirmedMeta = await read({ orcaHome: tmp }, 'chair-t5', meta.id)
    expect(confirmedMeta?.state).toBe('confirmed')
    expect(elapsed).toBeLessThan(1_000)
  }, 20_000)

  // W-D1-DR1 F2 (Q5): a `name_taken` right after a confirmed death is retried, not aborted.
  it('T6: a name_taken right after a confirmed death is retried while the record stays confirming', async () => {
    daemon.alive = false
    const { meta, agentId } = await seal('chair-t6')
    const realUpsert = db.upsertAgentByPaneSuffix.bind(db)
    let attempt = 0
    let metaDuringSecondCall: Promise<Awaited<ReturnType<typeof read>>> | undefined
    vi.spyOn(db, 'upsertAgentByPaneSuffix').mockImplementation((upsertParams) => {
      attempt += 1
      if (attempt === 1) {
        return {
          outcome: 'name_taken',
          alternative: 'chair-t6-2',
          livePaneKey: PANE_A,
          liveTerminalHandle: HANDLE_A,
          holderPaneDead: false
        } as never
      }
      // Taken while the second attempt is in flight, before any post-takeover transition runs —
      // proves the loop makes no transition of its own (the record stays `confirming`).
      metaDuringSecondCall = read({ orcaHome: tmp }, 'chair-t6', meta.id)
      return realUpsert(upsertParams)
    })
    void holdSealRequest(deps, hostId, meta, undefined)

    const result = await accept(meta.id)

    expect(result.agentId).toBe(agentId)
    const finalMeta = await read({ orcaHome: tmp }, 'chair-t6', meta.id)
    expect(finalMeta?.state).toBe('confirmed')
    expect(attempt).toBe(2)
    const capturedDuringRetry = await metaDuringSecondCall
    expect(capturedDuringRetry?.state).toBe('confirming')
  }, 20_000)

  it('T7: persistent name_taken aborts takeover_failed_after_close:name_taken after the bound, with nextSteps naming chairs restore', async () => {
    daemon.alive = false
    const { meta } = await seal('chair-t7')
    vi.spyOn(db, 'upsertAgentByPaneSuffix').mockReturnValue({
      outcome: 'name_taken',
      alternative: 'chair-t7-2',
      livePaneKey: PANE_A,
      liveTerminalHandle: HANDLE_A,
      holderPaneDead: false
    } as never)
    void holdSealRequest(deps, hostId, meta, undefined)

    let caught: unknown
    try {
      await accept(meta.id)
    } catch (err) {
      caught = err
    }

    expect(caught).toMatchObject({ code: 'succession_takeover_failed' })
    const data = (caught as { data?: { nextSteps?: string[] } }).data
    expect(data?.nextSteps?.join(' ')).toContain('orca chairs restore')
    const finalMeta = await read({ orcaHome: tmp }, 'chair-t7', meta.id)
    expect(finalMeta?.state).toBe('aborted')
    expect(finalMeta?.abortReason).toContain('takeover_failed_after_close:name_taken')
  }, 20_000)

  // ---- G1-10z1 N2: promote D2's scoped-inventory probes into the lane ----
  function registerAudits(): string[] {
    return auditRows
      .filter((a) => a.actorPaneKey === SUCCESSOR_PANE && a.verb === 'register')
      .map((a) => a.outcome)
  }
  function injectLateOutputRightBeforeTakeover(): void {
    const realIncarnation = runtime.getTerminalProcessIncarnation.bind(runtime)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementationOnce((handle) => {
      runtime.onPtyData(PTY_A, 'Resume this session with: claude --resume x\r\n', Date.now())
      return realIncarnation(handle)
    })
  }

  it('D2-a: with the aggregate inventory down (one SSH provider unreachable), a local succession still confirms through local-scoped rounds', async () => {
    d2.sshDown = true
    const { meta, agentId } = await seal('chair-d2a')
    setTimeout(() => {
      daemon.alive = false
    }, 1_500)
    const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
    const start = Date.now()
    const result = await accept(meta.id)
    const elapsed = Date.now() - start
    await holdPromise
    expect(result.agentId).toBe(agentId)
    expect(elapsed).toBeGreaterThanOrEqual(1_400)
    expect(registerAudits()).toEqual(['reminted'])
    expect(listCalls).toContain('local')
  }, 25_000)

  it('D2-c: late output after the confirm is absorbed — audit reads name_taken then reminted', async () => {
    d2.sshDown = true
    daemon.alive = false
    const { meta, agentId } = await seal('chair-d2c')
    injectLateOutputRightBeforeTakeover()
    const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
    const result = await accept(meta.id)
    await holdPromise
    expect(result.agentId).toBe(agentId)
    expect(registerAudits()).toEqual(['name_taken', 'reminted'])
  }, 25_000)
})
