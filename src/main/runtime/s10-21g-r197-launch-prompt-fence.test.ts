/**
 * D-R197: `orca chairs restore` spawns a shell pane and types `claude … --resume …` into it.
 * zsh auto-title retitles the tab `claude` before Claude exists; `detectAgentStatusFromTitle`
 * classifies that bare token as an idle AGENT_NAMES title, so `applyTrackedPtyTitle`'s idle edge
 * releases the pending pointer straight into the shell — and the armed Enter 500ms later answers
 * Claude Code's own folder-trust dialog ("No, exit"). Fix: a launch-prompt fence armed the
 * moment a launch command is delivered into the pane, cleared only by Claude-authored evidence
 * (its own `CLAUDE_IDLE`/spinner title, or a fresh hook status received after the launch),
 * consulted by both the gated ladder (deliverPendingMessagesForHandle) and the low-level,
 * ungated writer (deliverPendingMessages) — the choke point every caller funnels through.
 *
 * Harness: fixture idioms copied from host-notice-startup-gate.test.ts (makeController,
 * pointerCalls, enterCalls, a real OrchestrationDb(':memory:'), fake timers).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'

const WORKTREE_ID = 'repo-launch-fence::/tmp/probe-worktree'
const TAB_ID = 'tab-launch-fence-1'
const LEAF_ID = '44444444-4444-4444-8444-444444444444'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-launch-fence-1'

type RuntimeInternals = {
  registerPty: (
    ptyId: string,
    worktreeId: string,
    connectionId: string | null,
    binding?: { tabId: string; leafId: string }
  ) => void
  handleByPtyId: Map<string, string>
  ptysById: Map<string, { launchAgent?: string; launchPromptFenceSince?: number | null }>
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

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('orca orchestration check')
  )
}

function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

function setUp(write: ReturnType<typeof vi.fn>): {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
} {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController(makeController(write) as never)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  return { runtime, db }
}

describe('R197: launch-prompt fence — no host bytes into a pane until Claude is at its own prompt', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.useRealTimers()
  })

  it('Case A: a shell-authored `claude` title is not the agent — the fence holds until CLAUDE_IDLE', () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const setup = setUp(write)
    db = setup.db
    const { runtime } = setup

    internals(runtime).registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    pty.launchAgent = 'claude'
    // Simulates E2's arm at the launchAgent stamp site: a launch command was just delivered.
    pty.launchPromptFenceSince = Date.now()

    // zsh preexec TAB title: the shell retitles itself to the command about to run.
    runtime.onPtyData(PTY_ID, '\x1b]0;claude\x07', 100)

    runtime.writeHostNoticeToPane(
      PANE_KEY,
      'Session adopted from tabH:leaf-old (SAME_GEN_PTY_ABSENCE).',
      { rateKey: 'session_adopted' }
    )
    const handle = internals(runtime).handleByPtyId.get(PTY_ID)
    if (!handle) {
      throw new Error('fixture setup failed: no handle registered for pty')
    }

    // RED at base (a0a3ea0de4): `launchPromptFenceSince` does not exist on the record, so the
    // assignment above is inert and the `claude` title's idle edge types the pointer straight in.
    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(0)

    expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
      'awaiting_launch_prompt'
    )

    // Neither a precmd prompt title nor an OSC2 window title containing "permission" is
    // Claude-authored evidence — the fence must still hold.
    runtime.onPtyData(PTY_ID, '\x1b]0;~\x07', 101)
    runtime.onPtyData(
      PTY_ID,
      '\x1b]0;claude --dangerously-skip-permissions --model claude-opus-5\x07',
      102
    )
    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)

    // Claude's OWN idle title clears the fence and releases the queued pointer exactly once.
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ vps-services\x07', 103)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(1)

    runtime.onPtyData(PTY_ID, '\x1b]0;✳ vps-services\x07', 104)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
  })

  it('Case B: the fence outranks the idle-edge ladder — reason is awaiting_launch_prompt, not awaiting_idle_edge', () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const setup = setUp(write)
    db = setup.db
    const { runtime } = setup

    internals(runtime).registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    pty.launchAgent = 'claude'
    pty.launchPromptFenceSince = Date.now()

    // Notice written BEFORE any title at all — pane never observed live this generation either,
    // so without the fence this would land in 'awaiting_idle_edge'.
    runtime.writeHostNoticeToPane(PANE_KEY, 'Session adopted from tabH:leaf-old (D1).', {
      rateKey: 'session_adopted'
    })
    const handle = internals(runtime).handleByPtyId.get(PTY_ID)
    if (!handle) {
      throw new Error('fixture setup failed: no handle registered for pty')
    }

    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)
    expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
      'awaiting_launch_prompt'
    )
  })

  it('Case C: regression guard — with no fence armed, delivery at the first idle title is unchanged', () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const setup = setUp(write)
    db = setup.db
    const { runtime } = setup

    internals(runtime).registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    pty.launchAgent = 'claude'
    // No fence armed — pins that today's un-launched-command behavior is untouched.

    runtime.writeHostNoticeToPane(PANE_KEY, 'Session adopted from tabH:leaf-old (D1).', {
      rateKey: 'session_adopted'
    })
    const handle = internals(runtime).handleByPtyId.get(PTY_ID)
    if (!handle) {
      throw new Error('fixture setup failed: no handle registered for pty')
    }

    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)
    expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
      'awaiting_idle_edge'
    )

    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 101)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(1)
  })
})
