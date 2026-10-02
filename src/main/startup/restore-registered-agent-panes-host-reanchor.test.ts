// D-30a / Ruling 36 (train 10z.9, arm H): the startup restore sweep arms `internal.hostReanchor` on
// the HOST_RESUME relaunch of a manifest chair whose own agent process is gone — and on nothing else.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane, runRestoreSweep } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  LAUNCH_GEN,
  emptyInventory,
  insertAgent,
  baseDeps,
  defaultCollectIncumbentEvidence
} from './restore-sweep-test-fixtures'
import type { RestoreSweepDeps } from './restore-sweep-types'

type EnsureMock = Mock<RestoreSweepDeps['ensureAgentSession']>

const PANE = 'tab1:00000000-0000-4000-8000-0000000c0001'
const PTY_ID = '214dd5c0-7235-4fed-99c9-9d9480fca577::/home/ubuntu@@Zb7_DmyB'
const PROCESS_INCARNATION = `${PTY_ID}:80808080-8080-4808-8808-808080808088`
const NEWER_INCARNATION = '90909090-9090-4909-8909-909090909099'

describe('D-30a arm H: the sweep arms hostReanchor on a dead manifest chair only', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function ensureMock(paneKey: string): EnsureMock {
    return vi.fn<RestoreSweepDeps['ensureAgentSession']>().mockResolvedValue({
      terminal: {
        handle: 'handle-r',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
  }

  function seed(
    db: Database.Database,
    opts: { paneKey?: string; generation?: string; processIncarnation?: string | null } = {}
  ): string {
    const paneKey = opts.paneKey ?? PANE
    insertAgent(db, {
      id: `agent-${paneKey}`,
      display_name: `chair-${paneKey}`,
      pane_key: paneKey,
      process_incarnation:
        opts.processIncarnation === undefined ? PROCESS_INCARNATION : opts.processIncarnation
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: `sess-${paneKey}`,
      launchGeneration: opts.generation ?? PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    return paneKey
  }

  async function runOne(
    deps: RestoreSweepDeps,
    paneKey: string,
    inventory = emptyInventory(),
    processIncarnation: string | null = PROCESS_INCARNATION
  ) {
    const launchRow = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!
    return restoreOneRegisteredPane(
      deps,
      orchestrationDb!,
      HOST_ID,
      `agent-${paneKey}`,
      processIncarnation,
      'wt-1',
      launchRow,
      inventory
    )
  }

  function reanchorNotes(db: Database.Database): unknown[] {
    return db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'sweep_note' AND reason_code = ?`)
      .all('reanchor_armed')
  }

  function internalArg(ensure: EnsureMock): Record<string, unknown> {
    return ensure.mock.calls[0]![2] as Record<string, unknown>
  }

  it('(a) chair, real identity absent from the round, empty own pane: one call carrying hostReanchor === true and one reanchor_armed note', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    const isManifestChairPane = vi.fn().mockResolvedValue(true)
    const outcome = await runOne(
      baseDeps(orchestrationDb!, { ensureAgentSession: ensure, isManifestChairPane }),
      paneKey
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(internalArg(ensure).hostReanchor).toBe(true)
    expect(internalArg(ensure).restoreProvenance).toEqual(
      expect.objectContaining({ kind: 'host-restore' })
    )
    expect(isManifestChairPane).toHaveBeenCalledWith(paneKey)
    expect(reanchorNotes(db)).toHaveLength(1)
  })

  it('(b) registered non-chair: relaunched with no flag and no note', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => false
      }),
      paneKey
    )
    expect(ensure).toHaveBeenCalledTimes(1)
    expect('hostReanchor' in internalArg(ensure)).toBe(false)
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  it('(b2) no isManifestChairPane dep at all: relaunched with no flag', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    await runOne(baseDeps(orchestrationDb!, { ensureAgentSession: ensure }), paneKey)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect('hostReanchor' in internalArg(ensure)).toBe(false)
  })

  it('(c) manifest check throws (unreadable manifest): relaunched with no flag, never a failed restore', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    const outcome = await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => {
          throw new Error('manifest unreadable')
        }
      }),
      paneKey
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect('hostReanchor' in internalArg(ensure)).toBe(false)
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  it.each(['present', 'unknown'] as const)(
    '(d) chair with an own-pane occupant whose liveness is %s: relaunched with no flag',
    async (state) => {
      const db = rawDb()
      const paneKey = seed(db)
      const ensure = ensureMock(paneKey)
      const inventory =
        state === 'present'
          ? emptyInventory({ allLivePtyIds: new Set(['pty-own']) })
          : emptyInventory()
      await runOne(
        baseDeps(orchestrationDb!, {
          ensureAgentSession: ensure,
          isManifestChairPane: async () => true,
          findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-own' }),
          collectIncumbentEvidence: async (...args) => {
            const evidence = await defaultCollectIncumbentEvidence(...args)
            return state === 'unknown'
              ? { ...evidence, ptyState: () => 'unknown' as const }
              : evidence
          }
        }),
        paneKey,
        inventory
      )
      expect(ensure).toHaveBeenCalledTimes(1)
      expect('hostReanchor' in internalArg(ensure)).toBe(false)
      expect(reanchorNotes(db)).toHaveLength(0)
    }
  )

  it('(d2) chair whose own-pane occupant is explicitly absent (stale surface): still armed', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true,
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-stale' })
      }),
      paneKey
    )
    expect(internalArg(ensure).hostReanchor).toBe(true)
  })

  it.each([
    ['null', null],
    ['legacy', 'runtime:abc:3']
  ] as const)(
    '(j) chair whose identity is unknown (%s): relaunched with no flag and no note',
    async (_label, identity) => {
      const db = rawDb()
      const paneKey = seed(db, { processIncarnation: identity })
      const ensure = ensureMock(paneKey)
      const outcome = await runOne(
        baseDeps(orchestrationDb!, {
          ensureAgentSession: ensure,
          isManifestChairPane: async () => true
        }),
        paneKey,
        emptyInventory(),
        identity
      )
      expect(outcome.kind).toBe('layer1')
      expect(ensure).toHaveBeenCalledTimes(1)
      expect('hostReanchor' in internalArg(ensure)).toBe(false)
      expect(reanchorNotes(db)).toHaveLength(0)
    }
  )

  it('(k) chair whose own ptyId is live under a newer incarnation: relaunched with no flag and no note', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    const inventory = emptyInventory({
      allLivePtyIds: new Set([PTY_ID]),
      terminalIdentityByPtyId: new Map([
        [PTY_ID, { handle: 'term_newer', incarnationId: NEWER_INCARNATION }]
      ])
    })
    const outcome = await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true
      }),
      paneKey,
      inventory
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect('hostReanchor' in internalArg(ensure)).toBe(false)
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  function seedPeerAttachment(db: Database.Database, paneKey: string, exited = false): void {
    db.prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, pane_key, agent_exited_at)
       VALUES ('dispatch-1', 'task-1', 'fp-1', 'epoch-1', ?, ?)`
    ).run(paneKey, exited ? '2026-10-02 00:00:00' : null)
  }

  it('(l) a peer-owned chair pane (R315 parity): relaunched with no flag and no note', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    seedPeerAttachment(db, paneKey)
    const ensure = ensureMock(paneKey)
    const outcome = await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true
      }),
      paneKey
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect('hostReanchor' in internalArg(ensure)).toBe(false)
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  it('(l2) a peer attachment whose agent has exited does not make the pane peer-owned: still armed', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    seedPeerAttachment(db, paneKey, true)
    const ensure = ensureMock(paneKey)
    await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true
      }),
      paneKey
    )
    expect(internalArg(ensure).hostReanchor).toBe(true)
  })

  it('(m) reanchor_armed is written after the launch returns, never before it', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    const notesDuringLaunch: number[] = []
    const resolved = ensure.getMockImplementation()!
    ensure.mockImplementation(async (...args) => {
      notesDuringLaunch.push(reanchorNotes(db).length)
      return resolved(...args)
    })
    await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true
      }),
      paneKey
    )
    expect(notesDuringLaunch).toEqual([0])
    expect(reanchorNotes(db)).toHaveLength(1)
  })

  it('(m2) a launch that fails or is refused writes no reanchor_armed note', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    ensure.mockRejectedValueOnce(new Error('launch_record_write_failed'))
    const outcome = await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true
      }),
      paneKey
    )
    expect(outcome.kind).toBe('layer3')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(internalArg(ensure).hostReanchor).toBe(true)
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  it('(m3) a failing reanchor_armed audit write never fails the restore', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    const write = orchestrationDb!.writeAgentAudit.bind(orchestrationDb)
    vi.spyOn(orchestrationDb!, 'writeAgentAudit').mockImplementation((entry) => {
      if (entry.reasonCode === 'reanchor_armed') {
        throw new Error('audit write failed')
      }
      return write(entry)
    })
    const outcome = await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true
      }),
      paneKey
    )
    expect(outcome.kind).toBe('layer1')
    expect(internalArg(ensure).hostReanchor).toBe(true)
  })

  it('(e) chair whose agent identity is still in the inventory: skipped_daemon_survived, ensureAgentSession never called', async () => {
    const db = rawDb()
    const paneKey = seed(db, { processIncarnation: PROCESS_INCARNATION })
    const ensure = ensureMock(paneKey)
    const isManifestChairPane = vi.fn().mockResolvedValue(true)
    const inventory = emptyInventory({
      allLivePtyIds: new Set([PTY_ID]),
      terminalIdentityByPtyId: new Map([
        [PTY_ID, { handle: 'term_fresh', incarnationId: '80808080-8080-4808-8808-808080808088' }]
      ])
    })
    const outcome = await runOne(
      baseDeps(orchestrationDb!, { ensureAgentSession: ensure, isManifestChairPane }),
      paneKey,
      inventory,
      PROCESS_INCARNATION
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(ensure).not.toHaveBeenCalled()
    expect(isManifestChairPane).not.toHaveBeenCalled()
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  it('(f) chair held by rows 5-6 (this-generation launch with a live pty on its own pane): not called', async () => {
    const db = rawDb()
    const paneKey = seed(db, { generation: LAUNCH_GEN })
    const ensure = ensureMock(paneKey)
    const outcome = await runOne(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async () => true,
        findConnectedPtyForPane: () => ({ paneKey, ptyId: 'pty-own' })
      }),
      paneKey
    )
    expect(outcome.kind).toBe('skipped_leaf_held')
    expect(ensure).not.toHaveBeenCalled()
    expect(reanchorNotes(db)).toHaveLength(0)
  })

  it('(h) a second pass over a pane the first relaunch now holds is skipped: one relaunch, one flag, one note', async () => {
    const db = rawDb()
    const paneKey = seed(db)
    const ensure = ensureMock(paneKey)
    // The first relaunch records a this-generation launch, and leaves a live pty on the pane.
    ensure.mockImplementationOnce(async () => {
      recordLaunch(db, {
        hostId: HOST_ID,
        paneKey,
        agentType: 'claude',
        sessionId: `sess-${paneKey}`,
        launchGeneration: LAUNCH_GEN,
        executionHostId: EXEC_HOST_ID,
        evidence: 'host_restore'
      })
      return {
        terminal: {
          handle: 'h1',
          paneKey,
          worktreeId: 'wt-1',
          title: null,
          executionHostId: EXEC_HOST_ID
        },
        disposition: 'created'
      }
    })
    const deps = baseDeps(orchestrationDb!, {
      ensureAgentSession: ensure,
      isManifestChairPane: async () => true,
      findConnectedPtyForPane: () =>
        ensure.mock.calls.length > 0 ? { paneKey, ptyId: 'pty-new' } : undefined
    })
    await runOne(deps, paneKey)
    const second = await runOne(deps, paneKey)
    expect(second.kind).toBe('skipped_leaf_held')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(reanchorNotes(db)).toHaveLength(1)
  })

  it('T6: the serve path (runRestoreSweep, no window) flags a chair candidate and not a non-chair', async () => {
    const db = rawDb()
    const chairPane = seed(db)
    const workerPane = seed(db, { paneKey: 'tab1:00000000-0000-4000-8000-0000000c0002' })
    const ensure = vi.fn<RestoreSweepDeps['ensureAgentSession']>().mockImplementation(async () => ({
      terminal: {
        handle: 'handle-s',
        paneKey: undefined,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    }))
    await runRestoreSweep(
      baseDeps(orchestrationDb!, {
        ensureAgentSession: ensure,
        isManifestChairPane: async (paneKey) => paneKey === chairPane
      })
    )
    expect(ensure).toHaveBeenCalledTimes(2)
    const flagByPane = new Map(
      ensure.mock.calls.map(([request, , internal]) => [
        (request as { providerSession: { id: string } }).providerSession.id,
        'hostReanchor' in (internal as object)
      ])
    )
    expect(flagByPane.get(`sess-${chairPane}`)).toBe(true)
    expect(flagByPane.get(`sess-${workerPane}`)).toBe(false)
    expect(reanchorNotes(db)).toHaveLength(1)
  })
})
