/**
 * D-R201/R185: on a pane Orca launched as an agent, a title that is exactly one agent-name
 * token or an echo of the pane's own launch command (oh-my-zsh preexec OSC1/OSC2, or the zsh
 * truncated-prefix form) is the SHELL talking, not the agent — never status evidence. The
 * launch-prompt fence (R197) also gates tui-idle satisfaction and sendTerminalAgentPrompt, and
 * is now armed uniformly from noteTerminalSpawnCommand.
 *
 * Harness: fixture idioms copied verbatim from s10-21g-r197-launch-prompt-fence.test.ts:33-105
 * (makeController, pointerCalls, enterCalls, setUp, a real OrchestrationDb(':memory:'), fake
 * timers) — that file is not edited.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

const WORKTREE_ID = 'repo-shell-title::/tmp/probe-worktree'
const TAB_ID = 'tab-shell-title-1'
const LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-shell-title-1'

type RuntimeInternals = {
  registerPty: (
    ptyId: string,
    worktreeId: string,
    connectionId: string | null,
    binding?: { tabId: string; leafId: string }
  ) => void
  handleByPtyId: Map<string, string>
  ptysById: Map<
    string,
    {
      worktreeId?: string
      launchAgent?: string | null
      launchPromptFenceSince?: number | null
      lastAgentStatus?: string | null
      lastAgentStatusObservedLive?: boolean
    }
  >
  withheldDeliveryAttemptsByHandle: Map<string, { reason: string }>
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

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('orca orchestration check')
  )
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

const LAUNCH_COMMAND =
  'claude --dangerously-skip-permissions --model claude-opus-5 --resume 0f9e1234-aaaa-bbbb-cccc-000000000000'

describe('R185/R200: shell-authored titles are not status evidence; tui-idle and prompts honour the fence', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.useRealTimers()
  })

  it('Case T-C: launch-command echo titles (full line, truncated, and OSC1 first-token) leave status untouched on a launched pane', () => {
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
    runtime.noteTerminalSpawnCommand(PTY_ID, LAUNCH_COMMAND)

    runtime.writeHostNoticeToPane(
      PANE_KEY,
      'Session adopted from tabH:leaf-old (SAME_GEN_PTY_ABSENCE).',
      { rateKey: 'session_adopted' }
    )

    // RED at base: `--dangerously-skip-permissions` substring-matches "permission" in the pure
    // detector's containsAny check, classifying this OSC2 echo as 'permission'.
    runtime.onPtyData(PTY_ID, `\x1b]2;${LAUNCH_COMMAND}\x07`, 100)
    expect(pty.lastAgentStatus ?? null).toBeNull()
    expect(pty.lastAgentStatusObservedLive).toBe(true)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)

    // The zsh %100>...> truncated-prefix form of the same OSC2 line.
    const truncated = `${LAUNCH_COMMAND.slice(0, 100)}...`
    runtime.onPtyData(PTY_ID, `\x1b]2;${truncated}\x07`, 101)
    expect(pty.lastAgentStatus ?? null).toBeNull()

    // RED at base: the bare OSC1 command-name echo classifies as an idle AGENT_NAMES title,
    // firing the idle edge and typing the pending pointer straight into the shell.
    runtime.onPtyData(PTY_ID, '\x1b]1;claude\x07', 102)
    expect(pty.lastAgentStatus ?? null).toBeNull()
    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)
    expect(pty.lastAgentStatusObservedLive).toBe(true)
  })

  it('Case T-D: a `claude --resume <uuid>` OSC2 echo on a launched pane is not status evidence', () => {
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
    const command = 'claude --resume 0f9e1234-aaaa-bbbb-cccc-000000000000'
    runtime.noteTerminalSpawnCommand(PTY_ID, command)

    // RED at base: the name-token fallback classifies this 'idle'.
    runtime.onPtyData(PTY_ID, `\x1b]2;${command}\x07`, 100)
    expect(pty.lastAgentStatus ?? null).toBeNull()
  })

  it('Case T-E (CONTROL): a bare `claude` OSC1 title on a pane with no launchAgent still classifies idle exactly as today', () => {
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
    expect(pty.launchAgent ?? null).toBeNull()

    runtime.onPtyData(PTY_ID, '\x1b]1;claude\x07', 100)
    expect(pty.lastAgentStatus).toBe('idle')
  })

  it('Case T-F: noteTerminalSpawnCommand arms the fence for launchAgent claude, not for codex', () => {
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
    // RED at base: `launchPromptFenceSince` is never touched by noteTerminalSpawnCommand.
    runtime.noteTerminalSpawnCommand(PTY_ID, 'claude --resume abc')
    expect(pty.launchPromptFenceSince ?? null).not.toBeNull()

    const codexPtyId = 'pty-shell-title-codex'
    internals(runtime).registerPty(codexPtyId, WORKTREE_ID, null, {
      tabId: 'tab-shell-title-codex',
      leafId: '66666666-6666-4666-8666-666666666666'
    })
    const codexPty = internals(runtime).ptysById.get(codexPtyId)
    if (!codexPty) {
      throw new Error('fixture setup failed: no pty record for codex ptyId')
    }
    codexPty.launchAgent = 'codex'
    runtime.noteTerminalSpawnCommand(codexPtyId, 'codex --resume abc')
    expect(codexPty.launchPromptFenceSince ?? null).toBeNull()
  })

  it('Case T-G: sendTerminalAgentPrompt refuses while fenced, writes after the agent prompt clears it, and refuses on a blocked modal', async () => {
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
    runtime.noteTerminalSpawnCommand(PTY_ID, 'claude --resume abc')
    expect(pty.launchPromptFenceSince ?? null).not.toBeNull()
    const handle = runtime.preAllocateHandleForPty(PTY_ID)

    // RED at base: no fence exists, so this writes immediately.
    await expect(runtime.sendTerminalAgentPrompt(handle, 'hello')).rejects.toThrow(
      'terminal_awaiting_launch_prompt'
    )
    expect(write).not.toHaveBeenCalled()

    // Claude's OWN idle title clears the fence.
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ x\x07', 100)
    expect(pty.launchPromptFenceSince ?? null).toBeNull()

    const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'hello')
    // Why 8500ms: this pane's launchAgent is 'claude', so writeTerminalAgentPrompt's render
    // gate is active and has no render marker to observe here — it settles on its own hard
    // timeout (CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS = 8000ms), not AGENT_PROMPT_SUBMIT_DELAY_MS.
    await vi.advanceTimersByTimeAsync(8_500)
    await sendPromise
    expect(write).toHaveBeenCalled()

    // A folder-trust prompt in the tail refuses too, independent of the fence.
    const modalPtyId = 'pty-shell-title-modal'
    internals(runtime).registerPty(modalPtyId, WORKTREE_ID, null, {
      tabId: 'tab-shell-title-modal',
      leafId: '77777777-7777-4777-8777-777777777777'
    })
    const modalPty = internals(runtime).ptysById.get(modalPtyId)
    if (!modalPty) {
      throw new Error('fixture setup failed: no pty record for modal ptyId')
    }
    // No launchAgent/fence on this pane — isolates the modal-only refusal.
    runtime.onPtyData(modalPtyId, 'Do you trust the files in this folder?\r\n', 200)
    const modalHandle = runtime.preAllocateHandleForPty(modalPtyId)
    await expect(runtime.sendTerminalAgentPrompt(modalHandle, 'hello')).rejects.toThrow(
      'terminal_blocked_modal'
    )
  })

  it('Case T-H: waitForTerminal tui-idle is not satisfied while fenced even with a seeded idle status, and satisfies after the agent prompt clears it', async () => {
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
    runtime.noteTerminalSpawnCommand(PTY_ID, 'claude --resume abc')
    expect(pty.launchPromptFenceSince ?? null).not.toBeNull()
    // A seeded idle status must not open the wait while the fence holds — RED at base, which
    // has no fence at all and resolves immediately off this seeded value.
    pty.lastAgentStatus = 'idle'
    const handle = runtime.preAllocateHandleForPty(PTY_ID)

    const waitPromise = runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })
    const rejection = expect(waitPromise).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(5_000)
    await rejection

    // Claude's OWN idle title clears the fence; the wait now satisfies immediately.
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ x\x07', 100)
    expect(pty.launchPromptFenceSince ?? null).toBeNull()
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
    ).resolves.toMatchObject({ handle })
  })
})
