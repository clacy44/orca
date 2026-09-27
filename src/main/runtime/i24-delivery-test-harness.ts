// Shared harness for the I-24-1 delivery-gate test files (i24-delivery-anchored.test.ts,
// i24-delivery-fallback.test.ts): a real OrcaRuntimeService over an injected pty controller and an
// orchestration-db stub keyed by `to_handle` (s10-21f-r147-delivery-starvation-bound.test.ts's own
// fixtures). `anchor` adds the two persisted facts the anchored Claude identity (R270) reads — the
// workspace session's launch anchor for the pane, bound to the pty's `<ptyId>:<incarnationId>`, and
// the hook server's attestation of a hook carrying that anchor's hash — so a test can stand up the
// exact state a main restart leaves behind.
import { createHash } from 'node:crypto'
import { vi, type Mock } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

export const WORKTREE_ID = 'repo-1::/tmp/probe-worktree-i24-delivery'
export const TAB_ID = 'tab-i24-delivery'
export const LEAF_ID = '24242424-2424-4242-8242-242424242424'
export const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
export const MIN = 60_000
export const INCARNATION = 'inc-i24-delivery-1'

export type WithheldRecord = { firstAt: number; at: number; count: number; reason: string }

export type PtyRecordForTest = {
  ptyId: string
  incarnationId: string | null
  launchAgent: string | null
  connected: boolean
  paneKey: string | null
  launchPromptFenceSince: number | null
  lastAgentStatusObservedLive: boolean
  tailBuffer: string[]
  tailPartialLine: string
  preview: string
}

export type LeafRecordForTest = { writable: boolean; lastAgentStatusObservedLive: boolean }

export type RuntimeInternals = {
  ptysById: Map<string, PtyRecordForTest>
  leaves: Map<string, LeafRecordForTest>
  withheldDeliveryAttemptsByHandle: Map<string, WithheldRecord>
  pointedMessageIdsByHandle: Map<string, Set<string>>
  getLeafKey: (tabId: string, leafId: string) => string
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; paneKey?: string | null; incarnationId?: string }
  ) => PtyRecordForTest
  issuePtyHandle: (pty: unknown) => string
  advancePtyLifecycleGeneration: (ptyId: string) => void
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
  db: Record<string, unknown>
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
  receivedAt: number,
  paneKey: string = PANE_KEY
): AgentStatusIpcPayload {
  return {
    paneKey,
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

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The persisted facts a main restart leaves for an Orca-launched pane (see the file comment).
 *  `boundPty` defaults to the pty's own identity (null: a legacy anchor with no binding);
 *  `attestedHash` defaults to the anchor's hash (null: the hook server holds no evidence). */
export type AnchorFixture = {
  launchToken: string
  boundPty?: string | null
  attestedHash?: string | null
}

type AttestCandidate = { paneKey: string; launchTokenHash: string; connectionId: string | null }
type AttestResult = { paneKey: string; source: 'hydrated_commitment' } | null
export type AttestMock = Mock<(candidate: AttestCandidate) => AttestResult>

/** The store stub (workspace session with the pane's launch anchor) and the hook server's
 *  attestation stub for `anchor` on the pane PANE_KEY, pty `ptyId` at INCARNATION. */
export function buildAnchorDeps(
  ptyId: string,
  anchor: AnchorFixture | undefined
): { store: unknown; attest: AttestMock } {
  const anchorHash = anchor ? tokenHash(anchor.launchToken) : undefined
  const boundPty = anchor?.boundPty === undefined ? `${ptyId}:${INCARNATION}` : anchor.boundPty
  const session = {
    terminalLaunchTokenHashesByPaneKey: anchorHash ? { [PANE_KEY]: anchorHash } : {},
    terminalLaunchTokenAnchorPtyByPaneKey: anchor && boundPty ? { [PANE_KEY]: boundPty } : {}
  }
  const attestedHash = anchor?.attestedHash === undefined ? anchorHash : anchor.attestedHash
  const attest = vi.fn(
    (candidate: AttestCandidate): AttestResult =>
      candidate.paneKey === PANE_KEY &&
      candidate.connectionId === null &&
      attestedHash !== null &&
      candidate.launchTokenHash === attestedHash
        ? { paneKey: PANE_KEY, source: 'hydrated_commitment' }
        : null
  )
  // Only what these flows read: the workspace session (the anchor), an empty repo/worktree
  // catalogue for listTerminals, and default settings for pty output handling.
  const store = {
    getWorkspaceSession: () => session,
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({})
  }
  return { store: anchor ? store : null, attest }
}

/** A renderer-leaf pane on a reattached pty: launchAgent null, no OSC title seen, incarnation set. */
export async function setUpLeafPane(opts: {
  hooks: () => AgentStatusIpcPayload[]
  fg: string | null
  confirm: string | null
  ptyId: string
  launchAgent?: string | null
  anchor?: AnchorFixture
}): Promise<{
  runtime: OrcaRuntimeService
  write: ReturnType<typeof vi.fn>
  controller: TestPtyController
  handle: string
  stub: TestDbStub
  pty: PtyRecordForTest
  attest: AttestMock
}> {
  const { store, attest } = buildAnchorDeps(opts.ptyId, opts.anchor)
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentStatusSnapshot: opts.hooks,
    attestAgentHookCompatibilityAuthority: attest
  })
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
  pty.incarnationId = INCARNATION
  if (opts.launchAgent !== undefined) {
    pty.launchAgent = opts.launchAgent
  }
  const [terminal] = (await runtime.listTerminals()).terminals
  const handle = terminal.handle as string
  const stub = makeDbStub(() => handle)
  runtime.setOrchestrationDb(stub.db as never)
  return { runtime, write, controller, handle, stub, pty, attest }
}

export async function advance(ms: number, step = 30_000): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t))
  }
}

export function snapshot(
  runtime: OrcaRuntimeService,
  stub: { rows: StoredMessageRow[] },
  index = 0
): ReturnType<OrcaRuntimeService['getMessageDeliverySnapshot']> {
  return runtime.getMessageDeliverySnapshot(stub.rows[index] as never)
}
