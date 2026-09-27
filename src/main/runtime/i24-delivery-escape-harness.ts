// Shared harness for the I-24-1/G1 delivery-escape test files (i24-delivery-escape.test.ts and
// i24-delivery-escape-guards.test.ts, split at 800 counted lines — see config/vitest.config.ts's
// own max-lines budget). Mirrors the validated I-24-1 probe (i24-fix-probe.test.ts) and
// s10-21f-r147-delivery-starvation-bound.test.ts's fixtures.
import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

export const WORKTREE_ID = 'repo-1::/tmp/probe-worktree-i24-escape'
export const TAB_ID = 'tab-i24-escape'
export const LEAF_ID = '24242424-2424-4242-8242-242424242424'
export const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
export const MIN = 60_000

export type WithheldRecord = { firstAt: number; at: number; count: number; reason: string }

export type PtyRecordForTest = {
  ptyId: string
  launchAgent: string | null
  connected: boolean
  paneKey: string | null
  launchPromptFenceSince: number | null
}

export type LeafRecordForTest = { writable: boolean }

export type RuntimeInternals = {
  ptysById: Map<string, PtyRecordForTest>
  leaves: Map<string, LeafRecordForTest>
  withheldDeliveryAttemptsByHandle: Map<string, WithheldRecord>
  getLeafKey: (tabId: string, leafId: string) => string
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; paneKey?: string | null }
  ) => PtyRecordForTest
  issuePtyHandle: (pty: unknown) => string
}

export function priv(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

export type TestPtyController = {
  spawn: ReturnType<typeof vi.fn<() => Promise<{ id: string }>>>
  write: ReturnType<typeof vi.fn>
  kill: () => boolean
  getForegroundProcess: ReturnType<typeof vi.fn<() => Promise<string | null>>>
  confirmForegroundProcess: ReturnType<typeof vi.fn<() => Promise<string | null>>>
}

export function makeController(
  write: ReturnType<typeof vi.fn>,
  fg: string | null,
  confirm: string | null
): TestPtyController {
  return {
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: vi.fn(async () => fg),
    confirmForegroundProcess: vi.fn(async () => confirm)
  }
}

export type StoredMessageRow = {
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

export type TestDbStub = {
  rows: StoredMessageRow[]
  insert: (subject: string) => void
  db: {
    getUndeliveredUnreadMessages: (handle: string) => StoredMessageRow[]
    getUndeliveredUnreadMailboxHandles: () => string[]
    getActiveCoordinatorRun: () => null
    getCurrentRunForPane: () => undefined
    getActiveDispatchForTerminal: () => null
    getActiveDispatchForIdentity: () => undefined
    findActiveRemoteAttachmentForPane: () => undefined
    listDispatchInputObservationTargets: () => never[]
    getRecipientPaneKeyForBareHandle: () => null
    findOrphanedIdentityCandidate: () => undefined
    markAsDelivered: ReturnType<typeof vi.fn>
    close: () => void
  }
}

export function makeDbStub(toHandle: () => string): TestDbStub {
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
      findOrphanedIdentityCandidate: () => undefined,
      markAsDelivered: vi.fn(),
      close: () => {}
    }
  }
}

export function pointerWrites(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([p, d]) => p === ptyId && typeof d === 'string' && (d as string).includes('[from:')
  )
}

export function enterWrites(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([p, d]) => p === ptyId && d === '\r')
}

export function claudeHook(
  state: AgentStatusIpcPayload['state'],
  receivedAt: number
): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    state,
    prompt: '',
    agentType: 'claude',
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID
  }
}

/** A renderer-leaf pane on a reattached pty: launchAgent null (reattach), no OSC title seen. */
export async function setUpLeafPane(opts: {
  hooks: () => AgentStatusIpcPayload[]
  fg: string | null
  confirm: string | null
  ptyId: string
  launchAgent?: string | null
}): Promise<{
  runtime: OrcaRuntimeService
  write: ReturnType<typeof vi.fn>
  controller: TestPtyController
  handle: string
  stub: TestDbStub
  pty: PtyRecordForTest
}> {
  const runtime = new OrcaRuntimeService(null, undefined, { getAgentStatusSnapshot: opts.hooks })
  const write = vi.fn((_p: string, _d: string) => true)
  const controller = makeController(write, opts.fg, opts.confirm)
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
        ptyId: opts.ptyId,
        paneTitle: null,
        title: ''
      }
    ]
  } as never)
  const pty = priv(runtime).ptysById.get(opts.ptyId)!
  if (opts.launchAgent !== undefined) {
    pty.launchAgent = opts.launchAgent
  }
  const [terminal] = (await runtime.listTerminals()).terminals
  const handle = terminal.handle as string
  const stub = makeDbStub(() => handle)
  runtime.setOrchestrationDb(stub.db as never)
  return { runtime, write, controller, handle, stub, pty }
}

export async function advance(ms: number, step = 30_000): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t))
  }
}

export function snapshot(
  runtime: OrcaRuntimeService,
  stub: { rows: StoredMessageRow[] }
): ReturnType<OrcaRuntimeService['getMessageDeliverySnapshot']> {
  return runtime.getMessageDeliverySnapshot(stub.rows[0] as never)
}
