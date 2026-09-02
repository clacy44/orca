// S10-19 W-2 review B1 (INV-P-013): the four exit hooks (onPtyExit / onCommandFinished's
// scanner branch / confirmPtyAgentExit) hand closePeerOwnedPaneOnAgentExit a ptyId, but the row
// is keyed on the terminal HANDLE — a different id space (handleByPtyId exists precisely
// because they differ). This drives the REAL production callers, not a hand-built handle value,
// so a regression back to "pass the ptyId straight through" fails these.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

const TEST_WORKTREE_ID = 'repo-1::/tmp/worktree-b1'

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

function insertPeerAttachment(
  db: OrchestrationDb,
  dispatchId: string,
  handle: string,
  runtimeEpoch: string
): void {
  rawDb(db)
    .prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, agent_exited_at)
       VALUES (?, 'task_x', 'fp_peer', ?, 'ready', 'input_accepted', ?, NULL)`
    )
    .run(dispatchId, runtimeEpoch, handle)
}

// Why direct internals and not syncWindowGraph + listTerminals: listTerminals resolves the
// worktree through the store's repo/worktree catalogue, which a bare `new OrcaRuntimeService()`
// (no store) has none of. closePeerOwnedPaneOnAgentExit only ever needs handleByPtyId + ptysById
// + handles — the same three maps issuePtyHandle itself populates — so this mints a handle the
// same way a real spawn does, without standing up the whole worktree graph.
function registerFakePtyAndGetHandle(runtime: OrcaRuntimeService, ptyId: string): string {
  const handle = `term_${ptyId}`
  const internals = runtime as unknown as {
    runtimeId: string
    ptysById: Map<string, Record<string, unknown>>
    handleByPtyId: Map<string, string>
    handles: Map<string, Record<string, unknown>>
  }
  internals.ptysById.set(ptyId, {
    ptyId,
    incarnationId: 'inc-1',
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    isWsl: false,
    wslDistro: null,
    connected: true,
    lastExitCode: null,
    paneKey: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    waitBlockedAt: null,
    lastAgentStatus: null,
    title: null,
    titleUpdatedAt: 0,
    lastOscTitle: null,
    lastOscTitleAt: 0,
    launchAgent: null,
    foregroundAgent: null
  })
  internals.handleByPtyId.set(ptyId, handle)
  internals.handles.set(handle, {
    handle,
    runtimeId: internals.runtimeId,
    rendererGraphEpoch: 0,
    worktreeId: TEST_WORKTREE_ID,
    tabId: `pty:${ptyId}`,
    leafId: `pty:${ptyId}`,
    ptyId,
    ptyGeneration: 0
  })
  return handle
}

describe('S10-19 W-2 review B1: closePeerOwnedPaneOnAgentExit resolves the terminal handle', () => {
  it('a real onPtyExit(ptyId) closes the peer-owned row keyed on the MINTED handle, which differs from the ptyId', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')

      const ptyId = 'pty-b1-real'
      const handle = registerFakePtyAndGetHandle(runtime, ptyId)
      expect(handle).not.toBe(ptyId)
      expect(handle).toMatch(/^term_/)

      const dispatchId = 'disp_b1_onptyexit'
      insertPeerAttachment(db, dispatchId, handle, runtime.getRuntimeId())

      const closeTerminal = vi
        .spyOn(runtime, 'closeTerminal')
        .mockResolvedValue({ handle, accepted: true, exited: true } as never)

      runtime.onPtyExit(ptyId, 0)
      // The hook is deliberately fire-and-forget (orca-runtime.ts's own doc comment); drain it.
      await vi.waitFor(() => {
        expect(db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at).not.toBeNull()
      })

      expect(closeTerminal).toHaveBeenCalledWith(handle)
      expect(closeTerminal).not.toHaveBeenCalledWith(ptyId)
      const row = db.getRemoteDispatchAttachment(dispatchId)
      expect(row?.state).toBe('agent_exited')
    } finally {
      db.close()
    }
  })

  it('confirmPtyAgentExit (the agent-exited hook sites, :18482/:18518) also resolves the handle, not the ptyId', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')

      const ptyId = 'pty-b1-confirm-exit'
      const handle = registerFakePtyAndGetHandle(runtime, ptyId)

      const dispatchId = 'disp_b1_confirm_exit'
      insertPeerAttachment(db, dispatchId, handle, runtime.getRuntimeId())

      const closeTerminal = vi
        .spyOn(runtime, 'closeTerminal')
        .mockResolvedValue({ handle, accepted: true, exited: true } as never)

      // confirmPtyAgentExit is private; mark the pty disconnected first so it takes the
      // synchronous "confirmed gone" branch rather than the async foreground-probe branch —
      // the private method itself is still the real production code under test.
      const internals = runtime as unknown as {
        ptysById: Map<string, { connected: boolean }>
        confirmPtyAgentExit(id: string): void
      }
      const pty = internals.ptysById.get(ptyId)
      if (!pty) {
        throw new Error('expected the pty to be registered')
      }
      pty.connected = false
      internals.confirmPtyAgentExit(ptyId)

      await vi.waitFor(() => {
        expect(db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at).not.toBeNull()
      })

      expect(closeTerminal).toHaveBeenCalledWith(handle)
    } finally {
      db.close()
    }
  })

  it('no registered handle for the ptyId (unknown/already-retired pty) is a silent no-op — never crashes the exit hook', () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')
      const closeTerminal = vi.spyOn(runtime, 'closeTerminal')
      expect(() => runtime.onPtyExit('pty-never-registered', 0)).not.toThrow()
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})

// W-5..W-7 review findings 2/5 (Ruling 24 addendum 4(bb)/(ee)): the periodic dispatch-liveness
// tick is the production caller for BOTH runPeerAttachmentRuntimePrune's re-run and
// pruneSettledRemoteAttachments — driven through the real public method, not the impl functions.
describe('W-5..W-7 review findings 2/5: tickDispatchLivenessMonitor re-runs the peer attachment prune and calls pruneSettledRemoteAttachments', () => {
  it('a live daemon-backed peer row whose agent has exited is closed and deleted by tickDispatchLivenessMonitor, and pruneSettledRemoteAttachments is invoked', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')

      const dispatchId = 'disp_tick_prune'
      rawDb(db)
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, process_incarnation, agent_exited_at)
           VALUES (?, 'task_x', 'fp_peer', ?, 'ready', 'input_accepted', 'term_tick_stale', 'pty_tick:inc_1', NULL)`
        )
        .run(dispatchId, runtime.getRuntimeId())

      vi.spyOn(runtime, 'resolveLivePeerPaneHandle').mockReturnValue('term_tick_reconnected')
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)
      const closeTerminal = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
        handle: 'term_tick_reconnected',
        accepted: true,
        exited: true
      } as never)
      const pruneSettled = vi.spyOn(db, 'pruneSettledRemoteAttachments')

      runtime.tickDispatchLivenessMonitor()

      // Both prune calls are fire-and-forget from the tick; give the async close a turn.
      await vi.waitFor(() => {
        expect(closeTerminal).toHaveBeenCalledWith('term_tick_reconnected')
      })
      expect(db.getRemoteDispatchAttachment(dispatchId)).toBeUndefined()
      expect(pruneSettled).toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
