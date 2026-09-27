/**
 * I-24-1 FIX-3 (S-24-1, the headline safety defect): the delivery paths' own modal check
 * (attemptMidTurnClaudeDelivery, probeTuiIdleForDelivery) scanned the WHOLE retained tail
 * (up to 2,000 lines / 256 KiB), not just the pane's current screen, and had no marker for
 * Claude Code's own dialogs (only Codex/Antigravity/Cursor had one) — so stale trust text many
 * screens up blocked delivery forever (E4), and a live Claude permission/question prompt on the
 * CURRENT screen was never recognized at all and got typed into.
 *
 * Harness: mirrors s10-15-midturn-delivery.test.ts's headless-pty fixtures exactly (real
 * OrcaRuntimeService, an injected pty controller, an orchestration-db stub keyed by `to_handle`,
 * and direct `pty.tailBuffer` mutation the way that suite's own modal test — "a busy Claude pane
 * with a blocked-modal tail withholds" — already does).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree-i24-dialog'

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

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null; paneKey?: string | null }
  ) => PtyRecordForTest
  issuePtyHandle: (pty: unknown) => string
  withheldDeliveryAttemptsByHandle: Map<
    string,
    { at: number; reason: string; count?: number; firstAt?: number }
  >
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

function makeOrchestrationDbStub(toHandle: () => string) {
  const rows: StoredMessageRow[] = []
  return {
    rows,
    insert(subject: string): void {
      rows.push({
        id: `msg_${rows.length + 1}`,
        run_id: 'run_test',
        from_handle: 'term_sender',
        to_handle: toHandle(),
        subject,
        body: '',
        type: 'status',
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
      getUndeliveredUnreadMailboxHandles: () => [],
      getActiveCoordinatorRun: () => null,
      getCurrentRunForPane: () => undefined,
      getActiveDispatchForTerminal: () => null,
      getActiveDispatchForIdentity: () => undefined,
      findActiveRemoteAttachmentForPane: () => undefined,
      listDispatchInputObservationTargets: () => [],
      getRecipientPaneKeyForBareHandle: () => null,
      markAsDelivered: vi.fn(),
      findOrphanedIdentityCandidate: () => undefined,
      close: () => {}
    }
  }
}

function registerHeadlessPty(
  runtime: OrcaRuntimeService,
  ptyId: string
): { handle: string; pty: PtyRecordForTest } {
  const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
  return { handle: internals(runtime).issuePtyHandle(pty), pty }
}

function driveWorkingTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Claude working\x07', 100)
}

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('[from:')
  )
}

type DialogPane = {
  runtime: OrcaRuntimeService
  handle: string
  pty: PtyRecordForTest
  stub: ReturnType<typeof makeOrchestrationDbStub>
}

/** Observed-live Claude pane, status null (busy title only, no hook), with an empty tail the
 *  caller fills in. */
function setUpDialogPane(ptyId: string, write: ReturnType<typeof vi.fn>): DialogPane {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController(makeController(write) as never)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const { handle, pty } = registerHeadlessPty(runtime, ptyId)
  pty.launchAgent = 'claude'
  const stub = makeOrchestrationDbStub(() => handle)
  runtime.setOrchestrationDb(stub.db as never)
  driveWorkingTitle(runtime, ptyId)
  return { runtime, handle, pty, stub }
}

function deliverAndAssertDelivered(
  dialog: DialogPane,
  write: ReturnType<typeof vi.fn>,
  ptyId: string
): void {
  dialog.stub.insert('mail')
  dialog.runtime.deliverPendingMessagesForHandle(dialog.handle)
  expect(pointerCalls(write, ptyId)).toHaveLength(1)
}

function deliverAndAssertWithheld(
  dialog: DialogPane,
  write: ReturnType<typeof vi.fn>,
  reason: string
): void {
  dialog.stub.insert('mail')
  dialog.runtime.deliverPendingMessagesForHandle(dialog.handle)
  expect(write).not.toHaveBeenCalled()
  const withheld = internals(dialog.runtime).withheldDeliveryAttemptsByHandle.get(dialog.handle)
  expect(withheld?.reason).toBe(reason)
}

const TRUST_DIALOG_LINES = [
  'Quick safety check',
  'Is this a project you created or one you trust?',
  '❯ No, exit',
  '  Yes, I trust this folder'
]

const PERMISSION_PROMPT_LINES = [
  'Bash command',
  '  rm -rf build',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again",
  '  3. No (esc)'
]

const QUESTION_MENU_LINES = [
  '☐ Command intent',
  "It's safe/reversible — go ahead?",
  "❯ 1. It's safe/reversible — go ahead",
  '  2. Stop and ask me',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
]

describe('I-24-1 FIX-3 (S-24-1): delivery-path modal scan is CURRENT SCREEN ONLY, plus Claude markers', () => {
  it('T4: trust-dialog text 1,500 lines up no longer blocks delivery once only the last screen is scanned', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-i24-t4-stale'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      const filler = Array.from({ length: 1500 }, (_, i) => `line ${i}: build output`)
      dialog.pty.tailBuffer = [...TRUST_DIALOG_LINES, ...filler]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertDelivered(dialog, write, ptyId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('T4-neg-1: a dialog actually on the last screen still blocks', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-i24-t4-neg-onscreen'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      const filler = Array.from({ length: 40 }, (_, i) => `line ${i}: build output`)
      dialog.pty.tailBuffer = [...filler, ...TRUST_DIALOG_LINES]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression pin (I-24-1 EVIDENCE): "Claude's own permission prompt and question prompt do not
  // cause starvation at 828 ... the mid-turn ... paths type the pointer and Enter into them." RED
  // today (pre-FIX-3): no sentinel matches this text at all, so it delivers straight through.
  it('T4-neg-2 (regression, S-24-1): a Claude permission prompt on the last screen must withhold, never be typed into', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-i24-t4-neg-permission'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = [...PERMISSION_PROMPT_LINES]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  it('T4-neg-3: the AskUserQuestion pause menu on the last screen withholds too', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-i24-t4-neg-question'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = [...QUESTION_MENU_LINES]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  it('T4-neg-4: an ordinary busy tail with no dialog text still delivers (no false positive from the Claude markers)', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-i24-t4-neg-ordinary'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = ['Running tests...', '12 passed, 0 failed', '$ ']
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertDelivered(dialog, write, ptyId)
    } finally {
      vi.useRealTimers()
    }
  })
})

// [G1 B4] The reviewer's P3/P4b/P5 findings ported as lane tests, failing first on 8fa8837039.
describe('G1 B4: broadened marker, the Enter re-check, and the L2 idle edge', () => {
  function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
    return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
  }

  // G1 P3 V2/V4/V6: the OLD marker (`❯\s*1\.`) only matched a highlighted FIRST option — any
  // Claude menu whose highlighted row is not row 1 (a common shape: the safer/second option
  // pre-selected) reached the write unblocked.
  it('P3 V2: a permission prompt highlighted on option 2 (not 1) withholds', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-g1-p3-v2'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = [
        'Do you want to proceed?',
        '  1. Yes',
        "❯ 2. Yes, and don't ask again for rm commands in this project",
        '  3. No, and tell Claude what to do differently (esc)'
      ]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  it('P3 V4: a plan-approval prompt highlighted on option 2 withholds', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-g1-p3-v4'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = [
        'Would you like to proceed?',
        '  1. Yes, and auto-accept edits',
        '❯ 2. Yes, and manually approve edits',
        '  3. No, keep planning'
      ]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  it('P3 V6: a wrapped question, highlighted on option 2, still withholds', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-g1-p3-v6'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = [
        'Do you want',
        'to proceed?',
        '  1. Yes',
        "❯ 2. Yes, and don't ask",
        '     again for rm',
        '  3. No (esc)'
      ]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  // G1 N1 control: "do you want to" prose with NO highlighted numbered row must still deliver —
  // an E1 chair whose own reply asks the owner a plain question must not re-starve forever.
  it('N1: "do you want to" prose with no highlighted row still delivers', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-g1-n1-prose'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = [
        '⏺ Build is green. Do you want to merge this now, or wait for review?',
        '',
        '> '
      ]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertDelivered(dialog, write, ptyId)
    } finally {
      vi.useRealTimers()
    }
  })

  // G1 P4b: the pointer write and the delayed '\r' bracket a real window
  // (AGENT_PROMPT_SUBMIT_DELAY_MS) in which Claude can paint its own dialog — e.g. a
  // PostToolUse turn-boundary pointer immediately followed by a PermissionRequest for the next
  // tool. Before B4, the Enter timer wrote '\r' with no re-check at all.
  it('P4b: a dialog painted between the pointer and the Enter must skip the Enter and roll back', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-g1-p4b'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      dialog.pty.tailBuffer = ['$ '] // No dialog yet — the pointer is authorized to write.
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      dialog.stub.insert('mail')
      dialog.runtime.deliverPendingMessagesForHandle(dialog.handle)
      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      expect(enterCalls(write, ptyId)).toHaveLength(0)
      // Claude paints the PermissionRequest dialog inside the Enter delay.
      dialog.pty.tailBuffer = [...PERMISSION_PROMPT_LINES]
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(enterCalls(write, ptyId)).toHaveLength(0)
      const withheld = internals(dialog.runtime).withheldDeliveryAttemptsByHandle.get(dialog.handle)
      expect(withheld?.reason).toBe('blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })

  // G1 P5: the L2 idle-and-observed-live edge (deliverPendingMessagesForHandle's own leaf/pty
  // branches, not attemptMidTurnClaudeDelivery) had NO dialog check at all before B4 — an idle
  // Claude title with a permission prompt still painted on screen typed straight through.
  it('P5: an idle Claude title with a prompt still on screen is withheld, not typed into', () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-g1-p5'
      const write = vi.fn(() => true)
      const dialog = setUpDialogPane(ptyId, write)
      // Idle title observed live (L2's own authorizing edge) while the dialog is still painted.
      dialog.runtime.onPtyData(ptyId, '\x1b]0;✳ Claude Code\x07', 200)
      dialog.pty.tailBuffer = [...PERMISSION_PROMPT_LINES]
      dialog.pty.tailPartialLine = ''
      dialog.pty.preview = ''
      deliverAndAssertWithheld(dialog, write, 'blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── S-24-1 rebuilt on principled signals (b3): the A2-B1 L2 regressions, A2-B2's self-echo, the
// L2 withheld record (v) and the held Enter (iv). Every case failed against the 7d0d3e46e9 runtime
// except the controls and four pins that also hold there — the fresh waiting row, the no-op record
// clear, the rollback and the respawn during the hold — each of which fails under its own mutant
// instead (see the b3 return).
const IDLE_PANE_KEY = 'tab-i24-dialog:25252525-2525-4252-8252-252525252525'
const MIN = 60_000

type IdlePane = DialogPane & { write: ReturnType<typeof vi.fn> }

/** Observed-live Claude pane on its own prompt (the ✳ title, L2's authorizing edge) — or, with
 *  `working`, a busy one (the mid-turn path). `echo` makes the pane print the host's pointer back
 *  the way Claude's composer does. */
function setUpIdlePane(
  ptyId: string,
  opts: { hooks?: () => AgentStatusIpcPayload[]; echo?: boolean; working?: boolean } = {}
): IdlePane {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: opts.hooks ?? (() => [])
  })
  const write = vi.fn((_p: string, _d: string) => true)
  runtime.setPtyController(makeController(write) as never)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const pty = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
    connected: true,
    paneKey: IDLE_PANE_KEY
  })
  const handle = internals(runtime).issuePtyHandle(pty)
  pty.launchAgent = 'claude'
  const stub = makeOrchestrationDbStub(() => handle)
  runtime.setOrchestrationDb(stub.db as never)
  if (opts.echo) {
    write.mockImplementation((p: string, d: string) => {
      if (p === ptyId && d.includes('[from:')) {
        queueMicrotask(() =>
          runtime.onPtyData(ptyId, `\r\n> ${d.replace(/\n/g, '\r\n  ')}`, Date.now())
        )
      }
      return true
    })
  }
  runtime.onPtyData(
    ptyId,
    opts.working ? '\x1b]0;Claude working\x07' : '\x1b]0;✳ Claude Code\x07',
    100
  )
  return { runtime, handle, pty, stub, write }
}

function enterCallsOf(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

async function advanceBy(ms: number, step = 30_000): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t))
  }
}

function paintAfterPointer(pane: IdlePane, ptyId: string, lines: string[]): void {
  pane.write.mockImplementation((p: string, d: string) => {
    if (p === ptyId && d.includes('[from:')) {
      queueMicrotask(() => pane.runtime.onPtyData(ptyId, `${lines.join('\r\n')}\r\n`, Date.now()))
    }
    return true
  })
}

function scrollDialogAway(pane: IdlePane, ptyId: string): void {
  pane.runtime.onPtyData(ptyId, `${'\r\n'.repeat(30)}> `, Date.now())
}

describe('S-24-1 (ii) on the L2 idle edge: ordinary idle-screen text never withholds (A2-B1)', () => {
  it.each([
    ['control: a plain reply', ['⏺ Done. The build is green.', '', '> ']],
    [
      "the owner's numbered prompt echoed as `> 1.`",
      ['> 1. refactor the parser', '  2. add tests', '⏺ Both done; tests pass.', '', '> ']
    ],
    [
      'code in the reply',
      [
        '⏺ Changed the threshold:',
        '    if (ratio > 0.5) {',
        '      return retry()',
        '    }',
        '',
        '> '
      ]
    ],
    ['a version arrow', ['⏺ Bumped lodash 4.17.20 -> 4.17.21 and reran the suite.', '', '> ']]
  ])('%s: delivered, pointer and Enter', async (_name, screen) => {
    vi.useFakeTimers()
    try {
      const ptyId = `pty-a2b1-${screen.length}-${_name.length}`
      const pane = setUpIdlePane(ptyId)
      pane.runtime.onPtyData(ptyId, screen.join('\r\n'), Date.now())
      pane.stub.insert('status update')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(pointerCalls(pane.write, ptyId)).toHaveLength(1)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('S-24-1 (i): a Claude waiting row blocks only when not older than the latest live prompt title', () => {
  it('A2-B1 Q4: a stale waiting row (2 h, before the ✳ title) does not block the idle edge', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-q4-stale-waiting'
      const at = Date.now() - 2 * 60 * MIN
      const row = { paneKey: IDLE_PANE_KEY, state: 'waiting', prompt: '', agentType: 'claude' }
      const pane = setUpIdlePane(ptyId, {
        hooks: () => [{ ...row, connectionId: null, receivedAt: at, stateStartedAt: at } as never]
      })
      pane.runtime.onPtyData(
        ptyId,
        '⏺ Bash(rm -rf build)\r\n  ⎿  Interrupted by user\r\n\r\n> ',
        Date.now()
      )
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(pointerCalls(pane.write, ptyId)).toHaveLength(1)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a waiting row received after the ✳ title blocks, even with nothing recognisable on screen', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-q4-fresh-waiting'
      const rows: AgentStatusIpcPayload[] = []
      const pane = setUpIdlePane(ptyId, { hooks: () => rows })
      await vi.advanceTimersByTimeAsync(1_000)
      const at = Date.now()
      rows.push({
        paneKey: IDLE_PANE_KEY,
        state: 'waiting',
        prompt: '',
        agentType: 'claude',
        connectionId: null,
        receivedAt: at,
        stateStartedAt: at
      })
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      expect(pane.write).not.toHaveBeenCalled()
      expect(
        internals(pane.runtime).withheldDeliveryAttemptsByHandle.get(pane.handle)?.reason
      ).toBe('blocked_modal')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("S-24-1 (iii): the host's own echoed pointer never withholds later mail (A2-B2)", () => {
  it.each([
    ['p95 > 2.5s regression on /search', false],
    ['do you trust this folder layout?', false],
    ['do you trust this folder layout?', true],
    ['Enter to select the build target', false],
    ['status update', true]
  ])(
    'subject %j (busy pane: %s): both messages get pointer and Enter',
    async (subject, working) => {
      vi.useFakeTimers()
      try {
        const ptyId = `pty-a2b2-${subject.length}-${String(working)}`
        const pane = setUpIdlePane(ptyId, { echo: true, working })
        pane.stub.insert(subject)
        pane.runtime.deliverPendingMessagesForHandle(pane.handle)
        await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
        expect(pointerCalls(pane.write, ptyId)).toHaveLength(1)
        expect(enterCallsOf(pane.write, ptyId)).toHaveLength(1)
        pane.stub.rows[0]!.read = 1
        pane.stub.insert('second message')
        pane.runtime.deliverPendingMessagesForHandle(pane.handle)
        await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
        expect(pointerCalls(pane.write, ptyId)).toHaveLength(2)
        expect(enterCallsOf(pane.write, ptyId)).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('after a restart, the stranded echo of the very pointer being re-sent does not block it', async () => {
    vi.useFakeTimers()
    try {
      const subject = 'Enter to select the build target'
      const before = setUpIdlePane('pty-a2b2-before-restart')
      before.stub.insert(subject)
      before.runtime.deliverPendingMessagesForHandle(before.handle)
      const [, payload] = pointerCalls(before.write, 'pty-a2b2-before-restart')[0] as [
        string,
        string
      ]
      // A fresh runtime (main restart) knows nothing it wrote before, but the pane still shows
      // the unsubmitted pointer in Claude's composer.
      const ptyId = 'pty-a2b2-after-restart'
      const after = setUpIdlePane(ptyId)
      after.runtime.onPtyData(ptyId, `\r\n> ${payload.replace(/\n/g, '\r\n  ')}`, Date.now())
      after.stub.insert(subject)
      after.runtime.deliverPendingMessagesForHandle(after.handle)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(pointerCalls(after.write, ptyId)).toHaveLength(1)
      expect(enterCallsOf(after.write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('S-24-1 (v): a withheld L2 attempt keeps its record, so a stuck idle edge reads queued_starved', () => {
  it('a real dialog on an idle pane ages into queued_starved with its reason', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-l2-starved'
      const pane = setUpIdlePane(ptyId)
      pane.runtime.onPtyData(ptyId, PERMISSION_PROMPT_LINES.join('\r\n'), Date.now())
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      const first = internals(pane.runtime).withheldDeliveryAttemptsByHandle.get(pane.handle)
      expect(first?.reason).toBe('blocked_modal')
      await advanceBy(13 * MIN)
      const later = internals(pane.runtime).withheldDeliveryAttemptsByHandle.get(pane.handle)
      expect(later?.firstAt).toBe(first?.firstAt)
      expect(later?.count).toBeGreaterThan(1)
      const snap = pane.runtime.getMessageDeliverySnapshot(pane.stub.rows[0] as never)
      expect(snap.delivery).toBe('queued_starved')
      expect(snap.withheldReason).toBe('blocked_modal')
      expect(pane.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an attempt with nothing left to point clears a leftover record instead of keeping it', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-l2-noop'
      const pane = setUpIdlePane(ptyId)
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(1)
      const now = Date.now()
      internals(pane.runtime).withheldDeliveryAttemptsByHandle.set(pane.handle, {
        firstAt: now,
        at: now,
        count: 1,
        reason: 'pane_busy'
      })
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      expect(pointerCalls(pane.write, ptyId)).toHaveLength(1)
      expect(internals(pane.runtime).withheldDeliveryAttemptsByHandle.has(pane.handle)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('S-24-1 (iv): a dialog between the pointer and the Enter holds the Enter, bounded', () => {
  it('a dialog answered inside the hold gets the pointer submitted once — no second copy', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-hold-answered'
      const pane = setUpIdlePane(ptyId)
      paintAfterPointer(pane, ptyId, PERMISSION_PROMPT_LINES)
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1_500)
      scrollDialogAway(pane, ptyId)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(1)
      expect(pointerCalls(pane.write, ptyId)).toHaveLength(1)
      expect(pane.runtime.getMessageDeliverySnapshot(pane.stub.rows[0] as never).delivery).toBe(
        'pointed'
      )
      expect(internals(pane.runtime).withheldDeliveryAttemptsByHandle.has(pane.handle)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('R-rollback: a dialog outlasting the hold never gets the Enter, and the mail is pointed again once it closes', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-hold-rollback'
      const pane = setUpIdlePane(ptyId)
      paintAfterPointer(pane, ptyId, PERMISSION_PROMPT_LINES)
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      await advanceBy(40_000, 1_000)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(0)
      expect(pane.runtime.getMessageDeliverySnapshot(pane.stub.rows[0] as never).delivery).toBe(
        'queued_awaiting_pane'
      )
      pane.write.mockImplementation(() => true)
      scrollDialogAway(pane, ptyId)
      await advanceBy(8 * MIN)
      expect(pointerCalls(pane.write, ptyId)).toHaveLength(2)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a same-id respawn during the hold never receives the held Enter', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = 'pty-hold-respawn'
      const pane = setUpIdlePane(ptyId)
      paintAfterPointer(pane, ptyId, PERMISSION_PROMPT_LINES)
      pane.stub.insert('mail')
      pane.runtime.deliverPendingMessagesForHandle(pane.handle)
      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS + 50)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(0)
      // The replacement process starts on a clean screen: nothing is left to hold the Enter.
      pane.runtime.synchronizePtyOutputSequenceFromProvider(
        ptyId,
        { value: 0, generation: 'reset' },
        0
      )
      pane.pty.tailBuffer = []
      pane.pty.tailPartialLine = ''
      pane.pty.preview = ''
      await advanceBy(40_000, 1_000)
      expect(enterCallsOf(pane.write, ptyId)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
