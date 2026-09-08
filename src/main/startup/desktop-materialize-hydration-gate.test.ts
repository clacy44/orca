// [S10-21c B6c, D-R155-b6b finding 1] The gate's own state transitions, plus the two physical
// startup orderings composed with the real `drainDesktopMaterializeQueue` (no Electron, no
// index.ts) — proving each ordering reveals the pane exactly once, through the trigger that is
// actually allowed to.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  createDesktopMaterializeHydrationGateState,
  markRendererHydratedForMaterialize,
  shouldDrainAtEndOfSweep
} from './desktop-materialize-hydration-gate'
import {
  createDesktopMaterializeQueueState,
  enqueueRestoredPaneForMaterialization,
  drainDesktopMaterializeQueue,
  type DesktopMaterializeNotifier,
  type RestoredPaneMaterializeSurface
} from './restore-sweep-desktop-materialize-queue'

const HOST_ID = 'local'
const alwaysLive = (): boolean => true
const noTitleFallback = (): string | null => null

function surface(): RestoredPaneMaterializeSurface {
  return {
    paneKey: 'tab1:00000000-0000-4000-8000-000000000040',
    agentId: 'agent-40',
    worktreeId: 'wt-1',
    tabId: 'tab1',
    leafId: '00000000-0000-4000-8000-000000000040',
    ptyId: 'pty-40',
    title: 'chair-40',
    launchAgent: 'claude',
    expectedProcessIdentity: { terminalHandle: 'handle-40', incarnationId: 'inc-40' }
  }
}

function buildNotifier(): {
  notifier: DesktopMaterializeNotifier
  reveal: ReturnType<typeof vi.fn>
} {
  const reveal = vi.fn().mockResolvedValue({
    tabId: 'tab1',
    identity: {
      worktreeId: 'wt-1',
      tabId: 'tab1',
      leafId: '00000000-0000-4000-8000-000000000040',
      ptyId: 'pty-40'
    }
  })
  return { notifier: { revealTerminalSession: reveal }, reveal }
}

describe('desktop materialize hydration gate state (S10-21c B6c, D-R155-b6b finding 1)', () => {
  it('starts un-hydrated, flips true on mark, and stays true on a repeat mark', () => {
    const state = createDesktopMaterializeHydrationGateState()
    expect(shouldDrainAtEndOfSweep(state)).toBe(false)
    markRendererHydratedForMaterialize(state)
    expect(shouldDrainAtEndOfSweep(state)).toBe(true)
    markRendererHydratedForMaterialize(state)
    expect(shouldDrainAtEndOfSweep(state)).toBe(true)
  })
})

describe('desktop materialize hydration gate, composed with the real drain (S10-21c B6c, D-R155-b6b finding 1)', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('sweep-before-startup: the end-of-sweep trigger is a no-op pre-hydration; the renderer-startup trigger reveals once', async () => {
    db = new OrchestrationDb(':memory:')
    const gate = createDesktopMaterializeHydrationGateState()
    const queue = createDesktopMaterializeQueueState()
    enqueueRestoredPaneForMaterialization(queue, surface())
    const { notifier, reveal } = buildNotifier()

    // 1. The sweep finishes first: the renderer has not hydrated yet, so its end-of-sweep
    // trigger must do nothing (the pane stays queued, not revealed pre-hydration).
    if (shouldDrainAtEndOfSweep(gate)) {
      await drainDesktopMaterializeQueue(queue, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    }
    expect(reveal).not.toHaveBeenCalled()
    expect(queue.queue.has(surface().paneKey)).toBe(true)

    // 2. The renderer-startup handler fires: marks hydration, then always drains (index.ts
    // :910 is unconditional) — this is the trigger that reveals.
    markRendererHydratedForMaterialize(gate)
    await drainDesktopMaterializeQueue(queue, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(queue.queue.has(surface().paneKey)).toBe(false)
  })

  it('startup-before-sweep: the renderer-startup trigger marks hydration before anything is queued; the end-of-sweep trigger then reveals once', async () => {
    db = new OrchestrationDb(':memory:')
    const gate = createDesktopMaterializeHydrationGateState()
    const queue = createDesktopMaterializeQueueState()
    const { notifier, reveal } = buildNotifier()

    // 1. The renderer-startup handler fires first: marks hydration, drains an empty queue
    // (the sweep has not queued this pane yet).
    markRendererHydratedForMaterialize(gate)
    await drainDesktopMaterializeQueue(queue, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    expect(reveal).not.toHaveBeenCalled()

    // 2. The sweep finishes afterwards and queues its restored pane; the flag is already set,
    // so the end-of-sweep trigger drains and reveals it.
    enqueueRestoredPaneForMaterialization(queue, surface())
    if (shouldDrainAtEndOfSweep(gate)) {
      await drainDesktopMaterializeQueue(queue, notifier, alwaysLive, noTitleFallback, db, HOST_ID)
    }
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(queue.queue.has(surface().paneKey)).toBe(false)
  })
})
