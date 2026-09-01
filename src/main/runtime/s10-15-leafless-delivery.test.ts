/**
 * S10-15 F8: leafless mail delivery.
 *
 * Invariant: orchestration mail push must reach a pty whose delivery target has no live
 * renderer leaf — a headless `orca serve` session (never has one) or a desktop pane hidden
 * from the renderer graph (loses its). Before this fix, deliverPendingMessagesForHandle and
 * deliverPendingMessages resolved delivery only through getLiveLeafForHandle / handleByLeafKey
 * / this.leaves, so a leafless pty's mail queued forever with no delivery edge and no honest
 * `queued_awaiting_pane` signal.
 *
 * Harness: real OrcaRuntimeService with an injected pty controller and orchestration db stub —
 * copies the setup idioms from terminal-subscriber-driven-daemon-attach.test.ts (no window is
 * ever attached; `recordPtyWorktree` + `issuePtyHandle` mint a handle exactly the way
 * session.tabs.list does) and terminal-send-stale-leaf-liveness.test.ts (the db stub shape).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null }
  ) => unknown
  issuePtyHandle: (pty: unknown) => string
  pointedMessageIdsByHandle: Map<string, Set<string>>
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

// Why the same shape as terminal-send-stale-leaf-liveness.test.ts's stub: mirrors the real
// `read = 0 AND delivered_at IS NULL` query deliverPendingMessages depends on.
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

/** Mints a leafless pty + its handle exactly the way session.tabs.list does (controller
 *  inventory → recordPtyWorktree → issuePtyHandle) — never binds a tabId/leafId. */
function registerHeadlessPty(runtime: OrcaRuntimeService, ptyId: string): string {
  const record = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
  return internals(runtime).issuePtyHandle(record)
}

function driveIdleTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
  runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
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

describe('S10-15 F8: leafless mail delivery', () => {
  it('1. delivers pointer + Enter into a headless pty with no leaf at all', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-headless-1'
      const handle = registerHeadlessPty(runtime, ptyId)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveIdleTitle(runtime, ptyId)
      stub.insert('headless status')
      runtime.deliverPendingMessagesForHandle(handle)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      expect(enterCalls(write, ptyId)).toHaveLength(0)

      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)

      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('2. survives a leaf disappearing mid-flight and does not double-point on its return', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)

      const tabId = 'tab-1'
      const ptyId = 'pty-leaf-1'
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

      const handle = internals(runtime).issuePtyHandle(
        internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
      )
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveIdleTitle(runtime, ptyId)
      stub.insert('leaf status')
      runtime.deliverPendingMessagesForHandle(handle)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)

      // Leaf disappears (graph resync without it) while the Enter is still armed — the pty
      // itself is untouched, so this is NOT an exit: fix A's pty-record ladder or fix C's
      // rollback must be the only two possible outcomes, never a silent strand.
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)

      const landedThroughFixA = enterCalls(write, ptyId).length === 1
      if (!landedThroughFixA) {
        // Fix C rollback: the row must no longer read as pointed for this handle — a pointed
        // row with no Enter behind it and no rollback is exactly the invisible strand.
        const pointedIds = internals(runtime).pointedMessageIdsByHandle.get(handle)
        expect(pointedIds?.has(stub.rows[0].id)).not.toBe(true)
      }

      // Leaf comes back: re-sync with it present again must not re-point what already landed
      // (fix A route) nor duplicate the pointer beyond whatever fix C's re-delivery produced.
      runtime.syncWindowGraph(1, leafGraph)
      driveIdleTitle(runtime, ptyId)
      runtime.deliverPendingMessagesForHandle(handle)

      // Either the row was already delivered/pointed (fix A: Enter landed) and no NEW pointer
      // fires, or fix C un-pointed it and this re-sync's push is the single re-delivery — in
      // neither case does the pointer text appear more than twice total (initial + at most one
      // re-delivery after rollback).
      expect(pointerCalls(write, ptyId).length).toBeLessThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('3. never strands a pointed row when the leaf vanishes inside the submit window', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)

      const tabId = 'tab-1'
      const ptyId = 'pty-strand-1'
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

      const handle = internals(runtime).issuePtyHandle(
        internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
      )
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveIdleTitle(runtime, ptyId)
      stub.insert('strand-check status')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(pointerCalls(write, ptyId)).toHaveLength(1)

      // Inside the submit window, resync away the leaf (pty itself is still alive/connected).
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)

      const landedThroughFixA = enterCalls(write, ptyId).length === 1
      if (landedThroughFixA) {
        // Fix A resolution: the pty-record ladder found the pane anyway and submitted — the
        // end state (Enter landed exactly once) already proves no strand.
        expect(enterCalls(write, ptyId)).toHaveLength(1)
      } else {
        // Fix C rollback: the row must have been un-pointed, not silently dropped — bring the
        // leaf back and confirm a fresh trigger re-delivers it end to end.
        expect(enterCalls(write, ptyId)).toHaveLength(0)
        runtime.syncWindowGraph(1, leafGraph)
        driveIdleTitle(runtime, ptyId)
        runtime.deliverPendingMessagesForHandle(handle)
        expect(pointerCalls(write, ptyId).length).toBeGreaterThanOrEqual(2)
        vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
        expect(enterCalls(write, ptyId).length).toBeGreaterThanOrEqual(1)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('4. onPtyExit inside the submit window: no Enter, and no later re-delivery for that pty', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-exit-1'
      const handle = registerHeadlessPty(runtime, ptyId)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveIdleTitle(runtime, ptyId)
      stub.insert('exit-check status')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(pointerCalls(write, ptyId)).toHaveLength(1)

      // Exit lands inside the submit window.
      runtime.onPtyExit(ptyId, 0)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(0)

      // A later trigger on the SAME (now-dead) pty handle must not resurrect an Enter for it —
      // scoped to this pty: a successor pane re-pointing the row is out of scope here.
      write.mockClear()
      runtime.deliverPendingMessagesForHandle(handle)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('5. an unresolvable handle reports queued_awaiting_pane (no_live_pane), not plain queued', () => {
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const handle = 'term_never_registered'
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    stub.insert('orphan status')

    runtime.deliverPendingMessagesForHandle(handle)
    expect(write).not.toHaveBeenCalled()

    const snapshot = runtime.getMessageDeliverySnapshot({
      id: stub.rows[0].id,
      to_handle: handle,
      read: 0
    })
    expect(snapshot.delivery).toBe('queued_awaiting_pane')
    expect(snapshot.recipient.state).toBe('unresolved')
  })
})
