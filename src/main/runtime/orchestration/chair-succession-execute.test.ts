// S10-22a WAVE 2: DB-backed execute tests against a real `OrchestrationDb` (chairs-restore-
// e2e.test.ts's own harness shape) + a real `OrcaRuntimeService` with `createAgentSession`
// mocked out — seal doesn't await launch, so these exercise the real seal validations, the real
// hold/abort timers, and the real confirm tail (`registerAgentForPane`, `bindRun`, waiter
// cancel, retired-handle append, manifest write) without needing a real spawned pty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { sealSuccession, type ChairSuccessionDeps } from './chair-succession-execute'
import { holdSealRequest, settleHold, launchSuccessor } from './chair-succession-hold'
import { acceptSuccession } from './chair-succession-accept'
import {
  createSealed,
  transition,
  read,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import { _resetResumeContextServedForTest } from './chair-succession-resume-context'
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

describe('S10-22a WAVE 2: chair-succession-execute', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let tmp: string
  let deps: ChairSuccessionDeps
  const hostId = 'local'

  beforeEach(async () => {
    db = new OrchestrationDb(':memory:')
    tmp = await mkdtemp(join(tmpdir(), 'orca-succession-exec-'))
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
    _resetResumeContextServedForTest()
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

  async function writeCheckpoint(): Promise<{ path: string; sha: string }> {
    const path = join(tmp, 'checkpoint.md')
    await writeFile(path, VALID_CHECKPOINT)
    return { path, sha: sha256(VALID_CHECKPOINT) }
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

  function rawDb(): { prepare: (s: string) => { run: (...a: unknown[]) => void } } {
    return (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db
  }

  function insertDispatchedTask(runId: string, status: 'dispatched' | 'completed'): void {
    const task = db.createTask({ spec: 'do the thing', runId })
    rawDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task.id)
    rawDb()
      .prepare(
        `INSERT INTO dispatch_contexts (id, run_id, task_id, assignee_handle, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(`disp_${task.id}`, runId, task.id, 'agent:worker-1', status)
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

  it('refuses succession_not_a_chair when the manifest has no matching entry', async () => {
    await writeManifest('someone-else')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    const { path, sha } = await writeCheckpoint()
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: path,
        checkpointSha256: sha,
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'succession_not_a_chair' })
  })

  it('refuses succession_no_run when no Run is bound to the pane', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    const { path, sha } = await writeCheckpoint()
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: path,
        checkpointSha256: sha,
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'succession_no_run' })
  })

  it('refuses succession_legacy_run for a legacy-bound Run', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    const runId = bindRunTo(PANE_A, HANDLE_A)
    rawDb().prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(runId)
    const { path, sha } = await writeCheckpoint()
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: path,
        checkpointSha256: sha,
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'succession_legacy_run' })
  })

  it('refuses succession_charter_missing when the manifest has no succession config', async () => {
    await writeFile(
      deps.manifestPath!,
      JSON.stringify({
        version: 1,
        chairs: [
          { name: 'chair-x', worktree: 'id:wt-1', agent: 'claude', conversationId: 'sess-orig' }
        ]
      })
    )
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    const { path, sha } = await writeCheckpoint()
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: path,
        checkpointSha256: sha,
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'succession_charter_missing' })
  })

  it('chair review fix #2: a Run with only a completed dispatched task seals (not refused forever)', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    const runId = bindRunTo(PANE_A, HANDLE_A)
    insertDispatchedTask(runId, 'completed')
    const { path, sha } = await writeCheckpoint()
    const { meta } = await sealSuccession(deps, {
      callerAgentId: agentId,
      chairName: 'chair-x',
      paneKey: PANE_A,
      terminalHandle: HANDLE_A,
      hostId,
      checkpointPath: path,
      checkpointSha256: sha,
      reason: 'batch_end'
    })
    expect(meta.state).toBe('sealed')
  })

  it('chair review fix #2: a Run with a still-dispatched, unfinished task refuses succession_active_dispatch', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    const runId = bindRunTo(PANE_A, HANDLE_A)
    insertDispatchedTask(runId, 'dispatched')
    const { path, sha } = await writeCheckpoint()
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: path,
        checkpointSha256: sha,
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'succession_active_dispatch' })
  })

  it('passes checkpoint validator refusals through with the code and line', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    const badPath = join(tmp, 'bad-checkpoint.md')
    await writeFile(badPath, 'not the schema line\n')
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: badPath,
        checkpointSha256: sha256('not the schema line\n'),
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'checkpoint_schema' })
  })

  it('refuses succession_unacked_delivery when an outstanding delivery is not covered by --ack', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    db.insertMessage({
      from: 'someone',
      to: `agent:${agentId}`,
      subject: 'hi',
      type: 'status'
    })
    const unread = db.getUnreadMessages(`agent:${agentId}`)
    db.getOrCreateMailboxDelivery({
      mailboxHandle: `agent:${agentId}`,
      messageIds: unread.map((m) => m.id),
      limit: 50
    })
    const { path, sha } = await writeCheckpoint()
    await expect(
      sealSuccession(deps, {
        callerAgentId: agentId,
        chairName: 'chair-x',
        paneKey: PANE_A,
        terminalHandle: HANDLE_A,
        hostId,
        checkpointPath: path,
        checkpointSha256: sha,
        reason: 'batch_end'
      })
    ).rejects.toMatchObject({ code: 'succession_unacked_delivery' })
  })

  it('chair review fix #4: seal is read-only on delivery — unread mail with no minted delivery does not mint one and seals', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    const runId = bindRunTo(PANE_A, HANDLE_A)
    // Unread mail exists, but nothing has minted a delivery for it yet — the pre-fix
    // `getOrCreateMailboxDelivery`/`getOrCreateRunDelivery` pair would mint one right here as a
    // side effect of merely checking.
    db.insertMessage({ from: 'someone', to: `agent:${agentId}`, subject: 'hi', type: 'status' })
    db.insertMessage({ from: 'someone', to: `run:${runId}`, subject: 'hi', type: 'status', runId })
    expect(db.getOutstandingMailboxDelivery(`agent:${agentId}`)).toBeUndefined()
    expect(db.getOutstandingRunDelivery(runId)).toBeUndefined()
    const { path, sha } = await writeCheckpoint()
    const { meta } = await sealSuccession(deps, {
      callerAgentId: agentId,
      chairName: 'chair-x',
      paneKey: PANE_A,
      terminalHandle: HANDLE_A,
      hostId,
      checkpointPath: path,
      checkpointSha256: sha,
      reason: 'batch_end'
    })
    expect(meta.state).toBe('sealed')
    // Still no minted delivery afterward — seal never called the minting pair.
    expect(db.getOutstandingMailboxDelivery(`agent:${agentId}`)).toBeUndefined()
    expect(db.getOutstandingRunDelivery(runId)).toBeUndefined()
  })

  it('seals successfully, writing a sealed directory with the rendered resume context, and does not launch', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    const createSpy = vi.spyOn(runtime, 'createAgentSession')
    const { path, sha } = await writeCheckpoint()
    const { meta } = await sealSuccession(deps, {
      callerAgentId: agentId,
      chairName: 'chair-x',
      paneKey: PANE_A,
      terminalHandle: HANDLE_A,
      hostId,
      checkpointPath: path,
      checkpointSha256: sha,
      reason: 'batch_end'
    })
    expect(meta.state).toBe('sealed')
    // Chair review fix #1: sealSuccession itself must never launch (the RPC caller registers the
    // hold first, then launches) — asserted here directly rather than only at the RPC layer.
    expect(createSpy).not.toHaveBeenCalled()
    const text = await readFile(
      join(tmp, 'chairs', 'chair-x', 'successions', meta.id, 'resume-context.md'),
      'utf8'
    )
    expect(text).toContain(`# SUCCESSION CONTEXT ${meta.id}`)
    expect(text).toContain(`END SUCCESSION CONTEXT ${sha}`)
    expect(text).toContain('## Run binding')
    expect(text).toContain('## Obligations')
    expect(text).toContain('## Board')
  })

  describe('hold / abort', () => {
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
      vi.spyOn(runtime, 'createAgentSession').mockRejectedValue(
        new Error('spawn failed immediately')
      )
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

    it('settleHold releases the hold without running the abort tail once confirm already did', async () => {
      const meta = await sealedLaunchingMeta('chair-confirm-race')
      const holdPromise = holdSealRequest(deps, hostId, meta, undefined)
      settleHold(meta.id, { ok: true, confirmed: true, successionId: meta.id })
      const outcome = await holdPromise
      expect(outcome).toEqual({ ok: true, confirmed: true, successionId: meta.id })
      const final = await read(storeDeps, 'chair-confirm-race', meta.id)
      expect(final?.state).toBe('launching') // confirm itself (not exercised here) would advance it
    })
  })

  describe('accept / confirm', () => {
    const SUCCESSOR_PANE = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const SUCCESSOR_HANDLE = 'term_b'

    async function sealedLaunching(chair: string) {
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
        incumbent: { paneKey: PANE_A, terminalHandle: HANDLE_A }
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
      const meta = await sealedLaunching('chair-x')
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
      const cancelSpy = vi.spyOn(runtime, 'cancelMessageWaiters')

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
      bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x')
      const closeSpy = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
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
      bindRunTo(PANE_A, HANDLE_A)
      const meta = await sealedLaunching('chair-x')
      await expect(
        acceptSuccession(deps, {
          successionId: meta.id,
          callerPaneKey: 'tabC:wrong-pane',
          callerTerminalHandle: 'term_wrong',
          callerSessionId: 'sess-wrong',
          hostId
        })
      ).rejects.toMatchObject({ code: 'succession_wrong_pane' })
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
  })
})
