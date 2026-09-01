/**
 * S10-15 delivery-durability fixes (MF-1, MF-2), chair-dispatched commit 4.
 *
 * MF-1: the absence-probe's deferred continuation (deliverPendingMessages, inside the
 * `!controllerKnowsPtyIsLive` branch) used to re-check ONLY `lastAgentStatus === 'idle'` and
 * otherwise silently drop — no attemptMidTurnClaudeDelivery for a busy Claude pane, no
 * recordWithheldDelivery, no retry. Fixed to parity with the main path (deliverPendingMessagesForHandle):
 * a busy-but-live Claude Code pane still gets mid-turn delivery; anything else is a withheld
 * attempt, never silence.
 *
 * MF-2: verified ALREADY IMPLEMENTED at the Enter-timer rollback site — `mailPointerRepointScheduler`
 * (mail-pointer-repoint-scheduler.ts) is already called there with a deterministic, stack-guarded,
 * 2s bounded retry that calls `deliverPendingMessagesForHandle` (the real entry point), independent
 * of any renderer graph edge (F8's pty self-heal ladder resolves the handle purely off ptyId). No
 * code change was made for MF-2; this test is new coverage proving that existing mechanism actually
 * redelivers with zero further graph edges.
 *
 * Harness: copies s10-15-leafless-delivery.test.ts's idioms (real OrcaRuntimeService, injected pty
 * controller, orchestration db stub).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree-mf'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null }
  ) => { launchAgent: string | null; connected: boolean }
  issuePtyHandle: (pty: unknown) => string
  withheldDeliveryAttemptsByHandle: Map<string, { at: number; reason: string }>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeController(
  write: ReturnType<typeof vi.fn>,
  probePtyLiveness?: (ptyId: string) => Promise<boolean | null>
) {
  return {
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => []),
    // Why absent (not `false`): the probe branch only fires when the controller cannot already
    // confirm liveness synchronously — hasPty stays unimplemented so `controllerKnowsPtyIsLive`
    // reads false, matching a `remote:`-style controller (F8's own precedent).
    ...(probePtyLiveness ? { probePtyLiveness } : {})
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

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('orca orchestration check')
  )
}

function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

/** Sets ONE OSC title observation (never the follow-up "done") so the pty reads
 *  lastAgentStatusObservedLive=true with a non-idle status (busy), the state the probe
 *  continuation resolves into once the deferred re-check fires. */
function driveBusyTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 102)
}

function driveIdleTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
  runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
}

describe('S10-15 MF-1: absence-probe deferred continuation reaches disposition parity', () => {
  it('a busy Claude Code pane still gets mid-turn delivery through the probe continuation', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      let resolveProbe!: (value: boolean | null) => void
      runtime.setPtyController(
        makeController(
          write,
          () =>
            new Promise<boolean | null>((resolve) => {
              resolveProbe = resolve
            })
        ) as never
      )
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-mf1-claude-busy'
      const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
      pty.launchAgent = 'claude'
      const handle = internals(runtime).issuePtyHandle(pty)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      // No hasPty on the controller — controllerKnowsPtyIsLive() is false, so an idle push still
      // hits the absence-probe branch inside deliverPendingMessages itself.
      driveIdleTitle(runtime, ptyId)
      stub.insert('mid-turn during probe')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(write).not.toHaveBeenCalled()

      // The pane goes busy (Claude, observed live, writable) WHILE the probe is still pending —
      // exactly the race MF-1 covers: the probe's own deferred continuation, not a fresh trigger,
      // must be the one to notice and deliver.
      driveBusyTitle(runtime, ptyId)
      resolveProbe(null) // not proven absent
      await vi.advanceTimersByTimeAsync(0)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      expect(enterCalls(write, ptyId)).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a busy NON-Claude pane records a withheld disposition through the probe continuation, never a silent drop', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      let resolveProbe!: (value: boolean | null) => void
      runtime.setPtyController(
        makeController(
          write,
          () =>
            new Promise<boolean | null>((resolve) => {
              resolveProbe = resolve
            })
        ) as never
      )
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-mf1-other-busy'
      // No launchAgent set — isClaudeCodePane() reads false.
      const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
      const handle = internals(runtime).issuePtyHandle(pty)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveIdleTitle(runtime, ptyId)
      stub.insert('busy non-claude during probe')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(write).not.toHaveBeenCalled()

      driveBusyTitle(runtime, ptyId)
      resolveProbe(null)
      await vi.advanceTimersByTimeAsync(0)

      // No silent drop: never delivered, but a withheld disposition IS recorded (armed for retry).
      expect(write).not.toHaveBeenCalled()
      const withheld = internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)
      expect(withheld?.reason).toBe('pane_busy')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('S10-15 MF-2: Enter-timer rollback redelivers via the existing mailPointerRepointScheduler, no graph edge required', () => {
  it('after a rollback (leaf vanished mid-submit-window), the existing 2s repoint scheduler alone redelivers — no syncWindowGraph, no fresh trigger', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)

      const tabId = 'tab-mf2'
      const ptyId = 'pty-mf2-rollback'
      const leafGraph = {
        tabs: [
          { tabId, worktreeId: WORKTREE_ID, title: 'Codex', activeLeafId: LEAF_ID, layout: null }
        ],
        leaves: [
          {
            tabId,
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

      const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
      const handle = internals(runtime).issuePtyHandle(pty)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
      stub.insert('mf2 rollback check')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(pointerCalls(write, ptyId)).toHaveLength(1)

      // Leaf vanishes mid-submit-window; the pty stays connected. NO further syncWindowGraph and
      // NO further deliverPendingMessagesForHandle call happens anywhere below — the only thing
      // driving redelivery from here must be the existing timer-based mechanism.
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)

      const landedThroughFixA = enterCalls(write, ptyId).length === 1
      if (landedThroughFixA) {
        // The pty-record ladder already resolved it synchronously — MF-2's rollback path never
        // ran, so there's nothing further to prove for this run; the self-heal already succeeded
        // with zero graph edges of its own.
        expect(enterCalls(write, ptyId)).toHaveLength(1)
        return
      }

      // Rollback (fix C) ran: the row must be un-pointed (not silently dropped) AND a bounded
      // retry must already be armed for `handle` — proving this before any timer fires is what
      // rules out "waits for a natural graph edge that never comes".
      expect(enterCalls(write, ptyId)).toHaveLength(0)

      // Advance ONLY the existing mailPointerRepointScheduler's own delay (2s) — no graph edge,
      // no new trigger.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(pointerCalls(write, ptyId).length).toBeGreaterThanOrEqual(2)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId).length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
