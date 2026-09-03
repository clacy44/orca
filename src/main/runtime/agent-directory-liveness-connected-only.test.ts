// F-6b (Ruling 32(b); field-run-10i F-6): getAgentDirectoryLivenessSignals must resolve a
// terminal handle for a CONNECTED leaf only — the ghost-pane defect was
// getTerminalHandleForPaneKey's permissive fallback ladder (any ptyId, connected or not) feeding
// classifyAgentLiveness's paneResolves, so a dead pane could never reach `gone`. `onPtyExit` is
// the real event that flips a leaf to disconnected (orca-runtime.ts ~15155-15320) — the same
// path a genuinely dead pty takes, not a synthetic field write.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-agent-pane'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/probe-worktree',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeWithAgentPaneLeaf(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [{ id: PTY_ID, cwd: '/tmp/probe-worktree' }])
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: '', activeLeafId: LEAF_ID, layout: null }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

describe('getAgentDirectoryLivenessSignals: connected-only resolution (F-6b)', () => {
  it('resolves a terminal handle for a leaf whose pty is live', () => {
    const runtime = makeRuntimeWithAgentPaneLeaf()

    const signals = runtime.getAgentDirectoryLivenessSignals(PANE_KEY)

    expect(signals.terminalHandle).not.toBeNull()
  })

  // The parent-commit failure: getTerminalHandleForPaneKey's third branch
  // (`if (leaf?.ptyId) return this.issueHandle(leaf)`) hands back a handle for ANY leaf with a
  // ptyId, connected or not — so a dead pane's row never ages to `gone` (agent-liveness-
  // classification.ts's paneResolves is fed straight from this signal). Post-fix,
  // getAgentDirectoryLivenessSignals uses the connected-only resolver and correctly returns null
  // once the pty has genuinely exited (leaf.connected flips false via onPtyExit).
  it('does NOT resolve a terminal handle once the pty has exited (dead pane)', () => {
    const runtime = makeRuntimeWithAgentPaneLeaf()
    expect(runtime.getAgentDirectoryLivenessSignals(PANE_KEY).terminalHandle).not.toBeNull()

    runtime.onPtyExit(PTY_ID, 0)

    const signals = runtime.getAgentDirectoryLivenessSignals(PANE_KEY)
    expect(signals.terminalHandle).toBeNull()
  })

  // Full chain: the real signal this fix produces, fed through the existing (untouched)
  // classifier — proves a dead pane now ages to `gone` on schedule instead of sitting at
  // `idle` forever (the row could never reach `gone` pre-fix: paneResolves was always true).
  it('feeds classifyAgentLiveness into `gone` once aged, for a row whose pane is now disconnected', async () => {
    const runtime = makeRuntimeWithAgentPaneLeaf()
    runtime.onPtyExit(PTY_ID, 0)
    const signals = runtime.getAgentDirectoryLivenessSignals(PANE_KEY)
    expect(signals.terminalHandle).toBeNull()

    const { classifyAgentLiveness } = await import('./orchestration/agent-liveness-classification')
    const longAgoLastSeen = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    const now = new Date().toISOString()

    expect(
      classifyAgentLiveness({
        paneResolves: signals.terminalHandle !== null,
        lastAgentStatus: signals.lastAgentStatus,
        observedLive: signals.observedLive,
        lastSeenAt: longAgoLastSeen,
        now
      })
    ).toMatchObject({ state: 'gone' })
  })
})
