/**
 * I-24-1/G1: delivery-gate escape guard tests, split from i24-delivery-escape.test.ts at 800
 * counted lines (config/vitest.config.ts's oxlint max-lines budget) — N3, N2 (five previously-
 * unpinned sites), N8, N10, N12. Shares i24-delivery-escape-harness.ts with that file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import {
  MIN,
  TAB_ID,
  LEAF_ID,
  advance,
  claudeHook,
  makeDbStub,
  pointerWrites,
  priv,
  setUpLeafPane
} from './i24-delivery-escape-harness'

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// [G1 N3] Guard (d)'s hook snapshot is read before the escape's own confirm await and never
// re-read — a `waiting` hook landing during that await was still typed into. G1 B4's single
// write chokepoint (claudeDeliveryDialogBlocks, called immediately before the pointer write)
// re-reads the snapshot fresh at write time, closing this independently of B4's own dialog
// finding — this test exercises the HOOK side (not the screen-text side P4b already pins).
describe('I-24-1 N3: guard (d) re-reads the newest hook AFTER the confirm await, not before', () => {
  it('a waiting hook landing during the confirm await blocks the write (TOCTOU)', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-n3'
    const t0 = Date.now()
    let hooks: AgentStatusIpcPayload[] = [claudeHook('done', t0 - 6 * 60 * MIN)]
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => hooks,
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    const controller = (
      runtime as unknown as {
        ptyController: { confirmForegroundProcess: (id: string) => Promise<string | null> }
      }
    ).ptyController
    const originalConfirm = controller.confirmForegroundProcess.bind(controller)
    controller.confirmForegroundProcess = async (id: string) => {
      const result = await originalConfirm(id)
      // A `waiting` hook (a permission prompt Claude just posted) lands INSIDE the confirm
      // await — after the guard set was evaluated, before the write.
      hooks = [claudeHook('waiting', Date.now())]
      return result
    }
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    // No write at all — the escape's own attempt must be blocked by the freshly-landed `waiting`
    // hook. (The withheld reason at the end of the 25-minute window reflects whatever the
    // ORDINARY ladder's later retries record against that same fresh hook — e.g. `pane_busy` —
    // not necessarily `blocked_modal`; the write count is what this test pins.)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })
})

// [G1 N2] Five sites the reviewer found reachable but not pinned by any test (each mutant/revert
// passed the base suite 16/16): the per-mailbox throttle, single-flight, 'blocked' in guard (d),
// the second FIX-5 site, and the R2-side FIX-3 edit (probeTuiIdleForDelivery's own modal check).
describe('I-24-1 N2: five previously-unpinned sites', () => {
  it('per-mailbox throttle: a rebind to a NEW ptyId for the SAME mailbox stays throttled (isolated from the per-pane map)', async () => {
    vi.useFakeTimers()
    const ptyIdA = 'pty-i24-n2-mbx-a'
    const ptyIdB = 'pty-i24-n2-mbx-b'
    const t0 = Date.now()
    const { runtime, write } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId: ptyIdA
    })
    // A dedicated mailbox stub (mirrors the pinned "two mailboxes ... per-pane throttle" test
    // above) — the message must be addressed to 'mbx-rebind', not the terminal's own handle.
    const stub = makeDbStub(() => 'mbx-rebind')
    stub.insert('mail')
    runtime.setOrchestrationDb(stub.db as never)
    // A second, never-registered ptyId — the per-PANE map has no entry for it at all, so if the
    // per-MAILBOX throttle were removed, this would be free to escape again immediately.
    priv(runtime).ptysById.set(ptyIdB, {
      ...priv(runtime).ptysById.get(ptyIdA)!,
      ptyId: ptyIdB
    })
    const internals = priv(runtime) as unknown as {
      maybeEscapeUnobservedStarvation: (
        ptyId: string | null,
        target: unknown,
        mailboxHandle: string,
        options: Record<string, unknown>
      ) => void
    }
    const target = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))!
    // [G1 B3] Guard (a) measures the bound from max(firstAt, generationStartedAt) — advance real
    // time so a fabricated old firstAt genuinely crosses it (see the per-pane throttle test above
    // for the same fix).
    await advance(11 * MIN)
    const now = Date.now()
    const crossed = { firstAt: t0, at: now, count: 3, reason: 'no_hydrated_status' }
    priv(runtime).withheldDeliveryAttemptsByHandle.set('mbx-rebind', crossed)
    internals.maybeEscapeUnobservedStarvation(ptyIdA, target, 'mbx-rebind', {})
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyIdA)).toHaveLength(1)
    // Same mailbox, rebound to ptyIdB (simulating a pane replacement — the leaf's own ptyId
    // moves, same as a real rebind) — the per-mailbox map must still throttle it, even though
    // ptyIdB's own per-pane entry is empty. A successful delivery deletes the withheld record
    // (it is no longer starved), so a SECOND piece of mail plus a fresh crossed record is what
    // makes guard (a) hold again for this second attempt — isolating the per-mailbox throttle
    // (not "no starvation record left") as the thing under test.
    ;(target as unknown as { ptyId: string }).ptyId = ptyIdB
    stub.insert('mail 2')
    priv(runtime).withheldDeliveryAttemptsByHandle.set('mbx-rebind', {
      firstAt: t0,
      at: Date.now(),
      count: 1,
      reason: 'no_hydrated_status'
    })
    internals.maybeEscapeUnobservedStarvation(ptyIdB, target, 'mbx-rebind', {})
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyIdB)).toHaveLength(0)
  })

  it('single-flight: two triggers for the same ptyId before the first confirm resolves only confirm once', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-n2-singleflight'
    const t0 = Date.now()
    // A mutable object, not a bare `let`, so TS control-flow narrowing never treats the
    // closure-only reassignment below as making later code unreachable.
    const confirmState: { resolve: ((v: string) => void) | null; calls: number } = {
      resolve: null,
      calls: 0
    }
    const { runtime, write } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    const controller = (
      runtime as unknown as {
        ptyController: { confirmForegroundProcess: (id: string) => Promise<string | null> }
      }
    ).ptyController
    controller.confirmForegroundProcess = (_id: string) =>
      new Promise<string | null>((resolve) => {
        confirmState.calls += 1
        confirmState.resolve = resolve
      })
    const internals = priv(runtime) as unknown as {
      maybeEscapeUnobservedStarvation: (
        ptyId: string | null,
        target: unknown,
        mailboxHandle: string,
        options: Record<string, unknown>
      ) => void
    }
    const target = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))
    // A dedicated mailbox stub, addressed to 'mbx-sf-a' — the write this test checks for.
    const stub = makeDbStub(() => 'mbx-sf-a')
    stub.insert('mail')
    runtime.setOrchestrationDb(stub.db as never)
    // [G1 B3] Advance real time so the fabricated firstAt genuinely crosses guard (a)'s bound.
    await advance(11 * MIN)
    const now = Date.now()
    const crossed = { firstAt: t0, at: now, count: 3, reason: 'no_hydrated_status' }
    priv(runtime).withheldDeliveryAttemptsByHandle.set('mbx-sf-a', crossed)
    priv(runtime).withheldDeliveryAttemptsByHandle.set('mbx-sf-b', { ...crossed })
    internals.maybeEscapeUnobservedStarvation(ptyId, target, 'mbx-sf-a', {})
    internals.maybeEscapeUnobservedStarvation(ptyId, target, 'mbx-sf-b', {})
    await vi.advanceTimersByTimeAsync(10)
    expect(confirmState.calls).toBe(1)
    confirmState.resolve?.('claude')
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId).length).toBeGreaterThanOrEqual(1)
  })

  it("guard (d), 'blocked': a newest hook of state blocked (not only waiting) refuses the escape", async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-n2-blocked'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('blocked', t0 - 40 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
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
      // The leaf goes stale (drops writable) DURING the R1+R2 continuation's own await chain
      // (isPtyRunningAgent's getForegroundProcess read) — the currentLeaf re-resolve at the end
      // of attemptHydratedProbedDeliveryUnguarded must record a withhold, not freeze silently.
      ;(leaf as unknown as { writable: boolean }).writable = false
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
    // probeTuiIdleForDelivery reads the LEAF's own tailBuffer (not the pty record's) —
    // buildDeliveryScreenWaitText(leaf.tailBuffer, ...).
    const leaf = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))!
    ;(leaf as unknown as { tailBuffer: string[] }).tailBuffer = [
      'Bash command',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No (esc)'
    ]
    // >= TUI_IDLE_QUIESCENCE_MS of quiet, so the modal check (not the quiet gate) is what this
    // test isolates.
    await advance(5_000, 1_000)
    stub.insert('mail')
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    const rec = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(rec?.reason).toBe('probe_failed')
  })
})

// [G1 N8] launchFenceExpiredWithoutEvidenceAt and the per-pane escape throttle/generation-start
// maps were never pruned on pty drop — a later, unrelated ptyId reuse could read a stale marker
// or throttle stamp belonging to a different process.
describe('I-24-1 N8: dropDisconnectedPtyRecord prunes the escape-guard maps', () => {
  it('drops launchFenceExpiredWithoutEvidenceAt, the per-pane throttle, and the generation-start stamp', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-n8-drop'
    const t0 = Date.now()
    const { runtime, pty } = await setUpLeafPane({
      hooks: () => [],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    const internals = priv(runtime) as unknown as {
      launchFenceExpiredWithoutEvidenceAt: Map<string, number>
      lastUnobservedStarvationEscapeAtByPtyId: Map<string, number>
      ptyLifecycleGenerationStartedAtById: Map<string, number>
      dropDisconnectedPtyRecord: (ptyId: string) => void
    }
    internals.launchFenceExpiredWithoutEvidenceAt.set(ptyId, t0)
    internals.lastUnobservedStarvationEscapeAtByPtyId.set(ptyId, t0)
    expect(internals.ptyLifecycleGenerationStartedAtById.has(ptyId)).toBe(true)
    pty.connected = false
    internals.dropDisconnectedPtyRecord(ptyId)
    expect(internals.launchFenceExpiredWithoutEvidenceAt.has(ptyId)).toBe(false)
    expect(internals.lastUnobservedStarvationEscapeAtByPtyId.has(ptyId)).toBe(false)
    expect(internals.ptyLifecycleGenerationStartedAtById.has(ptyId)).toBe(false)
  })
})

// [G1 N10] The R1+R2 continuation's own probe (isPtyRunningAgent + probeTuiIdleForDelivery) can
// outlive a pane turning observed-live (busy, not idle — the idle case was already re-checked)
// DURING those awaits. Before the fix, `!probedIdle` fell straight to the escape regardless.
describe('I-24-1 N10: a pane that turned observed-live during the R1+R2 awaits takes the ordinary ladder, not the escape', () => {
  it('busy-title arrives during probeTuiIdleForDelivery -> no escape confirm, no write', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-n10'
    let armed = false
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    const controller = (
      runtime as unknown as {
        ptyController: {
          getForegroundProcess: (id: string) => Promise<string | null>
          confirmForegroundProcess: ReturnType<typeof vi.fn>
        }
      }
    ).ptyController
    const originalGetForeground = controller.getForegroundProcess.bind(controller)
    controller.getForegroundProcess = async (id: string) => {
      const result = await originalGetForeground(id)
      if (armed) {
        // The pane paints a live busy title DURING the R2 probe's own getForegroundProcess
        // await — observed-live flips true (busy, not idle) before the probe's own verdict
        // lands, and well past the starvation bound (guards (a)-(g) would otherwise all hold).
        runtime.onPtyData(ptyId, '\x1b]0;Claude working\x07', Date.now())
      }
      return result
    }
    // Advance real time first (nothing to retry yet — no message queued), so guard (a)'s
    // generation-scoped bound (G1 B3) is already satisfied by the time the withheld record
    // below is seeded, then insert the mail and drive exactly one delivery attempt.
    await advance(11 * MIN)
    priv(runtime).withheldDeliveryAttemptsByHandle.set(handle, {
      firstAt: t0,
      at: Date.now(),
      count: 1,
      reason: 'no_hydrated_status'
    })
    stub.insert('mail')
    armed = true
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    // The escape's own guard (e) confirm must never have run — maybeEscapeUnobservedStarvation
    // returned before reaching it.
    expect(controller.confirmForegroundProcess).not.toHaveBeenCalled()
  })
})

// [G1 N12] The escape had no output-quiet requirement — it could land mid-paint or in the
// middle of a human's own draft. Requires >= TUI_IDLE_QUIESCENCE_MS quiet, the same FIX-2
// expression the R1+R2 quiet gate already uses, evaluated fresh at write time.
describe('I-24-1 N12: the escape requires output quiet at write time (both ways)', () => {
  it('output landed just before the write (< quiescence) withholds, no write', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-n12-not-quiet'
    const t0 = Date.now()
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    const controller = (
      runtime as unknown as {
        ptyController: { confirmForegroundProcess: (id: string) => Promise<string | null> }
      }
    ).ptyController
    const originalConfirm = controller.confirmForegroundProcess.bind(controller)
    controller.confirmForegroundProcess = async (id: string) => {
      const result = await originalConfirm(id)
      // Output lands INSIDE the confirm await — well under the quiescence window by the time
      // the write would otherwise land.
      runtime.onPtyData(ptyId, 'still drafting a reply\r\n', Date.now())
      return result
    }
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })

  it('a genuinely silent pane (quiet well past the bound) still escapes', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-n12-quiet'
    const t0 = Date.now()
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(12 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
  })
})
