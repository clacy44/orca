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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

const WORKTREE_ID = 'repo-launch-fence::/tmp/probe-worktree'
const TAB_ID = 'tab-launch-fence-1'
const LEAF_ID = '44444444-4444-4444-8444-444444444444'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-launch-fence-1'
// [B2a/b] the floating-terminal sentinel resolves a workspace scope with no store/repo lookup
// (resolveTerminalWorkspaceLaunchTarget), so the real createTerminal path runs with none of the
// fixture ceremony a repo-backed selector needs — same idiom as
// orca-runtime-headless-hydration-repo-gate.test.ts.
const REAL_PATH_SELECTOR = `id:${FLOATING_TERMINAL_WORKTREE_ID}`

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
    { worktreeId?: string; launchAgent?: string; launchPromptFenceSince?: number | null }
  >
  withheldDeliveryAttemptsByHandle: Map<string, { reason: string }>
  pendingMobileTerminalCreatesByKey: Map<string, { startupCommand?: string }>
  deliverPendingStartupCommandToBareRendererPty: (worktreeId: string, tabId: string) => void
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

// [B2a/b] Drives the real `createTerminal` background-spawn path (the arm sites at
// orca-runtime.ts:~29200/29221) instead of hand-stamping `launchPromptFenceSince` on the pty
// record — the fake controller's `spawn` returns `spawnPtyId` so the resulting pty record is
// reachable by the same PTY_ID the rest of the suite already keys off.
function setUpForRealPath(
  write: ReturnType<typeof vi.fn>,
  spawnPtyId: string
): { runtime: OrcaRuntimeService; db: OrchestrationDb } {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController(
    makeController(write, { spawn: vi.fn(async () => ({ id: spawnPtyId })) }) as never
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
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

  // [B2 (b) NO-COMMAND] Replaces the old Case C (which hand-stamped `pty.launchAgent = 'claude'`
  // with no fence armed) with the same regression guard driven through the REAL createTerminal
  // path: an agent-tab create with no launch command must leave the fence unarmed and preserve
  // today's first-idle-title delivery — the C4a/29200 arm site's own `launchOpts.command` guard.
  it("Case C (B2b): NO-COMMAND — createTerminal with no launch command leaves the fence unarmed; today's first-idle-title delivery is unchanged", async () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const setup = setUpForRealPath(write, PTY_ID)
    db = setup.db
    const { runtime } = setup

    await runtime.createTerminal(REAL_PATH_SELECTOR, {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'shared' },
      launchAgent: 'claude' as never,
      // No `command` — the C4a/29200 arm site requires both `launchAgent === 'claude'` AND a
      // truthy `command`; this proves the guard, not a hand-set fixture.
      tabId: TAB_ID,
      leafId: LEAF_ID
    })

    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    expect(pty.launchAgent).toBe('claude')
    expect(pty.launchPromptFenceSince ?? null).toBeNull()

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

  // [B2 (a) ARM-THROUGH-THE-REAL-PATH, LR-042] Drives the production createTerminal path with a
  // launch command all the way to the E2/N2 stamp sites (~orca-runtime.ts:29200/29221) — no
  // manual `launchPromptFenceSince` assignment anywhere in this test.
  it('Case D (B2a): ARM-THROUGH-THE-REAL-PATH — createTerminal with a launch command arms the fence at the real stamp site', async () => {
    vi.useFakeTimers()
    const write = vi.fn(() => true)
    const setup = setUpForRealPath(write, PTY_ID)
    db = setup.db
    const { runtime } = setup

    await runtime.createTerminal(REAL_PATH_SELECTOR, {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'shared' },
      launchAgent: 'claude' as never,
      command: 'claude',
      tabId: TAB_ID,
      leafId: LEAF_ID
    })

    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    // Armed by the real stamp site — not by a manual assignment (LR-042 red-proof covers this).
    expect(pty.launchPromptFenceSince).not.toBeNull()

    // zsh preexec TAB title: the shell retitles itself to the command about to run — still fenced.
    runtime.onPtyData(PTY_ID, '\x1b]0;claude\x07', 100)
    runtime.writeHostNoticeToPane(
      PANE_KEY,
      'Session adopted from tabH:leaf-old (SAME_GEN_PTY_ABSENCE).',
      { rateKey: 'session_adopted' }
    )
    expect(pointerCalls(write, PTY_ID)).toHaveLength(0)

    // Why a title in between: retry is driven off a status TRANSITION (idle->!idle->idle), not
    // merely off the fence clearing — a bare shell prompt breaks the idle streak the same way
    // Case A's intermediate titles do.
    runtime.onPtyData(PTY_ID, '\x1b]0;~\x07', 101)

    // Claude's OWN idle title clears the fence and releases the queued pointer exactly once.
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ vps-services\x07', 103)
    expect(pointerCalls(write, PTY_ID)).toHaveLength(1)
    vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(enterCalls(write, PTY_ID)).toHaveLength(1)
  })

  // [B2 (c) N2] The renderer pty:spawn path arms via deliverPendingStartupCommandToBareRendererPty
  // — the site that actually writes the startup command into the pty (orca-runtime.ts:~30396),
  // since registerPty's own stamp site (~11069) carries no typed command on this path.
  it('Case E (B2c/N2): the renderer pty:spawn path with a startup command → armed at the write site', () => {
    vi.useFakeTimers()
    const write = vi.fn((_ptyId: string, _data: string) => true)
    const setup = setUp(write)
    db = setup.db
    const { runtime } = setup

    internals(runtime).registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
    const pty = internals(runtime).ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('fixture setup failed: no pty record for ptyId')
    }
    // registerPty's own stamp (~11069) is what would set this on a real renderer spawn carrying
    // an agentLaunchAuthority; simulated directly here since this test targets the delivery site.
    pty.launchAgent = 'claude'

    internals(runtime).pendingMobileTerminalCreatesByKey.set(`${WORKTREE_ID}::${TAB_ID}`, {
      startupCommand: 'claude --resume abc'
    })
    internals(runtime).deliverPendingStartupCommandToBareRendererPty(WORKTREE_ID, TAB_ID)

    expect(
      write.mock.calls.some((call) => call[0] === PTY_ID && call[1] === 'claude --resume abc')
    ).toBe(true)
    expect(pty.launchPromptFenceSince).not.toBeNull()
  })
})
