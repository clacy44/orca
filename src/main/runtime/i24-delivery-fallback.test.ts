/**
 * I-24-1: the R1/R2 fallback fixes that stay after the bounded escape (FIX-1) was replaced by the
 * anchored Claude identity (R270, i24-delivery-anchored.test.ts). Ported unchanged from the former
 * i24-delivery-escape(-guards).test.ts onto i24-delivery-test-harness.ts.
 *
 * FIX-2 (E2a): the R2 quiet gate's null case (`leaf.lastOutputAt ? … : 0` read null as "never
 * quiet") — now `leaf.lastOutputAt ?? pty.lastOutputAt ?? pty.firstObservedAt`.
 * FIX-3: the R2 probe's own screen check scans the current screen for Claude's dialogs.
 * FIX-4: the withheld reason surfaces on the delivery snapshot.
 * FIX-5 (E6): the two silent, non-rescheduling returns in `attemptHydratedProbedDeliveryUnguarded`
 * now record a withhold so a live record's retry chain never freezes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import {
  MIN,
  TAB_ID,
  LEAF_ID,
  WORKTREE_ID,
  PANE_KEY,
  advance,
  claudeHook,
  makeController,
  makeDbStub,
  pointerWrites,
  priv,
  setUpLeafPane,
  snapshot
} from './i24-delivery-test-harness'

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('I-24-1 FIX-2: R2 quiet gate reads firstObservedAt, not a null-as-"never quiet"', () => {
  it('T3: a fresh done hook with lastOutputAt null delivers once the runtime has observed >=3s of quiet', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-t3'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    await advance(5_000, 1_000)
    stub.insert('mail')
    runtime.deliverPendingMessagesForHandle(handle)
    await advance(5_000, 500)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
  })

  it('T3-neg: output 1s ago still fails the quiet gate (probe_failed)', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-t3-neg'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    await advance(5_000, 1_000)
    runtime.onPtyData(ptyId, 'still printing\n', Date.now())
    await vi.advanceTimersByTimeAsync(1_000)
    stub.insert('mail')
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(10)
    const rec = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(rec?.reason).toBe('probe_failed')
  })

  it('R2-side FIX-3: a Claude dialog on screen during the R1+R2 probe fails the probe (probe_failed), never types', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-n2-r2-modal'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    // probeTuiIdleForDelivery reads the LEAF's own tailBuffer (not the pty record's).
    const leaf = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))!
    ;(leaf as unknown as { tailBuffer: string[] }).tailBuffer = [
      'Bash command',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No (esc)'
    ]
    // >= TUI_IDLE_QUIESCENCE_MS of quiet, so the modal check (not the quiet gate) is isolated.
    await advance(5_000, 1_000)
    stub.insert('mail')
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    const rec = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(rec?.reason).toBe('probe_failed')
  })
})

describe('I-24-1 FIX-4: withheldReason surfaces on the sent snapshot', () => {
  it('T5: no_hydrated_status (E1) surfaces as withheldReason', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t5-e1'
    const { runtime, handle, stub } = await setUpLeafPane({
      hooks: () => [],
      fg: 'claude',
      confirm: null,
      ptyId
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    const snap = snapshot(runtime, stub)
    expect(snap.withheldReason).toBe('no_hydrated_status')
  })

  it('T5: awaiting_idle_edge (E5) surfaces as withheldReason', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService(null, undefined, { getAgentStatusSnapshot: () => [] })
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write, 'claude', null) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] } as never)
    const ptyId = 'pty-i24-t5-e5'
    const pty = priv(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
      connected: true,
      paneKey: PANE_KEY
    })
    const handle = priv(runtime).issuePtyHandle(pty)
    const stub = makeDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    const snap = snapshot(runtime, stub)
    expect(snap.withheldReason).toBe('awaiting_idle_edge')
  })

  it('T5: blocked_modal (E4) surfaces as withheldReason', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t5-e4'
    const { runtime, handle, stub } = await setUpLeafPane({
      hooks: () => [],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      launchAgent: 'claude'
    })
    runtime.onPtyData(ptyId, '\x1b]0;Claude working\x07', 100)
    runtime.onPtyData(
      ptyId,
      'Bash command\nDo you want to proceed?\n❯ 1. Yes\n  2. No (esc)\n',
      Date.now()
    )
    stub.insert('mail')
    runtime.deliverPendingMessagesForHandle(handle)
    const snap = snapshot(runtime, stub)
    expect(snap.withheldReason).toBe('blocked_modal')
  })
})

describe('I-24-1 FIX-5: every retry exit reschedules or records a withhold (E6)', () => {
  it('T6: leaf.writable false at one retry re-arms the timer instead of freezing the attempt count', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t6'
    const t0 = Date.now()
    const { runtime, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    stub.insert('mail')
    // Force the leaf through the fallback, then flip writable false so the top guard in
    // attemptHydratedProbedDeliveryUnguarded is what this test proves records a withhold.
    const leafKey = priv(runtime).getLeafKey(TAB_ID, LEAF_ID)
    const leaf = priv(runtime).leaves.get(leafKey)!
    leaf.writable = false
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(50)
    const first = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(first?.reason).toBe('no_live_pane')
    expect(first?.count).toBe(1)
    // The retry timer armed above must re-drive delivery and bump the count again.
    await advance(6 * MIN)
    const second = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(second?.count).toBeGreaterThan(1)
  })

  it('second FIX-5 site: the R1+R2 continuation going stale (writable drops mid-probe) reschedules instead of freezing the retry count', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-n2-fix5b'
    const { runtime, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    const controller = (
      runtime as unknown as {
        ptyController: { getForegroundProcess: (id: string) => Promise<string | null> }
      }
    ).ptyController
    const originalGetForeground = controller.getForegroundProcess.bind(controller)
    const leaf = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))!
    controller.getForegroundProcess = async (id: string) => {
      const result = await originalGetForeground(id)
      // The leaf goes stale DURING the R1+R2 continuation's own await chain — the currentLeaf
      // re-resolve at the end of attemptHydratedProbedDeliveryUnguarded must record a withhold.
      leaf.writable = false
      return result
    }
    stub.insert('mail')
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(50)
    const first = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(first?.reason).toBe('no_live_pane')
    const firstCount = first?.count ?? 0
    await advance(6 * MIN)
    const second = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(second?.count).toBeGreaterThan(firstCount)
  })
})
