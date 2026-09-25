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
    // G1 repair M7: the incumbent's OWN (about-to-retire) handle renders as "Retired handle",
    // never as a bare "Handle:" claiming an identity the successor does not have yet.
    expect(text).toContain(`Retired handle: ${HANDLE_A}`)
    expect(text).not.toMatch(new RegExp(`^Handle: ${HANDLE_A}$`, 'm'))
    expect(text).toContain("see this pane's own ACCEPTED line")
  })

  // G1 repair M8 (D-R215 A9): slice 1 never passes a lane to the successor launch — refuse to
  // seal an incumbent that is itself on a named credential lane rather than silently landing the
  // successor on the default lane instead.
  it('refuses succession_lane_unsupported when the incumbent pane is on a named credential lane', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    vi.spyOn(runtime, 'credentialLaneOfPaneKey').mockReturnValue({
      kind: 'principal',
      principalId: 'someone'
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
    ).rejects.toMatchObject({ code: 'succession_lane_unsupported' })
  })

  // G1 repair L4: an --ack id that names no real outstanding delivery is a caller error.
  it('refuses succession_unknown_ack when --ack names an id with no outstanding delivery', async () => {
    await writeManifest('chair-x')
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
        reason: 'batch_end',
        ack: ['msg_notreal000']
      })
    ).rejects.toMatchObject({ code: 'succession_unknown_ack', data: { ids: ['msg_notreal000'] } })
  })

  // G1 repair M1: the size-checked render happens BEFORE the ack mutation and BEFORE createSealed
  // — a `resume_context_too_large` refusal must leave the outstanding delivery UN-acked and no
  // sealed directory behind (before the fix, both had already happened by the time this fired).
  it('refuses resume_context_too_large before acking delivery or writing a sealed directory', async () => {
    await writeManifest('chair-x', {
      succession: { enabled: true, charterPath: join(tmp, 'CHARTER.md'), charterMode: 'embed' }
    })
    // Embedded (charterMode: 'embed') so the oversized charter is INLINED into the rendered
    // resume context — the checkpoint itself stays well under its own 32 KiB cap, isolating the
    // resume-context size check from the checkpoint's own.
    await writeFile(join(tmp, 'CHARTER.md'), 'x'.repeat(60 * 1024))
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    db.insertMessage({ from: 'someone', to: `agent:${agentId}`, subject: 'hi', type: 'status' })
    const unread = db.getUnreadMessages(`agent:${agentId}`)
    const { delivery } = db.getOrCreateMailboxDelivery({
      mailboxHandle: `agent:${agentId}`,
      messageIds: unread.map((m) => m.id),
      limit: 50
    })!
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
        reason: 'batch_end',
        ack: [delivery.id]
      })
    ).rejects.toMatchObject({ code: 'resume_context_too_large' })
    // The delivery must still be outstanding — the ack mutation never ran.
    expect(db.getOutstandingMailboxDelivery(`agent:${agentId}`)?.id).toBe(delivery.id)
    // No sealed directory was ever written for this chair.
    const active = await listActive({ orcaHome: tmp }, 'chair-x')
    expect(active).toEqual([])
  })

  // G1 repair M2: `sealSuccession` end-to-end (not just `createSealed`'s own unit test) — two
  // concurrent `succeed` calls for the same chair must never both seal.
  it('two concurrent sealSuccession calls for the same chair: exactly one seals, the other refuses succession_in_flight', async () => {
    await writeManifest('chair-x')
    const { agentId } = registerChair('chair-x', PANE_A, HANDLE_A)
    bindRunTo(PANE_A, HANDLE_A)
    const { path, sha } = await writeCheckpoint()
    const sealParams = {
      callerAgentId: agentId,
      chairName: 'chair-x',
      paneKey: PANE_A,
      terminalHandle: HANDLE_A,
      hostId,
      checkpointPath: path,
      checkpointSha256: sha,
      reason: 'batch_end' as const
    }
    const results = await Promise.allSettled([
      sealSuccession(deps, sealParams),
      sealSuccession(deps, sealParams)
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'succession_in_flight'
    })
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
})
