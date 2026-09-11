/**
 * S10-21f b4, R147: bounded pointer delivery for a continuously-busy Claude pane.
 *
 * Invariant: a Claude pane that works continuously (no idle-title edge ever comes — Claude
 * has no synthetic-title profile, synthetic-agent-title.ts:12-59) must not withhold a pointer
 * delivery forever. Once a withheld record has stood for DELIVERY_STARVATION_BOUND_MS
 * (10 min) from its FIRST withhold, delivery is forced through the same
 * attemptMidTurnClaudeDelivery path S10-15 F9 already uses (modal guard, Cursor refusal, and
 * all), and the pointer's footer names the reason. Two other edges are additive and pinned
 * here too: the turn-boundary hook-event delivery edge (notifyAgentTurnBoundaryForPane), and
 * the getMessageDeliverySnapshot 'queued_starved' state.
 *
 * Harness: mirrors s10-15-midturn-delivery.test.ts's fixtures (real OrcaRuntimeService, an
 * injected pty controller, and an orchestration-db stub keyed by `to_handle`).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import { makePaneKey } from '../../shared/stable-pane-id'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree-r147'
const TAB_ID = 'tab-r147'
const LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

// [S10-21f b4] The bound this suite proves against — kept in sync with
// DELIVERY_STARVATION_BOUND_MS in orca-runtime.ts (10 min). Not imported (the constant is
// module-private) — a drift here would show up as this suite failing at the wrong boundary.
const DELIVERY_STARVATION_BOUND_MS = 10 * 60 * 1000
const SLOW_RETRY_INTERVAL_MS = 5 * 60 * 1000

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

type StarvationRecord = { firstAt: number; at: number; count: number; reason: string }

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null; paneKey?: string | null }
  ) => PtyRecordForTest
  issuePtyHandle: (pty: unknown) => string
  isPtyRunningAgent: (pty: unknown, leaf: unknown) => Promise<boolean>
  withheldDeliveryAttemptsByHandle: Map<string, StarvationRecord>
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

// Same shape as s10-15-leafless-delivery.test.ts's / s10-15-midturn-delivery.test.ts's stub.
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
      // Why empty, unlike s10-15-midturn-delivery.test.ts's stub: this suite advances fake
      // timers by many minutes, which exposes scheduleRestoredMessageRepoints' one-time
      // post-setOrchestrationDb repoint sweep (setOrchestrationDb -> scheduleRestoredMessage-
      // Repoints -> mailPointerRepointScheduler.schedule for every handle this returns) as an
      // EXTRA, incidental delivery attempt outside the controlled slow-retry cadence these tests
      // assert on. Returning none here keeps the only recordWithheldDelivery calls the ones this
      // suite explicitly drives (the initial call and the timed slow retries).
      getUndeliveredUnreadMailboxHandles: () => [],
      getActiveCoordinatorRun: () => null,
      getCurrentRunForPane: () => undefined,
      getActiveDispatchForTerminal: () => null,
      getActiveDispatchForIdentity: () => undefined,
      findActiveRemoteAttachmentForPane: () => undefined,
      listDispatchInputObservationTargets: () => [],
      getRecipientPaneKeyForBareHandle: () => null,
      markAsDelivered: vi.fn(),
      // deliverPendingMessagesForPty/ForLeaf's own orphan-wake path (C2/F-19, Ruling 33(a))
      // calls this when a pane has no resolved agent mailbox — this suite's headless ptys never
      // set one up, so this path is reached by notifyAgentTurnBoundaryForPane (test 3) and the
      // ordinary idle-title edge (test 4, GREEN PIN) alike; absence read as "no candidate".
      findOrphanedIdentityCandidate: () => undefined,
      close: () => {}
    }
  }
}

/** Mints a leafless pty + its handle exactly like s10-15-leafless-delivery.test.ts, with a
 *  pane key so getAgentStatusSnapshot rows / notifyAgentTurnBoundaryForPane can address it. */
function registerHeadlessPty(
  runtime: OrcaRuntimeService,
  ptyId: string
): { handle: string; pty: PtyRecordForTest } {
  const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
    connected: true,
    paneKey: PANE_KEY
  })
  return { handle: internals(runtime).issuePtyHandle(pty), pty }
}

function driveWorkingTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Claude working\x07', 100)
}

// Why '[from:' rather than 'orca orchestration check' (unlike s10-15-midturn-delivery.test.ts's
// identical-looking helper): a deliveredWhileBusy pointer REPLACES the ordinary
// 'orca orchestration check' footer with the starvation marker (formatter.ts's documented
// 3-line-cap deviation) — matching on the footer text would miss exactly the pointers this
// suite most needs to see. '[from:' is in every pointer line regardless of footer.
function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('[from:')
  )
}

function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

/** A pane whose launchAgent/foregroundAgent are NOT stamped 'claude' (isClaudeCodePane false —
 *  e.g. attached externally, never Orca-launched), identified as Claude only via a fresh hook
 *  status row's own agentType. Also forces entry into the NEW pane_busy withhold branch rather
 *  than the pre-existing S10-15 F9 hot path (which requires isClaudeCodePane true). */
function makeRuntimeWithFreshClaudeHookStatus(): OrcaRuntimeService {
  return new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => [
      {
        paneKey: PANE_KEY,
        state: 'working',
        prompt: '',
        agentType: 'claude',
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: Date.now(),
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID
      }
    ]
  })
}

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S10-21f b4, R147: delivery-starvation bound', () => {
  it('1. bound fires at DELIVERY_STARVATION_BOUND_MS for a Claude pane (launchAgent null, fresh hook status): no write until then, then exactly one marked pointer + one Enter', async () => {
    vi.useFakeTimers()
    try {
      const runtime = makeRuntimeWithFreshClaudeHookStatus()
      const write = vi.fn((_ptyId: string, _data: string) => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-r147-starved-1'
      const { handle, pty } = registerHeadlessPty(runtime, ptyId)
      // launchAgent/foregroundAgent both null -> isClaudeCodePane(pty) is false; only the
      // fresh hook status (agentType 'claude', above) identifies this pane as Claude.
      expect(pty.launchAgent).toBeNull()
      expect(pty.foregroundAgent).toBeNull()
      vi.spyOn(internals(runtime), 'isPtyRunningAgent').mockResolvedValue(true)

      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveWorkingTitle(runtime, ptyId)
      expect(pty.lastAgentStatus).toBe('working')
      expect(pty.lastAgentStatusObservedLive).toBe(true)

      stub.insert('starved status')
      runtime.deliverPendingMessagesForHandle(handle)

      // First withhold: not the S10-15 F9 hot path (isClaudeCodePane false), and not yet
      // crossed the bound — RED today: base has no pane_busy withhold split here at all (an
      // unconditional delete), so no record and no armed retry ever accumulates starvation.
      expect(write).not.toHaveBeenCalled()
      expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.count).toBe(1)

      // Advance to just under the bound (one slow retry at 5 min) — still withheld, no write.
      await vi.advanceTimersByTimeAsync(SLOW_RETRY_INTERVAL_MS)
      expect(write).not.toHaveBeenCalled()

      // Advance to exactly the bound (a second slow retry at 10 min) — forced delivery fires
      // through attemptMidTurnClaudeDelivery. Exact boundary, not a margin past it, so the
      // Enter timer (armed only after the write, +AGENT_PROMPT_SUBMIT_DELAY_MS) has not yet
      // fired within this same advance.
      await vi.advanceTimersByTimeAsync(SLOW_RETRY_INTERVAL_MS)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      expect(enterCalls(write, ptyId)).toHaveLength(0)
      const [, markedPayload] = write.mock.calls.find(
        ([calledPtyId, data]) =>
          calledPtyId === ptyId && typeof data === 'string' && data.includes('[from:')
      ) as [string, string]
      expect(markedPayload).toContain('[delivered while busy — your pane never reported idle]')

      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("2. the withheld record's count increments across retries while firstAt stays stable", async () => {
    vi.useFakeTimers()
    try {
      const runtime = makeRuntimeWithFreshClaudeHookStatus()
      const write = vi.fn((_ptyId: string, _data: string) => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-r147-count-1'
      const { handle } = registerHeadlessPty(runtime, ptyId)
      vi.spyOn(internals(runtime), 'isPtyRunningAgent').mockResolvedValue(true)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveWorkingTitle(runtime, ptyId)
      stub.insert('count status')
      runtime.deliverPendingMessagesForHandle(handle)

      const first = internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)
      // RED today: base's Map value shape is `{ at, reason }` — no `count`/`firstAt` field
      // exists to assert on at all.
      expect(first?.count).toBe(1)
      const firstAt = first?.firstAt
      expect(typeof firstAt).toBe('number')

      await vi.advanceTimersByTimeAsync(SLOW_RETRY_INTERVAL_MS)
      const second = internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)
      // Still withheld (not yet crossed) unless the retry itself delivered — guard the count
      // assertion against that by re-checking write was not called.
      if (!write.mock.calls.length) {
        expect(second?.count).toBe(2)
        expect(second?.firstAt).toBe(firstAt)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('3. notifyAgentTurnBoundaryForPane delivers immediately, with the ordinary (unmarked) pointer footer', () => {
    const runtime = new OrcaRuntimeService()
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController(makeController(write) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const ptyId = 'pty-r147-turnboundary-1'
    const { handle, pty } = registerHeadlessPty(runtime, ptyId)
    pty.lastAgentStatus = 'idle' as never
    pty.lastAgentStatusObservedLive = true
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    stub.insert('turn-boundary status')

    // RED today: notifyAgentTurnBoundaryForPane does not exist on OrcaRuntimeService at all.
    ;(
      runtime as unknown as { notifyAgentTurnBoundaryForPane: (paneKey: string) => void }
    ).notifyAgentTurnBoundaryForPane(PANE_KEY)

    expect(pointerCalls(write, ptyId)).toHaveLength(1)
    const [, payload] = write.mock.calls.find(
      ([calledPtyId, data]) =>
        calledPtyId === ptyId && typeof data === 'string' && data.includes('[from:')
    ) as [string, string]
    expect(payload).not.toContain('delivered while busy')
  })

  it('4. GREEN PIN: the ordinary idle-title edge still delivers, unmarked (byte-identical to pre-b4 behavior)', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn((_ptyId: string, _data: string) => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-r147-idleedge-1'
      const { handle } = registerHeadlessPty(runtime, ptyId)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      stub.insert('idle-edge status')
      runtime.onPtyData(ptyId, '\x1b]0;Claude ready\x07', 100)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      const [, payload] = write.mock.calls.find(
        ([calledPtyId, data]) =>
          calledPtyId === ptyId && typeof data === 'string' && data.includes('[from:')
      ) as [string, string]
      expect(payload).not.toContain('delivered while busy')
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('5. getMessageDeliverySnapshot reports queued_starved once the withheld record crosses the bound', async () => {
    vi.useFakeTimers()
    try {
      // isPtyRunningAgent mocked false (not the usual true): attemptForcedBusyDelivery's own
      // precondition then fails and it records 'not_agent_pane' instead of routing into
      // attemptMidTurnClaudeDelivery, which deletes the withheld record unconditionally before
      // its own write attempt (S10-15 F9 — out of scope to change here). Isolates what this
      // test actually proves: getMessageDeliverySnapshot's own 'queued_starved' read of a
      // record that has aged past the bound, independent of the forced-delivery mechanism
      // (covered by test 1) that would otherwise clear it out from under this assertion.
      const runtime = makeRuntimeWithFreshClaudeHookStatus()
      const write = vi.fn((_ptyId: string, _data: string) => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-r147-snapshot-1'
      const { handle } = registerHeadlessPty(runtime, ptyId)
      vi.spyOn(internals(runtime), 'isPtyRunningAgent').mockResolvedValue(false)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveWorkingTitle(runtime, ptyId)
      stub.insert('snapshot status')
      const messageId = stub.rows[0]!.id
      runtime.deliverPendingMessagesForHandle(handle)

      // Not yet crossed: 'queued_awaiting_pane', never 'queued_starved'.
      // RED today: OrchestrationDeliveryState has no 'queued_starved' member at all.
      const before = runtime.getMessageDeliverySnapshot(stub.rows[0]!)
      expect(before.delivery).toBe('queued_awaiting_pane')

      await vi.advanceTimersByTimeAsync(DELIVERY_STARVATION_BOUND_MS + 60_000)

      const after = runtime.getMessageDeliverySnapshot({
        id: messageId,
        to_handle: handle,
        read: 0
      })
      expect(after.delivery).toBe('queued_starved')
      expect(after.starvedMinutes).toBeGreaterThanOrEqual(10)
      expect(after.starvedAttempts).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('6. PIN: a starved Cursor pane is never force-injected (the hard Cursor refusal survives the forced path)', async () => {
    vi.useFakeTimers()
    try {
      const runtime = makeRuntimeWithFreshClaudeHookStatus()
      const write = vi.fn((_ptyId: string, _data: string) => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-r147-cursor-1'
      const { handle, pty } = registerHeadlessPty(runtime, ptyId)
      vi.spyOn(internals(runtime), 'isPtyRunningAgent').mockResolvedValue(true)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      // A live Cursor Agent title, not Claude's — cursorTitleSources.some(isCursorAgentTitle)
      // must refuse the ENTER even once this pane's withheld record has crossed the bound and
      // the forced path writes the pointer text (the guard at deliverPendingMessages's write
      // flow, orca-runtime.ts ~:38012, runs AFTER the pointer write — it refuses only the
      // auto-submit, since "Cursor Agent treats injected PTY text as editable prompt input, so
      // submitting must stay under user control"; the text itself lands like any other pointer).
      // Fields set directly (not via onPtyData) to pin exactly the pane_busy + observedLive
      // state this scenario needs, independent of the OSC title tracker's own Cursor-identity
      // special-casing (isLiveCursorNativeTitle records no status by itself).
      ;(pty as unknown as { lastOscTitle: string | null }).lastOscTitle = 'Cursor Agent'
      pty.lastAgentStatus = 'working' as never
      pty.lastAgentStatusObservedLive = true

      stub.insert('cursor status')
      runtime.deliverPendingMessagesForHandle(handle)
      await vi.advanceTimersByTimeAsync(DELIVERY_STARVATION_BOUND_MS + 60_000)

      expect(enterCalls(write, ptyId)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('7. M2: notifyRebindDelivery clears a crossed starvation record so the rebound pane gets a fresh grace period, not an immediate force-write', async () => {
    vi.useFakeTimers()
    try {
      const runtime = makeRuntimeWithFreshClaudeHookStatus()
      const write = vi.fn((_ptyId: string, _data: string) => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db as never)

      const created = db.upsertAgentByPaneSuffix({
        displayName: 'rebind-r147-agent',
        role: null,
        hostId: 'local',
        paneKey: PANE_KEY,
        terminalHandle: 'term_pre_rebind_r147',
        processIncarnation: 'inc1',
        worktreeId: null,
        worktreePath: null,
        branch: null,
        title: null,
        agentLabel: null,
        originHandle: 'term_pre_rebind_r147',
        originHostId: 'local'
      })
      if (created.outcome === 'name_taken') {
        throw new Error('fixture setup failed')
      }
      const agentId = created.agent.id
      const handle = `agent:${agentId}`

      const ptyId = 'pty-r147-rebind-1'
      const record = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
        connected: true,
        paneKey: PANE_KEY
      })
      internals(runtime).issuePtyHandle(record)
      vi.spyOn(internals(runtime), 'isPtyRunningAgent').mockResolvedValue(true)
      driveWorkingTitle(runtime, ptyId)

      // Seed a crossed starvation record as if it survived from the pane's PRE-rebind
      // incarnation (e.g. the old pane went busy, aged well past the bound, and the identity
      // was then adopted onto a freshly rebound pane) — this is the case armAgentMailbox-
      // DeliveryAfterRebind (notifyRebindDelivery) must not inherit.
      const now = Date.now()
      internals(runtime).withheldDeliveryAttemptsByHandle.set(handle, {
        firstAt: now - DELIVERY_STARVATION_BOUND_MS - 60_000,
        at: now - 60_000,
        count: 5,
        reason: 'pane_busy'
      })

      // RED today: notifyRebindDelivery's own deliverPendingMessagesForHandle call re-records
      // onto the STALE (already-crossed) entry, so the very first busy observation after the
      // rebind force-delivers immediately instead of getting a fresh grace period.
      runtime.notifyRebindDelivery(agentId)
      await vi.advanceTimersByTimeAsync(0)

      // notifyRebindDelivery makes TWO delivery attempts by design (its own doc comment): an
      // explicit synchronous deliverPendingMessagesForHandle call, plus notifyMessageArrived's
      // queued-microtask one — so a freshly-cleared record reads count 2, not 1, once both have
      // run. What the fix actually proves is `firstAt` resetting to now instead of staying
      // pinned to the stale pre-rebind timestamp (which is what let it already read as crossed).
      const record2 = internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)
      expect(record2?.count).toBe(2)
      expect(record2?.firstAt).toBeGreaterThanOrEqual(now)
      expect(pointerCalls(write, ptyId)).toHaveLength(0)
      expect(enterCalls(write, ptyId)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('8. N4: a failed forced-busy write keeps the starvation anchor instead of deleting it early', async () => {
    vi.useFakeTimers()
    try {
      const runtime = makeRuntimeWithFreshClaudeHookStatus()
      // The forced write itself fails (e.g. the pty backend rejected it) — distinct from every
      // other test in this file, which mocks write to always succeed.
      const write = vi.fn((_ptyId: string, _data: string) => false)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-r147-failedwrite-1'
      const { handle } = registerHeadlessPty(runtime, ptyId)
      vi.spyOn(internals(runtime), 'isPtyRunningAgent').mockResolvedValue(true)
      const stub = makeOrchestrationDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)

      driveWorkingTitle(runtime, ptyId)
      stub.insert('failed-write status')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.count).toBe(1)

      // Cross the bound: forced delivery fires, attempts the write, and the write fails.
      await vi.advanceTimersByTimeAsync(DELIVERY_STARVATION_BOUND_MS + 60_000)

      expect(write).toHaveBeenCalled()
      // RED today: attemptMidTurnClaudeDelivery deleted the anchor BEFORE calling
      // deliverPendingMessages, so a failed write (wrote === false, which itself never deletes)
      // still left the record gone — the starved state was lost even though nothing was
      // actually delivered.
      expect(internals(runtime).withheldDeliveryAttemptsByHandle.has(handle)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
