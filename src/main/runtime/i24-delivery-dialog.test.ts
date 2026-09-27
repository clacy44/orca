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
    state?: { connected?: boolean; connectionId?: string | null }
  ) => PtyRecordForTest
  issuePtyHandle: (pty: unknown) => string
  withheldDeliveryAttemptsByHandle: Map<string, { at: number; reason: string }>
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
