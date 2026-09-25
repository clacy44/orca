// G1 repair (blocking 1): the --inject gate's resolve edge previously called
// isPeerPaneForegroundAgentLive, which only recognizes a `pty:`-tab-id handle
// (getLivePtyForHandle) and returns false for every renderer leaf handle — the
// handle kind dispatch overwhelmingly uses. Every existing orchestration.test.ts
// coverage stubs that helper, so no test saw the refusal. These tests run the
// REAL runtime's gate (confirmDispatchInjectForegroundIsAgent) against a REAL
// renderer leaf handle, with no spy on the resolve-edge helper itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const TEST_REPO_ID = 'repo-1'
const TEST_WORKTREE_PATH = '/tmp/worktree-inject'
const TEST_WORKTREE_ID = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}`
const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('orchestration.dispatch --inject gate against a real renderer leaf handle (G1 repair)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let confirmForegroundProcess: ((ptyId: string) => Promise<string | null>) | undefined
  let workerHandle: string

  function dispatchMethod() {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === 'orchestration.dispatch')
    if (!method) {
      throw new Error('orchestration.dispatch is not registered')
    }
    return method
  }

  beforeEach(async () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    // Why: pane-key/incarnation identity is not what this gate resolves — stub only that,
    // never the confirm helper under test.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_coord') {
        return COORDINATOR_PANE_KEY
      }
      if (handle === workerHandle) {
        return WORKER_PANE_KEY
      }
      return null
    })
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === workerHandle ? 'runtime_test:worker:1' : null
    )

    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      confirmForegroundProcess: (ptyId: string) => confirmForegroundProcess!(ptyId)
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'worker',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    workerHandle = terminal.handle

    const run = db.createRun({
      objective: 'inject gate',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    })
    ;(runtime as unknown as { __runId: string }).__runId = run.id
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  async function dispatchTask(to: string = workerHandle): Promise<unknown> {
    const run = db.getRun((runtime as unknown as { __runId: string }).__runId)!
    const task = db.createTask({ spec: 'do the work', runId: run.id })
    const method = dispatchMethod()
    const parsed = method.params!.parse({
      task: task.id,
      to,
      from: 'term_coord',
      run: run.id,
      inject: true
    })
    return method.handler(parsed, { runtime } as never)
  }

  it('dispatches when a fresh confirm proves the foreground is a live agent', async () => {
    confirmForegroundProcess = vi.fn(async () => 'claude')

    const result = (await dispatchTask()) as { injected: boolean }

    expect(result.injected).toBe(true)
    expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-worker')
  })

  it('refuses when a fresh scan proves the pane fell back to a bare shell', async () => {
    confirmForegroundProcess = vi.fn(async () => 'zsh')

    await expect(dispatchTask()).rejects.toThrow(/no longer a recognized agent/)
    expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-worker')
  })

  it("dispatches on isTerminalRunningAgent's verdict when confirm proves nothing (null)", async () => {
    confirmForegroundProcess = vi.fn(async () => null)

    const result = (await dispatchTask()) as { injected: boolean }

    expect(result.injected).toBe(true)
    expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-worker')
  })

  it("resolves unknown (not a refusal) and dispatches on isTerminalRunningAgent's verdict when no live leaf/pty backs the handle", async () => {
    // Why: an unregistered handle has no runtime.handles record at all, so
    // getLiveLeafForHandle throws terminal_handle_stale inside the gate. Stable-pane
    // authority is stubbed directly (as the legacy-coordinator-race test does) so that
    // failure is isolated to the gate under test, not the unrelated authority resolve.
    const staleHandle = 'term_stale_no_graph'
    confirmForegroundProcess = vi.fn(async () => 'claude')
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockImplementation(
      async (handle) => handle === staleHandle
    )
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_coord') {
        return COORDINATOR_PANE_KEY
      }
      if (handle === staleHandle) {
        return WORKER_PANE_KEY
      }
      return null
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === staleHandle
        ? ({
            terminalHandle: staleHandle,
            paneKey: WORKER_PANE_KEY,
            processIncarnation: 'runtime_test:stale:1',
            launchTokenHash: null
          } as never)
        : null
    )
    // Why: staleHandle is deliberately unregistered (no runtime.handles record), so the
    // real sendTerminalAgentPrompt would also throw terminal_handle_stale; that resolve
    // edge is not under test here, only confirmDispatchInjectForegroundIsAgent is.
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: staleHandle,
      accepted: true,
      bytesWritten: 1
    })

    const result = (await dispatchTask(staleHandle)) as { injected: boolean }

    expect(result.injected).toBe(true)
    // Why: no live pty/leaf resolves for staleHandle, so the gate must catch and return
    // 'unknown' rather than throwing terminal_handle_stale; confirm is never reached.
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })
})
