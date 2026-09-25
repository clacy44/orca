// S10-22a WAVE 2 (Wave 2 contract "Startup scan (A10)"; D-R215 §Protocol step 9). Real
// OrchestrationDb + mkdtemp ORCA_HOME per branch. [G1-10z M4 repair, chair ruling] a
// `launching`/`confirming` record whose chair agents row already sits on the successor pane is
// confirmed (record + manifest) under the lock — never left as an unconfirmable orphan; otherwise
// the successor pane is closed and the record aborted. Never launches anything either way.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import {
  createSealed,
  read,
  transition,
  transitionLocked,
  chairLockKey,
  withPaneLock,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import {
  scanSuccessionsAtStartup,
  type SuccessionStartupScanDb,
  type SuccessionStartupScanRuntime
} from './chair-succession-startup-scan'

let tempDir: string
let storeDeps: ChairSuccessionStoreDeps
let db: OrchestrationDb

function sealedInput() {
  return {
    reason: 'batch_end' as const,
    checkpointText: 'schema: orca.chair-checkpoint/1\n',
    checkpointSha: 'a'.repeat(64),
    charterPath: '/repo/CHARTER.md',
    charterSha: 'b'.repeat(64),
    charterMode: 'reference' as const,
    resumeContextText: '# SUCCESSION CONTEXT succ_test\n',
    incumbent: {
      paneKey: 'pane-incumbent',
      terminalHandle: 'handle-incumbent',
      sessionId: 'sess-1'
    }
  }
}

function fakeRuntime(overrides: {
  live?: Set<string>
  closed?: string[]
  cancelledWaiters?: string[]
}): SuccessionStartupScanRuntime {
  const live = overrides.live ?? new Set<string>()
  const closed = overrides.closed ?? []
  const cancelledWaiters = overrides.cancelledWaiters ?? []
  return {
    getAgentDirectoryLivenessSignals: (paneKey: string) => ({
      terminalHandle: live.has(paneKey) ? `handle:${paneKey}` : null,
      observedLive: false
    }),
    closeTerminal: async (handle: string) => {
      closed.push(handle)
      return { closed: true } as never
    },
    cancelMessageWaiters: (handle: string) => {
      cancelledWaiters.push(handle)
    }
  } as unknown as SuccessionStartupScanRuntime
}

function dbFacade(): SuccessionStartupScanDb {
  return {
    getAgentByName: (hostId, name) => db.getAgentByName(hostId, name),
    bindRun: (params) => db.bindRun(params),
    getRun: (id) => db.getRun(id),
    writeAgentAudit: (row) => db.writeAgentAudit(row)
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-succession-startup-scan-'))
  storeDeps = { orcaHome: tempDir }
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  db.close()
})

describe('scanSuccessionsAtStartup', () => {
  it('sealed -> aborted (reason startup); never launches (agent directory stays empty)', async () => {
    const meta = await createSealed(storeDeps, 'chair-sealed', sealedInput())
    const runtime = fakeRuntime({})

    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-sealed', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
    expect(db.listAgents({ hostId: 'local' }).agents).toEqual([])
  })

  it('M4: launching, chair agents row already on the successor pane -> confirmed (record + manifest) under the lock, no close', async () => {
    const meta = await createSealed(storeDeps, 'chair-already-taken-over', sealedInput())
    await transition(storeDeps, 'chair-already-taken-over', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    // The dead-pane takeover already committed before the crash: the chair's agents row already
    // sits on the successor pane (same shape registerAgentForPane leaves).
    const registered = db.upsertAgentByPaneSuffix({
      displayName: 'chair-already-taken-over',
      role: null,
      hostId: 'local',
      paneKey: 'pane-successor',
      terminalHandle: 'handle-successor',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'handle-successor',
      originHostId: 'local'
    })
    if (registered.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }

    const manifestPath = join(tempDir, 'chairs.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        chairs: [
          {
            name: 'chair-already-taken-over',
            worktree: '/repo',
            agent: 'claude',
            conversationId: 'conv-1',
            lastSessionId: 'sess-old'
          }
        ]
      })
    )

    const closed: string[] = []
    const runtime = fakeRuntime({ live: new Set(['pane-successor']), closed })

    await scanSuccessionsAtStartup({
      runtime,
      db: dbFacade(),
      orcaHome: tempDir,
      manifestPath
    })

    const after = await read(storeDeps, 'chair-already-taken-over', meta.id)
    expect(after?.state).toBe('confirmed')
    expect(closed).toEqual([]) // never closes a pane it just confirmed as the chair itself

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      chairs: { name: string; lastSessionId?: string }[]
    }
    expect(manifest.chairs[0].lastSessionId).toBe('sess-2')
  })

  it('M4: confirming (crash after B3s confirming-transition, before confirmed), chair row already on the successor pane -> confirmed', async () => {
    const meta = await createSealed(storeDeps, 'chair-confirming-crash', sealedInput())
    await transition(storeDeps, 'chair-confirming-crash', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-3'
      }
    })
    await withPaneLock(chairLockKey('chair-confirming-crash'), async () => {
      await transitionLocked(storeDeps, 'chair-confirming-crash', meta.id, 'confirming')
    })
    const registered = db.upsertAgentByPaneSuffix({
      displayName: 'chair-confirming-crash',
      role: null,
      hostId: 'local',
      paneKey: 'pane-successor',
      terminalHandle: 'handle-successor',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'handle-successor',
      originHostId: 'local'
    })
    if (registered.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const runtime = fakeRuntime({ live: new Set(['pane-successor']) })

    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-confirming-crash', meta.id)
    expect(after?.state).toBe('confirmed')
  })

  it('M4: launching, chair agents row NOT on the successor pane -> successor pane closed, aborted (reason startup)', async () => {
    const meta = await createSealed(storeDeps, 'chair-launching-orphan', sealedInput())
    await transition(storeDeps, 'chair-launching-orphan', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    const closed: string[] = []
    const runtime = fakeRuntime({ live: new Set(['pane-successor', 'pane-incumbent']), closed })

    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-launching-orphan', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
    expect(closed).toEqual(['handle-successor'])
    expect(db.listAgents({ hostId: 'local' }).agents).toEqual([])
  })

  it('launching, successor pane already dead too -> aborted (reason startup); closeTerminal is still attempted (best-effort, never throws)', async () => {
    const meta = await createSealed(storeDeps, 'chair-launching-neither-live', sealedInput())
    await transition(storeDeps, 'chair-launching-neither-live', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    const closed: string[] = []
    const runtime = fakeRuntime({ live: new Set(), closed })

    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-launching-neither-live', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
    expect(closed).toEqual(['handle-successor'])
  })

  it('confirmed successions are untouched (scan only acts on sealed/launching/confirming)', async () => {
    const meta = await createSealed(storeDeps, 'chair-confirmed', sealedInput())
    await transition(storeDeps, 'chair-confirmed', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    await withPaneLock(chairLockKey('chair-confirmed'), async () => {
      await transitionLocked(storeDeps, 'chair-confirmed', meta.id, 'confirming')
      await transitionLocked(storeDeps, 'chair-confirmed', meta.id, 'confirmed')
    })
    const runtime = fakeRuntime({})

    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-confirmed', meta.id)
    expect(after?.state).toBe('confirmed')
  })

  // [G1-10z attempt-2 N10 repair] the startup confirm previously only confirmed the record and
  // the manifest — the Run stayed bound to the dead incumbent pane, and the retired handle was
  // never appended to retired-handles.json (only `meta.retiredHandle`, set by the `confirmed`
  // transition itself, which this test does not rely on).
  it('M4/N10: the startup confirm rebinds the Run to the successor and appends the retired handle', async () => {
    const chair = 'chair-startup-confirm-tail'
    const run = db.createRun({
      objective: 'ship it',
      coordinatorHandle: 'handle-incumbent',
      coordinatorPaneKey: 'pane-incumbent'
    })
    const meta = await createSealed(storeDeps, chair, { ...sealedInput(), runId: run.id })
    await transition(storeDeps, chair, meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    const registered = db.upsertAgentByPaneSuffix({
      displayName: chair,
      role: null,
      hostId: 'local',
      paneKey: 'pane-successor',
      terminalHandle: 'handle-successor',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'handle-successor',
      originHostId: 'local'
    })
    if (registered.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const cancelledWaiters: string[] = []
    const runtime = fakeRuntime({ live: new Set(['pane-successor']), cancelledWaiters })

    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir })

    const after = await read(storeDeps, chair, meta.id)
    expect(after?.state).toBe('confirmed')

    // The Run now binds to the successor, not the dead incumbent.
    const boundRun = db.getRun(run.id)
    expect(boundRun?.coordinator_handle).toBe('handle-successor')
    expect(boundRun?.coordinator_pane_key).toBe('pane-successor')
    expect(cancelledWaiters).toContain(`run:${run.id}`)

    // The retired handle landed in retired-handles.json, not just meta.retiredHandle.
    const retiredHandlesPath = join(tempDir, 'chairs', chair, 'retired-handles.json')
    const retired = JSON.parse(readFileSync(retiredHandlesPath, 'utf8')) as {
      handle: string
      succession: string
    }[]
    expect(retired).toEqual([
      { handle: 'handle-incumbent', succession: meta.id, at: expect.any(String) }
    ])
  })

  it('a missing chairs/ directory is a silent no-op', async () => {
    const runtime = fakeRuntime({})
    await expect(
      scanSuccessionsAtStartup({
        runtime,
        db: dbFacade(),
        orcaHome: join(tempDir, 'never-created')
      })
    ).resolves.toBeUndefined()
  })

  // G1 attempt-3 repair F3 (probe p12): a record left `confirming` (e.g. accept's
  // `confirmTransitionFailed` warning path) is only resolved at the NEXT restart. By then the
  // Run has moved on (a fresh Run bound to the same successor pane displaces the seal-time Run,
  // per `unbindOtherRunsForPane`) and the manifest has been updated by a later accept/restore.
  // The old unconditional rebind/rewrite would unbind the CURRENT Run and regress the manifest to
  // the pre-succession session. Assert both are left untouched, and the skip is audited.
  it('F3: a confirming record resolved at the next restart does NOT rebind a moved Run or regress a newer manifest', async () => {
    const chair = 'chair-stale-tail'
    const manifestPath = join(tempDir, 'chairs.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        chairs: [{ name: chair, worktree: '/repo', agent: 'claude', conversationId: 'sess-orig' }]
      })
    )
    const run1 = db.createRun({
      objective: 'old',
      coordinatorHandle: 'handle-incumbent',
      coordinatorPaneKey: 'pane-incumbent'
    })
    const meta = await createSealed(storeDeps, chair, {
      ...sealedInput(),
      runId: run1.id,
      preSuccessionSessionId: 'sess-orig'
    })
    await transition(storeDeps, chair, meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-b'
      }
    })
    await transition(storeDeps, chair, meta.id, 'confirming')
    const registered = db.upsertAgentByPaneSuffix({
      displayName: chair,
      role: null,
      hostId: 'local',
      paneKey: 'pane-successor',
      terminalHandle: 'handle-successor',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'handle-successor',
      originHostId: 'local'
    })
    if (registered.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    // accept's takeover bound run1 to the successor pane before its `confirmed` transition failed.
    db.bindRun({
      runId: run1.id,
      coordinatorHandle: 'handle-successor',
      coordinatorPaneKey: 'pane-successor'
    })
    // hours later: the chair finished run1's objective and bound a NEW Run to the same pane —
    // unbindOtherRunsForPane displaces run1 (its coordinator_pane_key goes back to null) — and a
    // later restore/accept moved the manifest on.
    const run2 = db.createRun({
      objective: 'new',
      coordinatorHandle: 'handle-successor',
      coordinatorPaneKey: 'pane-successor'
    })
    const manifestBefore = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      chairs: { lastSessionId?: string }[]
    }
    manifestBefore.chairs[0].lastSessionId = 'sess-newer'
    writeFileSync(manifestPath, JSON.stringify(manifestBefore))

    const runtime = fakeRuntime({ live: new Set(['pane-successor']) })
    await scanSuccessionsAtStartup({ runtime, db: dbFacade(), orcaHome: tempDir, manifestPath })

    const after = await read(storeDeps, chair, meta.id)
    expect(after?.state).toBe('confirmed')
    // run2 — the CURRENT Run for that pane — must still be bound there, not displaced.
    const boundRun2 = db.getRun(run2.id)
    expect(boundRun2?.coordinator_pane_key).toBe('pane-successor')
    const run1After = db.getRun(run1.id)
    expect(run1After?.coordinator_pane_key).toBeNull()
    // The manifest must NOT be regressed to the pre-succession/seal-time session.
    const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      chairs: { lastSessionId?: string }[]
    }
    expect(manifestAfter.chairs[0].lastSessionId).toBe('sess-newer')
  })
})
