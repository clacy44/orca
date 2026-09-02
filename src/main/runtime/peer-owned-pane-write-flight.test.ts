// S10-19 W-4 review B2 (Ruling 20(i), FROZEN choke serialization proof): drives
// writeToPeerOwnedPane through the REAL writeTerminalAction/claimStructuredPtyWrite flight — no
// sendTerminal mock — with a fake pty controller whose confirmForegroundProcess flips between
// the text write and the suffix (the 500ms gap). Proves: the text lands, the suffix's re-check
// refuses because the foreground moved, Enter is NEVER written, and the single shot is consumed
// (a partial write burns it — Ruling 20(b)).
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { writeToPeerOwnedPane } from './peer-owned-pane-write'

const TEST_WORKTREE_ID = 'repo-1::/tmp/worktree-b2'

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

// Why direct internals and not syncWindowGraph + listTerminals: listTerminals resolves the
// worktree through the store's repo/worktree catalogue, which a bare `new OrcaRuntimeService()`
// (no store) has none of. sendTerminal/writeTerminalAction only need handleByPtyId + ptysById +
// handles — the same three maps issuePtyHandle itself populates — so this mints a handle the
// same way a real spawn does, without standing up the whole worktree graph.
function registerAgentPtyAndGetHandle(runtime: OrcaRuntimeService, ptyId: string): string {
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
    launchAgent: 'codex',
    foregroundAgent: 'codex'
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

describe('S10-19 W-4 review B2: writeToPeerOwnedPane through the real PTY write flight', () => {
  it('a foreground flip between the text write and the suffix writes the text, refuses the suffix, and consumes the shot', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('epoch-current')

      const ptyId = 'pty-b2-flip'
      const handle = registerAgentPtyAndGetHandle(runtime, ptyId)

      const writes: string[] = []
      let confirmCall = 0
      runtime.setPtyController({
        write: (_id, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex',
        // First call (beforeWrite ahead of the text chunk) sees codex still live; the second
        // call (beforeWrite ahead of the suffix, after the 500ms gap) sees it gone.
        confirmForegroundProcess: async () => {
          confirmCall += 1
          return confirmCall === 1 ? 'codex' : 'bash'
        },
        listProcesses: async () => [{ id: ptyId, cwd: '', title: '' }]
      })

      const dispatchId = 'disp_b2_flip'
      rawDb(db)
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, agent_exited_at)
           VALUES (?, 'task_x', 'fp_peer', 'epoch-current', 'ready', 'input_accepted', ?, NULL)`
        )
        .run(dispatchId, handle)

      vi.spyOn(runtime, 'getPeerPromptState').mockReturnValue({
        state: 'blocked',
        reason: 'codex-trust-workspace',
        agent: 'codex'
      })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)

      const result = await writeToPeerOwnedPane({
        ctx: { runtime, callerFingerprint: 'fp_peer' },
        dispatchId,
        choice: 'accept_trust'
      })

      expect(result).toMatchObject({ refused: true, code: 'agent_not_live' })
      // The text landed on the real pty controller...
      expect(writes).toContain('1')
      // ...but the suffix (Enter) never did.
      expect(writes).not.toContain('\r')
      // ...and the single shot was consumed by the partial write, not returned.
      const row = db.getRemoteDispatchAttachment(dispatchId)
      expect(row?.blocked_consumed_at).not.toBeNull()
    } finally {
      db.close()
    }
  }, 10_000)

  it('a foreground that stays live for both the text and the suffix writes the full keystroke, including Enter', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('epoch-current')

      const ptyId = 'pty-b2-live'
      const handle = registerAgentPtyAndGetHandle(runtime, ptyId)

      const writes: string[] = []
      runtime.setPtyController({
        write: (_id, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex',
        confirmForegroundProcess: async () => 'codex',
        listProcesses: async () => [{ id: ptyId, cwd: '', title: '' }]
      })

      const dispatchId = 'disp_b2_live'
      rawDb(db)
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, agent_exited_at)
           VALUES (?, 'task_x', 'fp_peer', 'epoch-current', 'ready', 'input_accepted', ?, NULL)`
        )
        .run(dispatchId, handle)

      vi.spyOn(runtime, 'getPeerPromptState').mockReturnValue({
        state: 'blocked',
        reason: 'codex-trust-workspace',
        agent: 'codex'
      })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)

      const result = await writeToPeerOwnedPane({
        ctx: { runtime, callerFingerprint: 'fp_peer' },
        dispatchId,
        choice: 'accept_trust'
      })

      expect(result).toEqual({ refused: false })
      expect(writes).toEqual(['1', '\r'])
      const row = db.getRemoteDispatchAttachment(dispatchId)
      expect(row?.blocked_consumed_at).not.toBeNull()
    } finally {
      db.close()
    }
  }, 10_000)
})
