/**
 * I-24-1: the delivery-gate starvation-escape fixes.
 *
 * FIX-1 (primary, E1/E5): `maybeEscapeUnobservedStarvation` — a bounded escape for a pane not
 * observed live this runtime, with no fresh Claude hook, that would otherwise withhold
 * `no_hydrated_status`/`awaiting_idle_edge` forever (the R147 starvation escape is wired only to
 * the busy/pane_busy branch). Fires only once all six guards hold.
 * FIX-2 (E2a): the R2 quiet gate's null case (`leaf.lastOutputAt ? … : 0` read null as "never
 * quiet") — now `leaf.lastOutputAt ?? pty.lastOutputAt ?? pty.firstObservedAt`.
 * FIX-5 (E6): the two silent, non-rescheduling returns in `attemptHydratedProbedDeliveryUnguarded`
 * now record a withhold so a live record's retry chain never freezes.
 *
 * Harness: shared with i24-delivery-escape-guards.test.ts (split at 800 counted lines) via
 * i24-delivery-escape-harness.ts — see that file's own doc comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  MIN,
  TAB_ID,
  LEAF_ID,
  WORKTREE_ID,
  PANE_KEY,
  type WithheldRecord,
  advance,
  claudeHook,
  enterWrites,
  makeController,
  makeDbStub,
  pointerWrites,
  priv,
  setUpLeafPane,
  snapshot
} from './i24-delivery-escape-harness'

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('I-24-1 FIX-1: bounded unobserved-starvation escape (E1)', () => {
  it('T1: E1 pane escapes once the bound crosses, on a positive claude confirm (one marked pointer + Enter)', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t1'
    const t0 = Date.now()
    // [G1 B3, guard (g)] A restored `done` row (any age — restored rows count) is the positive
    // prior agent evidence guard (g) requires; without it the escape must never fire at all.
    const { runtime, write, controller, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    stub.insert('mail for an idle chair')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(9 * MIN + 30_000)
    const at930 = pointerWrites(write, ptyId).length
    await advance(3 * MIN)
    const payload = (pointerWrites(write, ptyId)[0]?.[1] ?? '') as string
    const snap = snapshot(runtime, stub)
    expect(at930).toBe(0)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(payload).toContain('delivered without an observed idle edge')
    expect(controller.confirmForegroundProcess.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(snap.delivery).toBe('pointed')
    await advance(200)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
  })

  for (const [name, confirm] of [
    ['shell', 'pwsh.exe'],
    ['unknown', null]
  ] as const) {
    it(`T1-neg-${name}: confirm=${String(confirm)} never authorizes the escape`, async () => {
      vi.useFakeTimers()
      const ptyId = `pty-i24-t1-${name}`
      const { runtime, write, handle } = await setUpLeafPane({
        hooks: () => [],
        fg: 'claude',
        confirm,
        ptyId
      })
      const stub = makeDbStub(() => handle)
      runtime.setOrchestrationDb(stub.db as never)
      stub.insert('mail')
      runtime.notifyMessageArrived(handle, 'status', null, null)
      await advance(25 * MIN)
      expect(pointerWrites(write, ptyId)).toHaveLength(0)
    })
  }

  it('T1-neg-modal: a Claude trust dialog on the current screen withholds (blocked_modal)', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t1-modal'
    const t0 = Date.now()
    // [G1 B3, guard (g)] Restored evidence so the escape reaches its OWN modal check (this test's
    // subject) instead of being refused earlier by guard (g) for the wrong reason.
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    runtime.onPtyData(
      ptyId,
      'Quick safety check\nIs this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\n',
      Date.now()
    )
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    const rec = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(rec?.reason).toBe('blocked_modal')
  })

  it('T1-neg-fence (INV-P-LAUNCH-EDGE): a launch fence that holds, then expires without agent evidence, never lets the escape write through 33 min', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t1-fence'
    const { runtime, write, handle, stub, pty } = await setUpLeafPane({
      hooks: () => [],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      launchAgent: 'claude'
    })
    pty.launchPromptFenceSince = Date.now()
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(3 * MIN)
    const reasonDuringFence = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason
    expect(reasonDuringFence).toBe('awaiting_launch_prompt')
    await advance(30 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })

  it("T1-neg-perm (guard d): newest Claude hook is a pending permission prompt (40 min old) with the prompt on screen -> the escape never types (defense in depth with FIX-3's own modal check)", async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-t1-perm'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('waiting', t0 - 40 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    runtime.onPtyData(
      ptyId,
      "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No (esc)\n",
      Date.now()
    )
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })

  // [guard (d) load-bearing, isolated from FIX-3] The design doc's own rationale for guard (d):
  // "a pane whose newest Claude hook (any age) is a pending prompt may still be sitting at a
  // permission/question dialog THE MODAL DETECTOR DOES NOT RECOGNIZE — never type into it." Screen
  // text here deliberately matches none of FIX-3's markers, so this isolates guard (d) itself
  // (not FIX-3's redundant modal check) as the thing standing between the escape and a write.
  // MUTANT PROOF: with guard (d) removed (canAttemptUnobservedStarvationEscape edited to always
  // return true past guard (c)), this test FAILS — the escape types into the unrecognized prompt.
  it('T1-neg-perm-unrecognized (guard d, isolated): newest hook waiting 40 min old, on-screen text matches no modal marker -> the escape still never types', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const ptyId = 'pty-i24-t1-perm-unrecognized'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('waiting', t0 - 40 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    // No recognizable dialog text at all — the current screen reads as an ordinary idle prompt.
    runtime.onPtyData(ptyId, 'some-unusual-custom-tool-prompt >\n', Date.now())
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })

  // [Coordinator decision, guard (c) vs guard (d)] A Claude hook of ANY state received after an
  // evidence-less fence expiry IS agent evidence for guard (c) — the fence exists to keep host
  // bytes out before any agent evidence, not to police what that evidence says — so the marker
  // clears. Guard (d) then independently blocks while that hook is `waiting`/`blocked`; once a
  // later hook supersedes it with a non-blocked state, the escape may write. `fg: null` here
  // (unlike this file's other tests) deliberately keeps the PRE-EXISTING F9 mid-turn busy path
  // (isPtyRunningAgent -> getForegroundProcess) from intercepting a "fresh" hook mid-test — guard
  // (e)'s OWN confirm (`confirmForegroundProcess`) is a separate controller method, unaffected.
  it('guard (c)/(d) interaction: a waiting hook after an evidence-less expiry clears the marker but guard (d) still blocks; a later done hook lets the escape write', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t1-guardcd'
    let hooks: AgentStatusIpcPayload[] = []
    let hookReceivedAt = 0
    const { runtime, write, handle, stub, pty } = await setUpLeafPane({
      hooks: () => hooks,
      fg: null,
      confirm: 'claude',
      ptyId,
      launchAgent: 'claude'
    })
    pty.launchPromptFenceSince = Date.now()
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    // The fence expires without evidence (LAUNCH_PROMPT_FENCE_MAX_MS = 5 min) well before the
    // 10-minute starvation bound — no write yet either way.
    await advance(6 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    // A waiting hook arrives after the expiry (guard (c) evidence) — still blocked, first by the
    // pre-existing busy path (fg: null -> not_agent_pane) while fresh, then by guard (d)'s
    // any-age search once R1 stops treating it as fresh (AGENT_STATUS_STALE_AFTER_MS, 30 min).
    hookReceivedAt = Date.now()
    hooks = [claudeHook('waiting', hookReceivedAt)]
    await advance(31 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    // Same (already-stale) timestamp, new state: R1 still never sees it as fresh, so this can
    // only be reaching a write through the escape's own guard (d) re-evaluation.
    hooks = [claudeHook('done', hookReceivedAt)]
    await advance(6 * MIN)
    const payload = (pointerWrites(write, ptyId)[0]?.[1] ?? '') as string
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(payload).toContain('delivered without an observed idle edge')
  })

  // [G1 B3, INV-P-LAUNCH-EDGE] G1 P4a: a main restart (new runtime, same daemon pty) forgets the
  // launch-prompt fence AND the evidence-less-expiry marker (both in-memory, per-runtime-instance
  // state — RESIDUAL R270). Before B3, the only remaining protection was the screen regex, and
  // the reattaching runtime's OWN pane record has no restored hook row either — guard (g) refuses
  // it for that reason alone, with no dependency on the marker/fence surviving the restart.
  it('B3 P4a: a main-restart reattach of a stuck-startup-menu pane never escapes (no restored hook evidence)', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-b3-p4a'
    const stuckStartupMenu = [
      ' \u273b Welcome to Claude Code!',
      '   cwd: /work/backend-dll',
      ' New MCP servers found in .mcp.json',
      ' > 1. Use this and all future MCP servers in this project',
      '   2. Use this MCP server',
      '   3. Continue without using this MCP server',
      ' Enter to confirm \u00b7 Esc to reject'
    ].join('\r\n')
    // Runtime A: the host launch, fence armed, never any agent evidence — the pane sits at a
    // startup menu forever.
    const a = await setUpLeafPane({
      hooks: () => [],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      launchAgent: 'claude'
    })
    a.pty.launchPromptFenceSince = Date.now()
    a.runtime.onPtyData(ptyId, stuckStartupMenu, Date.now())
    a.stub.insert('mail')
    a.runtime.notifyMessageArrived(a.handle, 'status', null, null)
    await advance(20 * MIN)
    expect(pointerWrites(a.write, ptyId)).toHaveLength(0)
    // Main restart: a NEW runtime re-attaches the SAME daemon pty (launchAgent null — never
    // re-armed — no fence, no marker, and this fresh runtime instance has never seen a Claude
    // hook for this pane at all). Deliberately a plain banner with NO recognizable dialog text —
    // isolates guard (g) as the thing standing between the escape and the write (a menu-shaped
    // restore tail would ALSO be caught by B4's own broadened marker; this proves guard (g) holds
    // even when the screen itself gives no protection at all).
    const plainStartupBanner = [
      ' ✻ Welcome to Claude Code!',
      '   cwd: /work/backend-dll',
      ' Type your message or / for commands'
    ].join('\r\n')
    const b = await setUpLeafPane({ hooks: () => [], fg: 'claude', confirm: 'claude', ptyId })
    b.runtime.seedTerminalRestoreTail(ptyId, { text: plainStartupBanner })
    b.stub.insert('mail')
    b.runtime.notifyMessageArrived(b.handle, 'status', null, null)
    await advance(12 * MIN)
    expect(pointerWrites(b.write, ptyId)).toHaveLength(0)
    expect(enterWrites(b.write, ptyId)).toHaveLength(0)
  })

  // [G1 B3, INV-P-LAUNCH-EDGE] G1 P6: a same-id daemon respawn/cold restore resets the pty's
  // output-sequence generation. Starvation accrued against the OLD generation must not authorize
  // a write seconds into the REPLACEMENT process, which has shown no evidence of its own yet.
  it('B3 P6: starvation accrued pre-respawn does not authorize a write seconds after a same-id respawn', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-b3-p6'
    let fg = 'pwsh.exe'
    // A restored hook exists throughout (guard (g) is satisfied) — isolates guard (a)'s own
    // generation-scoped fix as the thing standing between the escape and the write.
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: () => [claudeHook('done', Date.now() - 6 * 60 * MIN)]
    })
    const write = vi.fn((_p: string, _d: string) => true)
    const controller = {
      spawn: vi.fn(async () => ({ id: 'never' })),
      write,
      kill: () => true,
      getForegroundProcess: vi.fn(async () => fg),
      confirmForegroundProcess: vi.fn(async () => fg)
    }
    runtime.setPtyController(controller as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'backend-dll',
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
    } as never)
    const [terminal] = (await runtime.listTerminals()).terminals
    const handle = terminal.handle as string
    const stub = makeDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    runtime.onPtyData(ptyId, 'PS C:\\work\\backend-dll> \r\n', Date.now())
    stub.insert('mail 1')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(11 * MIN)
    const before = pointerWrites(write, ptyId).length
    // Same-id daemon respawn / cold restore: provider output sequence resets, advancing the
    // pty's lifecycle generation (and re-stamping its start).
    const rt = runtime as unknown as {
      getPtyOutputSequence: (id: string) => number
      synchronizePtyOutputSequenceFromProvider: (
        id: string,
        s: { value: number; generation: 'reset' | 'continued' },
        at: number
      ) => number
    }
    const seq = rt.getPtyOutputSequence(ptyId)
    rt.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'reset' }, seq)
    // The replacement process is Claude, still starting (banner only, no prompt yet).
    fg = 'claude'
    runtime.onPtyData(ptyId, ' \u273b Welcome to Claude Code!\r\n', Date.now())
    await vi.advanceTimersByTimeAsync(5_000)
    stub.insert('mail 2')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(before).toBe(0)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })

  // [G1 B2, guard (f)] G1 P2: a same-id daemon respawn (provider 'reset' sequence -> lifecycle
  // generation advances) lands INSIDE the escape's confirm await. Guard (f) — the pty lifecycle
  // generation unchanged across that await — must refuse the write.
  it('B2 P2 (guard f): a respawn landing inside the confirm await means the escape never writes', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-b2-p2'
    const t0 = Date.now()
    let confirms = 0
    let runtimeRef: {
      synchronizePtyOutputSequenceFromProvider: (
        id: string,
        s: { value: number; generation: 'reset' | 'continued' },
        at: number
      ) => number
    } | null = null
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    // Override confirmForegroundProcess so the respawn lands the instant the confirm resolves —
    // exactly inside the window guard (f) exists to close.
    const controller = (
      runtime as unknown as {
        ptyController: { confirmForegroundProcess: (id: string) => Promise<string | null> }
      }
    ).ptyController
    const originalConfirm = controller.confirmForegroundProcess.bind(controller)
    controller.confirmForegroundProcess = async (id: string) => {
      confirms += 1
      const result = await originalConfirm(id)
      runtimeRef?.synchronizePtyOutputSequenceFromProvider(id, { value: 0, generation: 'reset' }, 0)
      return result
    }
    runtimeRef = runtime as never
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(confirms).toBeGreaterThanOrEqual(1)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })
  // MUTANT PROOF (guard f): deleting `if (this.getPtyLifecycleGeneration(ptyId) !== generation)
  // return` at orca-runtime.ts's maybeEscapeUnobservedStarvation call site makes this test fail
  // (the escape writes into the replacement generation) — see the lane return for the verbatim
  // tail.

  // [G1 B2] A writable-drop test alongside guard (f)'s own respawn test: the pane stops being
  // writable (a graph resync, or the leaf hidden from the renderer) DURING the confirm await —
  // the caller's own re-resolve (`!resolved.writable`) must refuse the write.
  it('B2 writable-drop: the pane becomes unwritable during the confirm await -> the escape never writes', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-b2-writable-drop'
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
    const leaf = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))!
    controller.confirmForegroundProcess = async (id: string) => {
      const result = await originalConfirm(id)
      // The leaf drops out of the writable set while the confirm was in flight.
      ;(leaf as unknown as { writable: boolean }).writable = false
      return result
    }
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })
  // MUTANT PROOF (guard f, the writable half): guard (f)'s own `!resolved.writable` re-resolve
  // AND deliverPendingMessages' own independent `!resolved.writable` check (its single write
  // chokepoint, G1 B4) are both live here — deleting EITHER alone still leaves the other in
  // place and this test still passes; deleting BOTH together makes it fail (verified manually;
  // see the lane return for the verbatim tail). Genuine defense in depth, not a single point of
  // failure — left as-is rather than treated as dead code.
})

describe('I-24-1 FIX-1: per-pane throttle (further guard alongside the per-mailbox one)', () => {
  it('two mailboxes resolving to the same ptyId get exactly one forced pointer within the window; the second escapes only after it', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t1-pty-throttle'
    const t0 = Date.now()
    let currentToHandle = 'mbx-a'
    // [G1 B3, guard (g)] Restored evidence — see T1's own comment.
    const { runtime, write, pty } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0 - 6 * 60 * MIN)],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      launchAgent: 'claude'
    })
    void pty
    const stub = makeDbStub(() => currentToHandle)
    stub.insert('mail for mbx-a')
    currentToHandle = 'mbx-b'
    stub.insert('mail for mbx-b')
    runtime.setOrchestrationDb(stub.db as never)

    const internals = priv(runtime) as unknown as {
      maybeEscapeUnobservedStarvation: (
        ptyId: string | null,
        target: unknown,
        mailboxHandle: string,
        options: Record<string, unknown>
      ) => void
    }
    // A LEAF-owned pty resolves through handleByLeafKey, not handleByPtyId — a synthetic
    // `{deliveryKind:'pty', ptyId}` target resolves handle: undefined for this pane shape and
    // deliverPendingMessages silently no-ops, so pass the real leaf record as the target, the
    // same shape every real leaf-branch call site uses.
    const target = priv(runtime).leaves.get(priv(runtime).getLeafKey(TAB_ID, LEAF_ID))
    // [G1 B3] Guard (a) now measures the bound from max(firstAt, the pty's generation start) —
    // a fabricated old firstAt with no elapsed real/fake time since generation start (t0) would
    // no longer cross the bound. Advance real time instead of back-dating firstAt.
    await advance(11 * MIN)
    const now = Date.now()
    const crossedRecord: WithheldRecord = {
      firstAt: t0,
      at: now,
      count: 3,
      reason: 'no_hydrated_status'
    }
    priv(runtime).withheldDeliveryAttemptsByHandle.set('mbx-a', crossedRecord)
    priv(runtime).withheldDeliveryAttemptsByHandle.set('mbx-b', { ...crossedRecord })

    internals.maybeEscapeUnobservedStarvation(ptyId, target, 'mbx-a', {})
    await vi.advanceTimersByTimeAsync(50)
    // Past the write-flight's own Enter delay (a per-pty serialization unrelated to the
    // starvation escape) so mbx-b's attempt below is refused ONLY by the per-pty throttle map,
    // not incidentally parked by a flight mbx-a's own write is still settling.
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    internals.maybeEscapeUnobservedStarvation(ptyId, target, 'mbx-b', {})
    await vi.advanceTimersByTimeAsync(50)
    // Same pane, same window: the per-mailbox map alone would let mbx-b force its own write too
    // — the per-pty map is the further guard that caps the PANE at one.
    expect(pointerWrites(write, ptyId)).toHaveLength(1)

    await advance(10 * MIN + 30_000)
    internals.maybeEscapeUnobservedStarvation(ptyId, target, 'mbx-b', {})
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(2)
  })
})

describe('I-24-1 FIX-1: bounded unobserved-starvation escape (E2)', () => {
  it('T2: a leafless pty never observed live escapes after the bound on a positive claude confirm', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    // [G1 B3, guard (g)] Restored evidence — see T1's own comment.
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: () => [claudeHook('done', t0 - 6 * 60 * MIN)]
    })
    const write = vi.fn((_p: string, _d: string) => true)
    runtime.setPtyController(makeController(write, 'claude', 'claude') as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] } as never)
    const ptyId = 'pty-i24-t2'
    const pty = priv(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
      connected: true,
      paneKey: PANE_KEY
    })
    const handle = priv(runtime).issuePtyHandle(pty)
    const stub = makeDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(12 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
  })
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
})

describe('I-24-1 FIX-4: withheldReason surfaces on the sent snapshot', () => {
  it('T5: no_hydrated_status (E1) surfaces as withheldReason', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-i24-t5-e1'
    const { runtime, handle, stub, controller } = await setUpLeafPane({
      hooks: () => [],
      fg: 'claude',
      confirm: null,
      ptyId
    })
    void controller
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
    const { runtime, handle, stub, pty } = await setUpLeafPane({
      hooks: () => [claudeHook('done', t0)],
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    void pty
    stub.insert('mail')
    // No fresh hook is initially visible (the closure captures `t0` once) — force the leaf
    // through the no_hydrated_status fallback, then flip writable false so the top guard in
    // attemptHydratedProbedDeliveryUnguarded is what this test proves records a withhold.
    const leafKey = priv(runtime).getLeafKey(TAB_ID, LEAF_ID)
    const leaf = priv(runtime).leaves.get(leafKey)!
    leaf.writable = false
    runtime.deliverPendingMessagesForHandle(handle)
    await vi.advanceTimersByTimeAsync(50)
    const first = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(first?.reason).toBe('no_live_pane')
    expect(first?.count).toBe(1)
    // A retry timer was armed by the recordWithheldDelivery call above — advancing past the
    // slow-retry interval must re-drive deliverPendingMessagesForHandle and bump the count
    // again, proving the chain is live rather than frozen.
    await advance(6 * MIN)
    const second = priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)
    expect(second?.count).toBeGreaterThan(1)
  })
})
