import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from '../crash-reporting/crash-breadcrumb-store'

const TAB = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

let repoDir = ''
let worktreeId = ''

function makeStore() {
  const session = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      { id: 'repo-1', path: repoDir, displayName: 'probe', badgeColor: '#000000', addedAt: 0 }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

type Reveal = (
  worktree: string,
  opts: { ptyId: string; tabId?: string; leafId?: string; splitFromLeafId?: string }
) => Promise<unknown>

function makeRuntime(options: {
  listed: () => Promise<{ id: string; cwd: string }[]>
  reveal?: Reveal
  canRecover?: boolean
  stopAndWait?: (ptyId: string) => Promise<boolean>
}) {
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    canRecoverPersistentLocalPtys: () => options.canRecover ?? true
  } as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(options.listed),
    ...(options.stopAndWait ? { stopAndWait: options.stopAndWait } : {})
  } as never)
  const reveal = vi.fn<Reveal>(
    options.reveal ??
      (async (worktree, opts) => ({
        tabId: opts.tabId,
        identity: {
          worktreeId: worktree,
          tabId: opts.tabId,
          leafId: opts.leafId,
          ptyId: opts.ptyId
        }
      }))
  )
  runtime.setNotifier({ revealTerminalSession: reveal } as never)
  return { runtime, reveal }
}

function reconcileBreadcrumbs() {
  return getCrashBreadcrumbSnapshot().filter(
    (crumb) => crumb.name === 'live_terminal_surface_reconcile'
  )
}

function registerLivePane(runtime: OrcaRuntimeService, ptyId: string, leafId = LEAF_A): void {
  runtime.registerPty(ptyId, worktreeId, null, { tabId: TAB, leafId })
}

describe('OrcaRuntimeService.reconcileLiveTerminalSurfacesForRenderer', () => {
  beforeEach(() => {
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-live-surface-')))
    execFileSync('git', ['init', '-q', repoDir])
    worktreeId = `repo-1::${repoDir}`
  })
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('reveals a live terminal even when its cached connected flag reads false', async () => {
    const { runtime, reveal } = makeRuntime({
      listed: async () => [{ id: 'pty-1', cwd: repoDir }]
    })
    registerLivePane(runtime, 'pty-1')
    ;(runtime as never as { ptysById: Map<string, { connected: boolean }> }).ptysById.get(
      'pty-1'
    )!.connected = false

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal.mock.calls[0]![0]).toBe(worktreeId)
    expect(reveal.mock.calls[0]![1]).toMatchObject({
      ptyId: 'pty-1',
      tabId: TAB,
      leafId: LEAF_A,
      activate: false,
      focus: false,
      presentation: 'background',
      materializeOnly: true
    })
  })

  it('reveals nothing when the controller inventory is unavailable', async () => {
    const { runtime, reveal } = makeRuntime({
      listed: async () => {
        throw new Error('controller down')
      }
    })
    registerLivePane(runtime, 'pty-1')
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('reveals nothing for a pty absent from the inventory', async () => {
    const { runtime, reveal } = makeRuntime({ listed: async () => [] })
    registerLivePane(runtime, 'pty-1')
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('is a no-op without a notifier and while local ptys cannot be recovered', async () => {
    const withoutNotifier = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
    withoutNotifier.runtime.setNotifier(null)
    registerLivePane(withoutNotifier.runtime, 'pty-1')
    await withoutNotifier.runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(withoutNotifier.reveal).not.toHaveBeenCalled()

    const cannotRecover = makeRuntime({
      listed: async () => [{ id: 'pty-1', cwd: repoDir }],
      canRecover: false
    })
    registerLivePane(cannotRecover.runtime, 'pty-1')
    await cannotRecover.runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(cannotRecover.reveal).not.toHaveBeenCalled()
  })

  it('does not repeat a handled terminal in one epoch', async () => {
    const { runtime, reveal } = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
    registerLivePane(runtime, 'pty-1')
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('splits a second leaf of one tab from the first', async () => {
    const { runtime, reveal } = makeRuntime({
      listed: async () => [
        { id: 'pty-a', cwd: repoDir },
        { id: 'pty-b', cwd: repoDir }
      ]
    })
    registerLivePane(runtime, 'pty-a', LEAF_A)
    registerLivePane(runtime, 'pty-b', LEAF_B)
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(reveal.mock.calls[1]![1].splitFromLeafId).toBe(LEAF_A)
  })

  it('does not resurrect a terminal whose close was requested', async () => {
    const { runtime, reveal } = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
    registerLivePane(runtime, 'pty-1')
    runtime.markPtyShutdownRequested('pty-1')
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal).not.toHaveBeenCalled()
  })

  it('does not reveal a terminal of a worktree that is no longer known', async () => {
    // cwd outside every known worktree, so the inventory cannot re-attribute the pty.
    const { runtime, reveal } = makeRuntime({
      listed: async () => [{ id: 'pty-1', cwd: '/nowhere' }]
    })
    runtime.registerPty('pty-1', `repo-1::${repoDir}-removed`, null, { tabId: TAB, leafId: LEAF_A })
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal).not.toHaveBeenCalled()
  })
  it('retries a failed first inventory once and reveals in the same call', async () => {
    let calls = 0
    const { runtime, reveal } = makeRuntime({
      listed: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('controller blip')
        }
        return [{ id: 'pty-1', cwd: repoDir }]
      }
    })
    registerLivePane(runtime, 'pty-1')
    clearCrashBreadcrumbsForTest()

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reconcileBreadcrumbs().map((crumb) => crumb.data?.outcome)).toEqual(['done'])
  })

  it('records inventory_unavailable only when both inventory attempts fail', async () => {
    const { runtime, reveal } = makeRuntime({
      listed: async () => {
        throw new Error('controller down')
      }
    })
    registerLivePane(runtime, 'pty-1')
    clearCrashBreadcrumbsForTest()

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).not.toHaveBeenCalled()
    expect(reconcileBreadcrumbs().map((crumb) => crumb.data?.outcome)).toEqual([
      'inventory_unavailable'
    ])
  })

  it('retries a failed liveness round once instead of deferring the terminal', async () => {
    let calls = 0
    const { runtime, reveal } = makeRuntime({
      listed: async () => {
        calls += 1
        // 1 = planning inventory, 2 = the first liveness round (fails), 3 = its retry.
        if (calls === 2) {
          throw new Error('controller blip')
        }
        return [{ id: 'pty-1', cwd: repoDir }]
      }
    })
    registerLivePane(runtime, 'pty-1')

    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(calls).toBe(3)
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('stops revealing when the renderer epoch moves mid-drain and reveals the rest on the next call', async () => {
    let runtimeRef: OrcaRuntimeService | null = null
    let bumped = false
    const { runtime, reveal } = makeRuntime({
      listed: async () => [
        { id: 'pty-a', cwd: repoDir },
        { id: 'pty-b', cwd: repoDir }
      ],
      reveal: async (worktree, opts) => {
        // A renderer reload lands (once) while the first leaf is being revealed.
        if (!bumped) {
          bumped = true
          ;(runtimeRef as never as { rendererGraphEpoch: number }).rendererGraphEpoch += 1
        }
        return {
          tabId: opts.tabId,
          identity: {
            worktreeId: worktree,
            tabId: opts.tabId,
            leafId: opts.leafId,
            ptyId: opts.ptyId
          }
        }
      }
    })
    runtimeRef = runtime
    registerLivePane(runtime, 'pty-a', LEAF_A)
    registerLivePane(runtime, 'pty-b', LEAF_B)

    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal.mock.calls.map((call) => call[1].ptyId)).toEqual(['pty-a'])

    // The new epoch invalidates the old receipts, so the next call re-plans both leaves.
    reveal.mockClear()
    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    expect(reveal.mock.calls.map((call) => call[1].ptyId)).toContain('pty-b')
  })

  it('keeps a user-closed terminal excluded when its kill fails (the mark is only set, never cleared)', async () => {
    const { runtime, reveal } = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
    registerLivePane(runtime, 'pty-1')
    // pty:kill marks, the provider shutdown then throws, and nothing clears the mark.
    runtime.markPtyShutdownRequested('pty-1')

    await runtime.reconcileLiveTerminalSurfacesForRenderer()
    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).not.toHaveBeenCalled()
  })

  it('keeps a failed-kill terminal excluded when the controller kill path re-marks it after onPtyExit', async () => {
    const { runtime, reveal } = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
    registerLivePane(runtime, 'pty-1')
    clearCrashBreadcrumbsForTest()

    // Sequence of the controller kill's failure branch: shutdown requested, onPtyExit, re-mark.
    runtime.markPtyShutdownRequested('pty-1')
    runtime.onPtyExit('pty-1', -1)
    runtime.markPtyShutdownRequested('pty-1')
    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).not.toHaveBeenCalled()
    expect(reconcileBreadcrumbs().map((crumb) => crumb.data)).toEqual([
      expect.objectContaining({ outcome: 'nothing_to_reveal', skip_shutdown_requested: 1 })
    ])
  })

  it('lets a terminal back in once a failed stopAndWait clears its shutdown mark', async () => {
    let runtimeRef: OrcaRuntimeService | null = null
    const { runtime, reveal } = makeRuntime({
      listed: async () => [{ id: 'pty-1', cwd: repoDir }],
      // Same sequence as the main-process controller: mark on the stop request, clear on its failure.
      stopAndWait: async (ptyId) => {
        runtimeRef!.markPtyShutdownRequested(ptyId)
        runtimeRef!.clearPtyShutdownRequested(ptyId)
        return false
      }
    })
    runtimeRef = runtime
    registerLivePane(runtime, 'pty-1')
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await expect(
      runtime.stopExactTerminalsForWorktree(`path:${repoDir}`, ['pty-1'])
    ).rejects.toThrow('terminal_exact_stop_failed')
    await runtime.reconcileLiveTerminalSurfacesForRenderer()

    expect(reveal).toHaveBeenCalledTimes(1)
  })

  describe('getLiveAgentSessionMarks', () => {
    const paneKey = `${TAB}:${LEAF_A}`
    const statusRow = {
      paneKey,
      agentType: 'claude',
      providerSession: { id: 'session-live' },
      receivedAt: Date.now()
    }

    it('names the conversation of a terminal that is live in the inventory', async () => {
      const { runtime } = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
      registerLivePane(runtime, 'pty-1')
      runtime.setAgentStatusRowsSource(() => [statusRow])

      await expect(runtime.getLiveAgentSessionMarks()).resolves.toEqual([
        { ptyId: 'pty-1', paneKey, worktreeId, agent: 'claude', providerSessionId: 'session-live' }
      ])
    })

    it('returns [] (a known-empty live set) for a pane whose terminal is not in the inventory', async () => {
      const absent = makeRuntime({ listed: async () => [] })
      registerLivePane(absent.runtime, 'pty-1')
      absent.runtime.setAgentStatusRowsSource(() => [statusRow])
      await expect(absent.runtime.getLiveAgentSessionMarks()).resolves.toEqual([])
    })

    it('returns null (unknown) when the inventory stays unavailable after the retry', async () => {
      const listed = vi.fn(async () => {
        throw new Error('controller down')
      })
      const down = makeRuntime({ listed })
      registerLivePane(down.runtime, 'pty-1')
      down.runtime.setAgentStatusRowsSource(() => [statusRow])
      await expect(down.runtime.getLiveAgentSessionMarks()).resolves.toBeNull()
      expect(listed).toHaveBeenCalledTimes(2)
    })

    it('retries a failed first inventory once and still names the conversation', async () => {
      let calls = 0
      const { runtime } = makeRuntime({
        listed: async () => {
          calls += 1
          if (calls === 1) {
            throw new Error('controller blip')
          }
          return [{ id: 'pty-1', cwd: repoDir }]
        }
      })
      registerLivePane(runtime, 'pty-1')
      runtime.setAgentStatusRowsSource(() => [statusRow])
      await expect(runtime.getLiveAgentSessionMarks()).resolves.toHaveLength(1)
    })

    it('returns null (unknown) while local ptys cannot be recovered', async () => {
      const { runtime } = makeRuntime({
        listed: async () => [{ id: 'pty-1', cwd: repoDir }],
        canRecover: false
      })
      registerLivePane(runtime, 'pty-1')
      runtime.setAgentStatusRowsSource(() => [statusRow])
      await expect(runtime.getLiveAgentSessionMarks()).resolves.toBeNull()
    })

    it('returns null (unknown) when the worktree map does not resolve in time', async () => {
      const { runtime } = makeRuntime({ listed: async () => [{ id: 'pty-1', cwd: repoDir }] })
      registerLivePane(runtime, 'pty-1')
      runtime.setAgentStatusRowsSource(() => [statusRow])
      ;(
        runtime as never as { getResolvedWorktreeMap: () => Promise<never> }
      ).getResolvedWorktreeMap = () => new Promise(() => {})
      vi.useFakeTimers()
      try {
        const pending = runtime.getLiveAgentSessionMarks()
        await vi.advanceTimersByTimeAsync(3_100)
        await expect(pending).resolves.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
