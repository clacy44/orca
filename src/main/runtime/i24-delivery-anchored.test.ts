/**
 * R270 (I-24-1 E1/E5): the anchored Claude identity that replaced the bounded escape (FIX-1).
 *
 * After a main restart a reattached pane starts with no in-memory liveness (observedLive false,
 * launchAgent null), and an idle Claude chair emits nothing that can restore it — so its mail
 * starved with `no_hydrated_status` (E1) or `awaiting_idle_edge` (E5, leafless). The fix re-admits
 * the pane to the observed-live ladder only when three persisted facts bind together: the host's
 * launch anchor for the pane is bound to the very pty now on it, the hook server attests a hook that
 * carried that anchor's token for this pane, and the pane's newest hook row is Claude's. There is no
 * forced write any more: every other pane stays withheld (visibly) until its own live evidence.
 *
 * Every case here failed against the 7d0d3e46e9 runtime (module swap, runs/…/b3 return) except the
 * launch-fence pin, which holds on both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './orca-runtime'
import {
  INCARNATION,
  MIN,
  PANE_KEY,
  WORKTREE_ID,
  type AnchorFixture,
  advance,
  buildAnchorDeps,
  claudeHook,
  enterWrites,
  makeController,
  makeDbStub,
  pointerWrites,
  priv,
  setUpLeafPane,
  snapshot,
  tokenHash
} from './i24-delivery-test-harness'

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const PERMISSION_PROMPT =
  'Bash command\r\n  rm -rf build\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No (esc)\r\n'

// The chair's last turn ended hours before the restart: its newest hook row is a restored `done`.
function restoredDone(): () => AgentStatusIpcPayload[] {
  const at = Date.now() - 6 * 60 * MIN
  return () => [claudeHook('done', at)]
}

async function anchoredPane(ptyId: string, anchor: AnchorFixture = { launchToken: ptyId }) {
  return setUpLeafPane({ hooks: restoredDone(), fg: 'claude', confirm: 'claude', ptyId, anchor })
}

describe('R270: an anchored Claude pane takes the observed-live ladder after a main restart', () => {
  it('E1: the idle chair gets its mail on the first attempt, through the ordinary gates', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-e1'
    const { runtime, write, handle, stub, attest, controller } = await anchoredPane(ptyId)
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE_KEY,
        launchTokenHash: tokenHash(ptyId),
        terminalProvenance: 'restored'
      })
    )
    // The ordinary fresh foreground confirm still ran before the write.
    expect(controller.confirmForegroundProcess).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
    expect(snapshot(runtime, stub).delivery).toBe('pointed')
    const [, payload] = pointerWrites(write, ptyId)[0] as [string, string]
    expect(payload).not.toContain('observed idle edge')
    expect(payload).not.toContain('delivered while busy')
  })

  it('E5: a leafless pty reattached after a restart takes the same anchored ladder', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-e5'
    const { store, attest } = buildAnchorDeps(ptyId, { launchToken: ptyId })
    const runtime = new OrcaRuntimeService(store as never, undefined, {
      getAgentStatusSnapshot: restoredDone(),
      attestAgentHookCompatibilityAuthority: attest
    })
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write, 'claude', 'claude') as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] } as never)
    const pty = priv(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
      connected: true,
      paneKey: PANE_KEY,
      incarnationId: INCARNATION
    })
    const handle = priv(runtime).issuePtyHandle(pty)
    const stub = makeDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
  })

  it('Q1f: a chatty-but-idle anchored pane is not held back by output (no quiet gate on this ladder)', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-q1f'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    runtime.onPtyData(ptyId, '\x1b[2K\r  ⏵⏵ 1 background task\r\n', Date.now())
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    for (let t = 0; t < 60_000; t += 2_000) {
      runtime.onPtyData(ptyId, '\x1b[2K\r  ⏵⏵ 1 background task\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(2_000)
    }
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
  })
})

describe('R270: without all three bound facts there is no write at all — no escape, no forced pointer', () => {
  it('a reattached pane with no launch anchor stays withheld, visibly, however long it starves', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-no-anchor'
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: restoredDone(),
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    const snap = snapshot(runtime, stub)
    expect(snap.delivery).toBe('queued_starved')
    expect(snap.withheldReason).toBe('no_hydrated_status')
  })

  it.each([
    [
      "Q1e: the hook evidence belongs to a previous occupant's launch, not the current one",
      { launchToken: 'current-launch', attestedHash: tokenHash('previous-occupant') }
    ],
    [
      'P6: a same-id respawn replaced the pty the anchor was bound to',
      { launchToken: 'respawned', boundPty: 'pty-r270-negative:inc-before-respawn' }
    ],
    ['the hook evidence never reached this host', { launchToken: 'no-hooks', attestedHash: null }],
    ['a legacy anchor with no pty binding', { launchToken: 'legacy', boundPty: null }]
  ])('%s', async (_name, anchor) => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-negative'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId, anchor)
    // Q1e's stuck, unrecognised startup screen: nothing on it reads as a dialog.
    runtime.onPtyData(
      ptyId,
      ' ✻ Welcome to Claude Code!\r\n Paste code here if prompted >\r\n',
      Date.now()
    )
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(enterWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('no_hydrated_status')
  })

  it("the pane's newest hook row naming another agent refuses the anchor", async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-codex'
    const at = Date.now() - 6 * 60 * MIN
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('done', at), { ...claudeHook('done', at + 1), agentType: 'codex' }],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      anchor: { launchToken: ptyId }
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })

  it("Q1d / N4: an anchored pane showing Claude's own management UI is never typed into", async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-q1d'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    runtime.seedTerminalRestoreTail(ptyId, {
      text: 'Agents\r\n  Personal agents (~/.claude/agents)\r\n  code-reviewer\r\n',
      lastTitle: 'claude agents'
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(enterWrites(write, ptyId)).toHaveLength(0)
  })

  it('Q5: starvation older than the reattached pty record never licenses a write', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-q5'
    const t0 = Date.now()
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: restoredDone(),
      fg: 'claude',
      confirm: 'claude',
      ptyId
    })
    priv(runtime).withheldDeliveryAttemptsByHandle.set(handle, {
      firstAt: t0 - 11 * MIN,
      at: t0,
      count: 3,
      reason: 'no_live_pane'
    })
    stub.insert('mail')
    await vi.advanceTimersByTimeAsync(5_000)
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    await advance(25 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
  })
})

describe('R270: the anchored ladder keeps every write-time gate', () => {
  it('INV-P-LAUNCH-EDGE: a holding launch fence withholds the anchored pane too', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-fence'
    const { runtime, write, handle, stub, pty } = await anchoredPane(ptyId)
    pty.launchPromptFenceSince = Date.now()
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('awaiting_launch_prompt')
  })

  it('a Claude dialog on screen withholds (blocked_modal); the retry after it closes delivers', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-dialog'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    runtime.onPtyData(ptyId, PERMISSION_PROMPT, Date.now())
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('blocked_modal')
    // The dialog is answered and scrolls away; the slow retry then delivers.
    runtime.onPtyData(ptyId, `${'\r\n'.repeat(30)}> `, Date.now())
    await advance(6 * MIN)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
  })

  it('signal (i): a waiting row with no live prompt title since withholds; the first ✳ title delivers', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-waiting'
    const at = Date.now() - 2 * 60 * MIN
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('waiting', at)],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      anchor: { launchToken: ptyId }
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('blocked_modal')
    runtime.onPtyData(ptyId, '\x1b]0;✳ Claude Code\x07', Date.now())
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
  })

  it('P2: a same-id respawn inside the foreground-confirm await never receives the anchored pointer', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-p2'
    const { runtime, write, handle, stub, controller } = await anchoredPane(ptyId)
    controller.confirmForegroundProcess.mockImplementation(async () => {
      runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'reset' }, 0)
      return 'claude'
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
    expect(controller.confirmForegroundProcess).toHaveBeenCalled()
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('no_live_pane')
  })

  it('Q1b: a dialog painting between the pointer and the Enter holds the Enter on an anchored target', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-q1b'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    write.mockImplementation((p: string, d: string) => {
      if (p === ptyId && typeof d === 'string' && d.includes('[from:')) {
        queueMicrotask(() => runtime.onPtyData(ptyId, PERMISSION_PROMPT, Date.now()))
      }
      return true
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
    expect(enterWrites(write, ptyId)).toHaveLength(0)
  })
})

// ── G1-10z4 attempt-3 polish: N-A3-1 (only a read naming claude licenses the anchored route),
// N-A3-2 (the anchored route runs the generic sentinel list too), and the surviving mutants
// X-connected-skip, X-anchored-absence-off and X-title-reset.
describe('R270 polish: what the anchored route still requires at write time', () => {
  it.each([
    ['a null read', null, 0, 'anchored_confirm_inconclusive'],
    ['a wrapper read (node)', 'node', 0, 'anchored_confirm_inconclusive'],
    ['a shell read (pwsh.exe)', 'pwsh.exe', 0, 'not_agent_pane'],
    ['a read naming claude', 'claude', 1, undefined]
  ])(
    'N-A3-1: the fresh foreground confirm on an anchored pane returns %s',
    async (_name, confirm, pointers, reason) => {
      vi.useFakeTimers()
      const ptyId = `pty-r270-confirm-${String(confirm)}`
      const { runtime, write, handle, stub } = await setUpLeafPane({
        hooks: restoredDone(),
        fg: 'claude',
        confirm,
        ptyId,
        anchor: { launchToken: ptyId }
      })
      stub.insert('mail')
      runtime.notifyMessageArrived(handle, 'status', null, null)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
      expect(pointerWrites(write, ptyId)).toHaveLength(pointers)
      expect(enterWrites(write, ptyId)).toHaveLength(pointers)
      expect(priv(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(reason)
    }
  )

  it('N-A3-1: a controller that cannot take a fresh read never licenses the anchored route', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-no-confirm'
    const { runtime, write, handle, stub, controller } = await anchoredPane(ptyId)
    Reflect.deleteProperty(controller, 'confirmForegroundProcess')
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('anchored_confirm_inconclusive')
  })

  it('N-A3-2: an old-wording trust prompt with no ❯ menu withholds the anchored route, as it does mid-turn', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-generic'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    runtime.seedTerminalRestoreTail(ptyId, {
      text: 'Do you trust the files in this folder?\r\n\r\n  /work/backend-dll\r\n\r\nPress Enter to continue…\r\n'
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('blocked_modal')
  })

  it('X-connected-skip: a pty record the daemon reports disconnected is never anchored, even while its leaf is writable', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-disconnected'
    const { runtime, write, handle, stub, pty } = await anchoredPane(ptyId)
    pty.connected = false
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('no_hydrated_status')
  })

  it('X-anchored-absence-off: the absence-probe continuation re-admits the anchored pane too', async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-absence'
    const { runtime, write, handle, stub, controller } = await anchoredPane(ptyId)
    const probePtyLiveness = vi.fn(async () => true)
    Object.assign(controller, { probePtyLiveness })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(probePtyLiveness).toHaveBeenCalled()
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
  })

  it("X-title-reset: after a same-id respawn an earlier generation's ✳ title no longer makes a waiting row stale", async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-title-reset'
    const at = Date.now() - 2 * 60 * MIN
    const { runtime, write, handle, stub } = await setUpLeafPane({
      hooks: () => [claudeHook('waiting', at)],
      fg: 'claude',
      confirm: 'claude',
      ptyId,
      anchor: { launchToken: ptyId }
    })
    // The previous process showed its own prompt after the waiting row (the row went stale)...
    runtime.onPtyData(ptyId, '\x1b]0;✳ Claude Code\x07', Date.now())
    // ...then the daemon replaced the process under the same id (the tracked state resets).
    runtime.synchronizePtyOutputSequenceFromProvider(
      ptyId,
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence(ptyId)
    )
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('blocked_modal')
  })
})

// ── G1-10z4 final polish. F1: the positive-confirm rule at the three other anchored entry points
// (the leafless-pty branch, the parked replay after a settle, the absence-probe continuation),
// each with the reviewer's inconclusive reads. F3: on the anchored route the generic sentinel
// list narrows to Claude's own older trust wording — once a fresh read has named claude, another
// agent's dialog cannot be what is on screen.
type SettleInternals = {
  createPtyWriteFlight: () => unknown
  messageDeliveryFlightsByPtyId: Map<string, unknown>
  parkedMessageRedeliveriesByPtyId: Map<string, Map<string, unknown>>
  settlePendingMessageDelivery: (ptyId: string, flight: unknown) => void
}

async function anchoredEntryPane(entry: string, read: 'null' | 'node' | 'none') {
  const ptyId = `pty-r270-${entry}-${read}`
  const confirm = read === 'node' ? 'node' : read === 'null' ? null : 'claude'
  if (entry !== 'pty') {
    const env = await setUpLeafPane({
      hooks: restoredDone(),
      fg: 'claude',
      confirm,
      ptyId,
      anchor: { launchToken: ptyId }
    })
    return { ...env, ptyId }
  }
  const { store, attest } = buildAnchorDeps(ptyId, { launchToken: ptyId })
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentStatusSnapshot: restoredDone(),
    attestAgentHookCompatibilityAuthority: attest
  })
  const write = vi.fn((_p: string, _d: string) => true)
  const controller = makeController(write, 'claude', confirm)
  runtime.setPtyController(controller as never)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] } as never)
  const pty = priv(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
    connected: true,
    paneKey: PANE_KEY,
    incarnationId: INCARNATION
  })
  const handle = priv(runtime).issuePtyHandle(pty)
  const stub = makeDbStub(() => handle)
  runtime.setOrchestrationDb(stub.db as never)
  return { runtime, write, controller, handle, stub, ptyId }
}

describe('R270 final polish: every anchored entry point needs a read naming claude (F1)', () => {
  const entries = [
    ['the leafless-pty branch (E5)', 'pty'],
    ['the parked replay after a settle', 'settle'],
    ['the absence-probe continuation', 'absence']
  ] as const
  const reads = [
    ['a null read', 'null'],
    ['a wrapper read (node)', 'node'],
    ['no fresh-read capability', 'none']
  ] as const
  it.each(
    entries.flatMap(([where, entry]) =>
      reads.map(([what, read]) => [where, what, entry, read] as const)
    )
  )('%s withholds on %s', async (_where, _what, entry, read) => {
    vi.useFakeTimers()
    const env = await anchoredEntryPane(entry, read)
    if (read === 'none') {
      Reflect.deleteProperty(env.controller, 'confirmForegroundProcess')
    }
    const probePtyLiveness = vi.fn(async () => true)
    if (entry === 'absence') {
      Object.assign(env.controller, { probePtyLiveness })
    }
    const settle = env.runtime as unknown as SettleInternals
    // For the parked replay: another structured write is in flight on this pty, so the anchored
    // push parks behind it until that write settles.
    const flight = entry === 'settle' ? settle.createPtyWriteFlight() : null
    if (flight) {
      settle.messageDeliveryFlightsByPtyId.set(env.ptyId, flight)
    }
    env.stub.insert('mail')
    env.runtime.notifyMessageArrived(env.handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(50)
    if (flight) {
      expect(settle.parkedMessageRedeliveriesByPtyId.get(env.ptyId)?.size).toBe(1)
      settle.settlePendingMessageDelivery(env.ptyId, flight)
    }
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    if (entry === 'absence') {
      expect(probePtyLiveness).toHaveBeenCalled()
    }
    expect(pointerWrites(env.write, env.ptyId)).toHaveLength(0)
    expect(enterWrites(env.write, env.ptyId)).toHaveLength(0)
    expect(priv(env.runtime).withheldDeliveryAttemptsByHandle.get(env.handle)?.reason).toBe(
      'anchored_confirm_inconclusive'
    )
  })
})

describe("R270 final polish: the anchored route's generic list is Claude's own trust wording only (F3)", () => {
  it.each([
    [
      "Codex's update prompt",
      '✨ Update available! 0.20.0 -> 0.21.0\r\nSee the release notes.\r\nPress enter to continue\r\n'
    ],
    [
      "Codex's directory-trust prompt",
      'Do you trust the contents of this directory?\r\n› 1. Yes, continue\r\n  2. No, quit\r\nPress enter to continue\r\n'
    ],
    [
      'a reply quoting a permission prompt',
      '⏺ The deploy step shows "permission required" and offers allow once, allow always or deny — I chose deny.\r\n\r\n> \r\n'
    ],
    [
      'a reply quoting another agent',
      '⏺ After the sandbox change Codex printed "press enter to continue"; nothing else is pending.\r\n\r\n> \r\n'
    ]
  ])('%s on an anchored pane no longer withholds it', async (_name, screen) => {
    vi.useFakeTimers()
    const ptyId = `pty-r270-other-${_name.length}`
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    runtime.seedTerminalRestoreTail(ptyId, { text: screen })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId)).toHaveLength(1)
    expect(enterWrites(write, ptyId)).toHaveLength(1)
  })

  it("Claude's own older trust wording, even quoted in a reply, still withholds the anchored pane", async () => {
    vi.useFakeTimers()
    const ptyId = 'pty-r270-claude-trust-quoted'
    const { runtime, write, handle, stub } = await anchoredPane(ptyId)
    runtime.seedTerminalRestoreTail(ptyId, {
      text: '⏺ Claude asks "Do you trust the files in this folder?" once per repo.\r\n\r\n> \r\n'
    })
    stub.insert('mail')
    runtime.notifyMessageArrived(handle, 'status', null, null)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 100)
    expect(pointerWrites(write, ptyId)).toHaveLength(0)
    expect(snapshot(runtime, stub).withheldReason).toBe('blocked_modal')
  })
})
