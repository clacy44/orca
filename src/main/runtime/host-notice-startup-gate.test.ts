/**
 * D-R194: a host notice written to a pane whose agent has not yet been observed live this
 * generation must never be typed into the pty. Before this fix, sendHostNoticeToTarget called
 * the low-level deliverPendingMessages(target) directly, which carries no idle/observed-live
 * gate of its own — every such gate lives in its callers. The chair-restore adoption banner
 * (fired post-spawn) raced attemptMidTurnClaudeDelivery's modal probe: at t=0 the pty tail has
 * no dialog text to match yet, so the probe falls through, the pointer is written, and the
 * armed Enter (AGENT_PROMPT_SUBMIT_DELAY_MS later) answers the folder-trust dialog that
 * rendered in between, exiting the pane. Fix: route through deliverPendingMessagesForHandle,
 * the same idle + observedLive ladder every other wake uses — an unobserved pane lands in
 * `awaiting_idle_edge` and the pane's own first observed idle edge delivers it exactly once.
 *
 * Harness: copies the fixture idioms of s10-15-leafless-delivery.test.ts (makeController,
 * pointerCalls, enterCalls, driveIdleTitle, fake timers) and a real OrchestrationDb(':memory:')
 * as in orca-runtime-orphaned-identity-wake.test.ts (writeHostNoticeToPane needs real
 * checkAndBumpRate + insertMessage).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'

const WORKTREE_ID = 'repo-notice::/tmp/probe-worktree'
const TAB_ID = 'tab-notice-1'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-notice-1'

type RuntimeInternals = {
  registerPty: (
    ptyId: string,
    worktreeId: string,
    connectionId: string | null,
    binding?: { tabId: string; leafId: string }
  ) => void
  handleByPtyId: Map<string, string>
  ptysById: Map<string, { launchAgent?: string }>
  withheldDeliveryAttemptsByHandle: Map<string, { reason: string }>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeController(write: ReturnType<typeof vi.fn>, extra?: Record<string, unknown>) {
  return {
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => []),
    ...extra
  }
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

describe('D-R194: host notices go through the gated delivery entry', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
    vi.useRealTimers()
  })

  it('Case A: withholds a notice typed to a pane never observed live this generation, delivers exactly once at its first idle edge', () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)

    internals(runtime).registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })

    // lastAgentStatus === null, lastAgentStatusObservedLive === false: no title driven yet.
    runtime.writeHostNoticeToPane(PANE_KEY, 'Session adopted from tabH:leaf-old (D1).', {
      rateKey: 'session_adopted'
    })
    const handle = internals(runtime).handleByPtyId.get(PTY_ID)
    if (!handle) {
      throw new Error('fixture setup failed: no handle registered for pty')
    }

    // RED at 8dce0e4619: these fail with length 1 — the notice was typed straight into the pty.
    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(0)

    // Queued, not dropped.
    expect(runtime.hasParkedDelivery(handle)).toBe(true)
    expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
      'awaiting_idle_edge'
    )

    // The pane's own first observed idle edge delivers it exactly once.
    driveIdleTitle(runtime, PTY_ID)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(1)

    // A second idle edge must not double-deliver.
    driveIdleTitle(runtime, PTY_ID)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
  })

  it('Case B: same withhold on the production Claude mid-turn route (confirmForegroundProcess live)', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    runtime.setPtyController(
      makeController(write, {
        confirmForegroundProcess: async () => 'claude',
        hasPty: () => true
      }) as never
    )
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)

    internals(runtime).registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    pty.launchAgent = 'claude'

    runtime.writeHostNoticeToPane(PANE_KEY, 'Session adopted from tabH:leaf-old (D1).', {
      rateKey: 'session_adopted'
    })
    const handle = internals(runtime).handleByPtyId.get(PTY_ID)
    if (!handle) {
      throw new Error('fixture setup failed: no handle registered for pty')
    }

    // The write goes through the async foreground guard: flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(0)

    expect(runtime.hasParkedDelivery(handle)).toBe(true)
    expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
      'awaiting_idle_edge'
    )

    driveIdleTitle(runtime, PTY_ID)
    await Promise.resolve()
    await Promise.resolve()
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(1)

    driveIdleTitle(runtime, PTY_ID)
    await Promise.resolve()
    await Promise.resolve()
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
  })
})
