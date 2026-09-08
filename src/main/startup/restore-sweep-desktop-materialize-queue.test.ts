// S10-21c B6 (design §2 S9): unit tests for the desktop-materialization queue's own drain logic
// — the functional core `orca-runtime.ts#materializeRestoredAgentPanes` delegates to (see that
// method's own doc comment). Exercised here directly against fakes rather than through a full
// `OrcaRuntimeService` instance, since the drain logic itself is plain, dependency-injected
// functions with no runtime-internal state beyond what `DesktopMaterializeQueueState` holds.
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopMaterializeQueueState,
  enqueueRestoredPaneForMaterialization,
  drainDesktopMaterializeQueue,
  type DesktopMaterializeNotifier,
  type RestoredPaneMaterializeSurface
} from './restore-sweep-desktop-materialize-queue'

function surface(
  overrides: Partial<RestoredPaneMaterializeSurface> = {}
): RestoredPaneMaterializeSurface {
  return {
    paneKey: 'tab1:00000000-0000-4000-8000-000000000030',
    worktreeId: 'wt-1',
    tabId: 'tab1',
    leafId: '00000000-0000-4000-8000-000000000030',
    ptyId: 'pty-30',
    expectedProcessIdentity: { terminalHandle: 'handle-30', incarnationId: 'pty-30:inc-30' },
    ...overrides
  }
}

describe('S10-21c B6, design §2 S9: drainDesktopMaterializeQueue', () => {
  it('issues exactly one reveal per queued pane and marks it; a second drain (same epoch) issues none', async () => {
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-30'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }

    await drainDesktopMaterializeQueue(state, notifier, 1)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(revealTerminalSession).toHaveBeenCalledWith('wt-1', {
      ptyId: 'pty-30',
      tabId: 'tab1',
      leafId: '00000000-0000-4000-8000-000000000030',
      presentation: 'background',
      expectedProcessIdentity: { terminalHandle: 'handle-30', incarnationId: 'pty-30:inc-30' }
    })

    await drainDesktopMaterializeQueue(state, notifier, 1)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })

  it('a reveal returning a mismatched identity leaves the pane queued and logs, never marks it done', async () => {
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      // Wrong ptyId — a mismatched identity.
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-WRONG'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await drainDesktopMaterializeQueue(state, notifier, 1)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(state.materializedEpochByPane.has(surface().paneKey)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('desktop materialize reveal did not complete'),
      expect.objectContaining({ paneKey: surface().paneKey })
    )

    // Retried on the next drain (same epoch) since it was never marked.
    await drainDesktopMaterializeQueue(state, notifier, 1)
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('a reveal that rejects (the real primitive throws on mismatch/timeout) is caught the same way', async () => {
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi
      .fn()
      .mockRejectedValue(new Error('terminal_reveal_identity_mismatch'))
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(drainDesktopMaterializeQueue(state, notifier, 1)).resolves.toBeUndefined()
    expect(state.materializedEpochByPane.has(surface().paneKey)).toBe(false)
    warn.mockRestore()
  })

  it('serve (no notifier installed): the drain is a no-op and returns cleanly', async () => {
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())

    await expect(drainDesktopMaterializeQueue(state, null, 1)).resolves.toBeUndefined()
    expect(state.materializedEpochByPane.size).toBe(0)
  })

  it('a notifier installed but without revealTerminalSession is also a clean no-op', async () => {
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())

    await expect(drainDesktopMaterializeQueue(state, {}, 1)).resolves.toBeUndefined()
    expect(state.materializedEpochByPane.size).toBe(0)
  })

  it('a pane materialized under epoch N is retried once epoch advances to N+1', async () => {
    const state = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(state, surface())
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'tab1',
      identity: {
        worktreeId: 'wt-1',
        tabId: 'tab1',
        leafId: '00000000-0000-4000-8000-000000000030',
        ptyId: 'pty-30'
      }
    })
    const notifier: DesktopMaterializeNotifier = { revealTerminalSession }

    await drainDesktopMaterializeQueue(state, notifier, 1)
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    await drainDesktopMaterializeQueue(state, notifier, 2)
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
  })
})
