// S10-21e (b1-10p): the daemon-survived arm attaches the survived daemon session's provider
// stream itself, so output flows into the runtime's terminal record without depending on a GUI
// client's subscribe. Split into its own file per _common-rules.md's "split modules if needed",
// mirroring restore-registered-agent-panes-s7-daemon-survived.test.ts's own fixture shapes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

// [S10-21c B-final M4 shape, mirrored from the s7 file] Real worktree-ptyId shape:
// `${repoId}::${worktreePath}@@${short}:${uuid}` — the shape the minter actually produces.
const REAL_PTY_ID = '214dd5c0-7235-4fed-99c9-9d9480fca577::/home/ubuntu@@4c920ed5'
const REAL_INCARNATION_ID = '5a29d1e7-1111-4111-8111-111111111111'
const REAL_PROCESS_INCARNATION = `${REAL_PTY_ID}:${REAL_INCARNATION_ID}`

describe('S10-21e b1-10p: daemon-survived arm attaches the survived pty', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function seedSurvivedPane(paneKey: string, agentId: string, sessionId: string): void {
    const db = rawDb()
    insertAgent(db, {
      id: agentId,
      display_name: `chair-${agentId}`,
      pane_key: paneKey,
      process_incarnation: REAL_PROCESS_INCARNATION
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
  }

  function inventoryFor(handle: string): ReturnType<typeof emptyInventory> {
    return emptyInventory({
      allLivePtyIds: new Set([REAL_PTY_ID]),
      terminalIdentityByPtyId: new Map([
        [REAL_PTY_ID, { handle, incarnationId: REAL_INCARNATION_ID }]
      ])
    })
  }

  it('calls attachSurvivedPty exactly once with the survived ptyId', async () => {
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000e001'
    seedSurvivedPane(paneKey, 'agent-e1', 'sess-e1')
    const attachSurvivedPty = vi.fn().mockResolvedValue(true)
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { attachSurvivedPty }),
      orchestrationDb!,
      HOST_ID,
      'agent-e1',
      REAL_PROCESS_INCARNATION,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventoryFor('term_fresh_e1')
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(attachSurvivedPty).toHaveBeenCalledTimes(1)
    expect(attachSurvivedPty).toHaveBeenCalledWith(REAL_PTY_ID)
  })

  it('logs one warn line naming the pane/pty/reason when attachSurvivedPty returns false', async () => {
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000e002'
    seedSurvivedPane(paneKey, 'agent-e2', 'sess-e2')
    const attachSurvivedPty = vi.fn().mockResolvedValue(false)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const outcome = await restoreOneRegisteredPane(
        baseDeps(orchestrationDb!, { attachSurvivedPty }),
        orchestrationDb!,
        HOST_ID,
        'agent-e2',
        REAL_PROCESS_INCARNATION,
        'wt-1',
        orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
        inventoryFor('term_fresh_e2')
      )
      expect(outcome.kind).toBe('skipped_daemon_survived')
      // [S10-21e review C1] The attach is fire-and-forget after this brief: the warn line lands
      // on a later microtask, not before `restoreOneRegisteredPane` resolves.
      await vi.waitFor(() => {
        expect(
          warnSpy.mock.calls.some(
            (call) =>
              typeof call[0] === 'string' &&
              call[0].includes('[restore-sweep] survived pane attach failed') &&
              call[0].includes(`pane=${paneKey}`) &&
              call[0].includes(`pty=${REAL_PTY_ID}`) &&
              call[0].includes('reason=')
          )
        ).toBe(true)
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  // [S10-21e, spec item 5(b)] Through the REAL runtime wiring (not a mock): a survived daemon
  // session's provider fake answers attach true, and after the sweep, feeding the runtime
  // `onPtyData` for that same ptyId updates the runtime's own terminal record — proving output
  // actually resumes ingestion, never just that a mock was called.
  it('through real runtime wiring, output ingested after the sweep updates the terminal record', async () => {
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000e003'
    seedSurvivedPane(paneKey, 'agent-e3', 'sess-e3')
    const runtime = new OrcaRuntimeService()
    const attachCalls: string[] = []
    const fakeController = {
      write: () => true,
      kill: () => true,
      attach: async (ptyId: string) => {
        attachCalls.push(ptyId)
        return true
      }
    }
    runtime.setPtyController(fakeController as never)

    // [S10-21e review C1] The arm no longer awaits the attach — capture the promise the
    // production fire-and-forget call kicks off so the test can await it before asserting on
    // runtime state, rather than racing an unflushed microtask.
    let attachPromise: Promise<boolean> | undefined
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        attachSurvivedPty: (ptyId) => {
          attachPromise = runtime.ensureProviderAttachForSurvivedPty(ptyId)
          return attachPromise
        }
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-e3',
      REAL_PROCESS_INCARNATION,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventoryFor('term_fresh_e3')
    )
    expect(outcome.kind).toBe('skipped_daemon_survived')
    expect(attachCalls).toEqual([REAL_PTY_ID])
    await attachPromise

    runtime.onPtyData(REAL_PTY_ID, 'hello from survived daemon\r\n', Date.now())
    const record = (
      runtime as unknown as {
        // private field, read-only inspection for this assertion
        ptysById: Map<string, { lastOutputAt: number | null; tailBuffer: string[] }>
      }
    ).ptysById.get(REAL_PTY_ID)
    expect(record?.lastOutputAt).not.toBeNull()
    expect(record?.tailBuffer.join('\n')).toContain('hello from survived daemon')
  })

  // [S10-21e review C2] A refused handle refresh must not silently skip the attach step — the
  // arm logs a distinct, loud skip line instead of attempting (or silently omitting) the attach.
  it('logs a loud skip line, never attempts attachSurvivedPty, when the handle refresh is refused', async () => {
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000e004'
    seedSurvivedPane(paneKey, 'agent-e4', 'sess-e4')
    const attachSurvivedPty = vi.fn().mockResolvedValue(true)
    vi.spyOn(orchestrationDb!, 'refreshAgentHandleAfterRespawn').mockReturnValue({
      ok: false,
      reason: 'row_quarantined'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const outcome = await restoreOneRegisteredPane(
        baseDeps(orchestrationDb!, { attachSurvivedPty }),
        orchestrationDb!,
        HOST_ID,
        'agent-e4',
        REAL_PROCESS_INCARNATION,
        'wt-1',
        orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
        inventoryFor('term_fresh_e4')
      )
      expect(outcome.kind).toBe('skipped_daemon_survived')
      expect(attachSurvivedPty).not.toHaveBeenCalled()
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('[restore-sweep] survived pane attach skipped') &&
            call[0].includes(`pane=${paneKey}`) &&
            call[0].includes('reason=handle_refresh_refused:row_quarantined')
        )
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
