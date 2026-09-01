/**
 * S10-15 F9: mid-turn mail delivery into Claude Code panes (owner-ruled).
 *
 * Invariant: a Claude Code pane's busy/working status no longer withholds delivery — Claude
 * Code natively queues stdin typed mid-turn and surfaces it at the model's own next tool
 * boundary, so the idle-edge gate that starves every other agent is redundant for it and only
 * starves long-running coordinator turns waiting on background work. The one hard gate that
 * survives: a live blocked-modal tail (a permission/trust prompt) still withholds — an
 * injected Enter would answer the dialog, not the pane. Every other pane (non-Claude agent,
 * shell, Cursor) keeps today's idle-edge behavior byte-identical.
 *
 * Harness: mirrors s10-15-leafless-delivery.test.ts's fixtures (real OrcaRuntimeService, an
 * injected pty controller, and an orchestration-db stub keyed by `to_handle`).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import { makePaneKey } from '../../shared/stable-pane-id'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const TAB_ID = 'tab-1'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

type PtyRecordForTest = {
  ptyId: string
  launchAgent: string | null
  foregroundAgent: string | null
  lastAgentStatus: string | null
  lastAgentStatusObservedLive: boolean
  connected: boolean
  tailBuffer: string[]
  tailPartialLine: string
  preview: string
  paneKey: string | null
}

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null }
  ) => PtyRecordForTest
  issuePtyHandle: (pty: unknown) => string
  withheldDeliveryAttemptsByHandle: Map<string, { at: number; reason: string }>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeController(write: ReturnType<typeof vi.fn>) {
  return {
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [])
  }
}

type StoredMessageRow = {
  id: string
  run_id: string
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: string
  priority: string
  thread_id: string | null
  payload: string | null
  read: number
  sequence: number
  created_at: string
  delivered_at: string | null
  sender_pane_key: null
}

// Same shape as s10-15-leafless-delivery.test.ts's stub.
function makeOrchestrationDbStub(toHandle: () => string) {
  const rows: StoredMessageRow[] = []
  return {
    rows,
    insert(subject: string, type: StoredMessageRow['type'] = 'status'): void {
      rows.push({
        id: `msg_${rows.length + 1}`,
        run_id: 'run_test',
        from_handle: 'term_sender',
        to_handle: toHandle(),
        subject,
        body: '',
        type,
        priority: 'normal',
        thread_id: null,
        payload: null,
        read: 0,
        sequence: rows.length + 1,
        created_at: 'now',
        delivered_at: null,
        sender_pane_key: null
      })
    },
    db: {
      getUndeliveredUnreadMessages: (handle: string) =>
        rows.filter((row) => row.to_handle === handle && row.read === 0 && !row.delivered_at),
      getUndeliveredUnreadMailboxHandles: () => [toHandle()],
      getActiveCoordinatorRun: () => null,
      getCurrentRunForPane: () => undefined,
      getActiveDispatchForTerminal: () => null,
      getActiveDispatchForIdentity: () => undefined,
      findActiveRemoteAttachmentForPane: () => undefined,
      listDispatchInputObservationTargets: () => [],
      getRecipientPaneKeyForBareHandle: () => null,
      markAsDelivered: vi.fn(),
      close: () => {}
    }
  }
}

/** Mints a leafless pty + its handle exactly like s10-15-leafless-delivery.test.ts. */
function registerHeadlessPty(
  runtime: OrcaRuntimeService,
  ptyId: string
): { handle: string; pty: PtyRecordForTest } {
  const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
  return { handle: internals(runtime).issuePtyHandle(pty), pty }
}

function driveWorkingTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Claude working\x07', 100)
}

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('orca orchestration check')
  )
}

function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

describe('S10-15 F9: mid-turn mail delivery into Claude Code panes', () => {
  it('6. a busy, live-observed Claude pane injects pointer + Enter mid-turn', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-midturn-claude-1'
      const { handle, pty } = registerHeadlessPty(runtime, ptyId)
      pty.launchAgent = 'claude'
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveWorkingTitle(runtime, ptyId)
      expect(pty.lastAgentStatus).toBe('working')
      expect(pty.lastAgentStatusObservedLive).toBe(true)

      stub.insert('mid-turn status')
      runtime.deliverPendingMessagesForHandle(handle)

      // Delivered immediately — no wait for an idle edge that a long Claude turn may
      // never reach for hours.
      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      expect(enterCalls(write, ptyId)).toHaveLength(0)

      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('7. a busy Claude pane with a blocked-modal tail withholds until the modal clears', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-midturn-modal-1'
      const { handle, pty } = registerHeadlessPty(runtime, ptyId)
      pty.launchAgent = 'claude'
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveWorkingTitle(runtime, ptyId)
      // A live permission/trust prompt in the tail — the modal guard that survives F9.
      runtime.onPtyData(ptyId, 'Do you trust the files in this folder?\r\n', 200)

      stub.insert('modal-gated status')
      runtime.deliverPendingMessagesForHandle(handle)

      expect(write).not.toHaveBeenCalled()
      const withheld = internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)
      expect(withheld?.reason).toBe('blocked_modal')

      // Clear the modal text (dismissed) and re-trigger: delivery now proceeds.
      pty.tailBuffer = []
      pty.tailPartialLine = ''
      pty.preview = ''
      runtime.deliverPendingMessagesForHandle(handle)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('8. a busy NON-Claude agent pane withholds pane_busy exactly as today (R1/R2 fallback)', async () => {
    const paneKey = makePaneKey(TAB_ID, LEAF_ID)
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID
        }
      ]
    })
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write) as never)

    const ptyId = 'pty-midturn-nonclaude-1'
    const leafGraph = {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId,
          paneTitle: null,
          title: ''
        }
      ]
    }
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, leafGraph)

    // A genuine leaf handle (handleByLeafKey), not a pty-only handle — routes through
    // deliverPendingMessagesForHandle's leaf branch and its R1/R2 hydrated-probe fallback.
    const [terminal] = (await runtime.listTerminals()).terminals
    const handle = terminal.handle
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)

    // Plain output only — never an OSC title, so this generation never observes a live
    // status; only the hydrated hook snapshot (R1) can authorize/withhold.
    runtime.onPtyData(ptyId, 'working...\n', 100)

    stub.insert('non-claude busy status')
    runtime.deliverPendingMessagesForHandle(handle)

    expect(write).not.toHaveBeenCalled()
    const withheld = internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(withheld?.reason).toBe('pane_busy')
  })

  it('9. a shell pane (no agent status ever observed) is never injected into', () => {
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const ptyId = 'pty-midturn-shell-1'
    const { handle } = registerHeadlessPty(runtime, ptyId)
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)

    // A bare shell prompt — no OSC agent title, no launchAgent, no hydrated hook status.
    runtime.onPtyData(ptyId, '$ \n', 100)

    stub.insert('shell status')
    runtime.deliverPendingMessagesForHandle(handle)

    expect(write).not.toHaveBeenCalled()
  })

  it('10. generic agent-ness with no claude-authoritative signal stays idle-edge gated', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-midturn-default-1'
      const { handle, pty } = registerHeadlessPty(runtime, ptyId)
      // Generic agent signal only — a recognized foreground agent that is NOT claude. No
      // launchAgent set (mirrors an attached, not Orca-launched, pane).
      pty.foregroundAgent = 'codex'
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      expect(pty.lastAgentStatus).toBe('working')
      expect(pty.lastAgentStatusObservedLive).toBe(true)

      stub.insert('default-classification status')
      runtime.deliverPendingMessagesForHandle(handle)

      // Not claude-authoritative -> idle-edge only, no mid-turn injection.
      expect(write).not.toHaveBeenCalled()

      // The idle edge still delivers it, exactly like before F9.
      runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// S10-15 review M-4: the hydrated-probe fallback path (attemptHydratedProbedDeliveryUnguarded,
// used for a leaf whose lastAgentStatusObservedLive has never gone true this session — a cold
// restore or a pane already idle before the runtime started) used to jump straight to
// attemptMidTurnClaudeDelivery on a hydrated 'busy' read, skipping the R2-gate-1 isPtyRunningAgent
// check that the idle continuation just past it already runs. isClaudeCodePane reads a spawn-time
// record that survives the agent exiting to a shell, so that skip could arm an Enter into a shell.
describe('S10-15 review M-4: hydrated-probe fallback gates isPtyRunningAgent before the busy-Claude branch', () => {
  const TAB_ID = 'tab-mf4'
  const LEAF_ID = '44444444-4444-4444-8444-444444444444'
  const WORKTREE_ID_M4 = 'repo-1::/tmp/probe-worktree-m4'

  type PrivateRuntime = {
    attemptHydratedProbedDeliveryUnguarded: (
      tabId: string,
      leafId: string,
      terminalHandle: string,
      mailboxHandle: string,
      options: Record<string, never>
    ) => Promise<void>
    getFreshExplicitAgentStatusForHandle: (handle: string) => unknown
    isPtyRunningAgent: (pty: unknown, leaf: unknown) => Promise<boolean>
    ptysById: Map<string, PtyRecordForTest>
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state?: { connected?: boolean }
    ) => PtyRecordForTest
    issuePtyHandle: (pty: unknown) => string
  }

  function privates(runtime: OrcaRuntimeService): PrivateRuntime {
    return runtime as unknown as PrivateRuntime
  }

  function setUpLeaf(
    runtime: OrcaRuntimeService,
    write: ReturnType<typeof vi.fn>,
    ptyId: string
  ): void {
    runtime.setPtyController(makeController(write) as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID_M4,
          title: 'Claude',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID_M4,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId,
          paneTitle: null,
          title: ''
        }
      ]
    })
  }

  it('a hydrated-busy Claude-launched pane whose agent has exited to a shell (isPtyRunningAgent=false) never arms an Enter', async () => {
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    const pty = privates(runtime).recordPtyWorktree('pty-m4-exited-1', WORKTREE_ID_M4, {
      connected: true
    })
    pty.launchAgent = 'claude'
    // Mints the handle BEFORE syncing — the leaf loop's adoptPreAllocatedHandle picks it up and
    // binds it into handleByLeafKey, matching registerHeadlessPty's precedent.
    const handle = privates(runtime).issuePtyHandle(pty)
    setUpLeaf(runtime, write, 'pty-m4-exited-1')

    // Never observed live this session — the exact precondition that routes into the
    // hydrated-probe fallback rather than the hot main path.
    vi.spyOn(privates(runtime), 'getFreshExplicitAgentStatusForHandle').mockReturnValue({
      status: 'working',
      updatedAt: Date.now()
    })
    const isPtyRunningAgentSpy = vi
      .spyOn(privates(runtime), 'isPtyRunningAgent')
      .mockResolvedValue(false)

    await privates(runtime).attemptHydratedProbedDeliveryUnguarded(
      TAB_ID,
      LEAF_ID,
      handle,
      handle,
      {}
    )

    expect(isPtyRunningAgentSpy).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('a hydrated-busy Claude-launched pane still running the agent (isPtyRunningAgent=true) delivers mid-turn', async () => {
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    const pty = privates(runtime).recordPtyWorktree('pty-m4-live-1', WORKTREE_ID_M4, {
      connected: true
    })
    pty.launchAgent = 'claude'
    const handle = privates(runtime).issuePtyHandle(pty)
    setUpLeaf(runtime, write, 'pty-m4-live-1')
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    stub.insert('mf4 still-running status')

    vi.spyOn(privates(runtime), 'getFreshExplicitAgentStatusForHandle').mockReturnValue({
      status: 'working',
      updatedAt: Date.now()
    })
    vi.spyOn(privates(runtime), 'isPtyRunningAgent').mockResolvedValue(true)

    await privates(runtime).attemptHydratedProbedDeliveryUnguarded(
      TAB_ID,
      LEAF_ID,
      handle,
      handle,
      {}
    )

    expect(pointerCalls(write, 'pty-m4-live-1')).toHaveLength(1)
  })
})
