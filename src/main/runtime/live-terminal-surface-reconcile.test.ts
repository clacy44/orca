import { describe, expect, it, vi } from 'vitest'
import {
  LiveSurfaceReceipts,
  planLiveTerminalSurfaceReveals,
  type LiveSurfaceExclusionSources,
  type LiveSurfacePtyRecord
} from './live-terminal-surface-plan'
import {
  drainLiveTerminalSurfaceReveals,
  type LiveSurfaceRevealOptions
} from './live-terminal-surface-reconcile'
import {
  MATERIALIZE_ONLY_ERROR_AMBIGUOUS,
  MATERIALIZE_ONLY_ERROR_TAB_CONFLICT,
  MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE
} from '../../shared/terminal-reveal-identity'

const WORKTREE = 'repo-1::/tmp/wt'
const TAB = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function pty(overrides: Partial<LiveSurfacePtyRecord> = {}): LiveSurfacePtyRecord {
  const leaf = LEAF_A
  return {
    ptyId: 'pty-1',
    worktreeId: WORKTREE,
    connectionId: null,
    remoteScoped: false,
    tabId: TAB,
    paneKey: `${TAB}:${leaf}`,
    incarnationId: null,
    seq: 1,
    title: 'claude',
    launchAgent: 'claude',
    launchConfig: null,
    ...overrides
  }
}

function noExclusions(): LiveSurfaceExclusionSources {
  return {
    legacyWorkerPtyIds: new Set(),
    legacyWorkerPaneKeys: new Set(),
    materializeQueuePtyIds: new Set(),
    materializeQueuePaneKeys: new Set(),
    surfacelessBackgroundPtyIds: new Set(),
    shutdownRequestedPtyIds: new Set()
  }
}

function plan(
  ptys: LiveSurfacePtyRecord[],
  options: {
    live?: string[]
    identities?: Record<string, { handle: string; incarnationId: string }>
    exclusions?: Partial<LiveSurfaceExclusionSources>
    receipts?: LiveSurfaceReceipts
    epoch?: number
    knownWorktrees?: string[]
  } = {}
) {
  return planLiveTerminalSurfaceReveals({
    ptys,
    inventory: {
      livePtyIds: new Set(options.live ?? ptys.map((p) => p.ptyId)),
      terminalIdentityByPtyId: new Map(Object.entries(options.identities ?? {}))
    },
    exclusions: { ...noExclusions(), ...options.exclusions },
    isKnownWorktree: (id) => (options.knownWorktrees ?? [WORKTREE]).includes(id),
    receipts: options.receipts ?? new LiveSurfaceReceipts(),
    epoch: options.epoch ?? 1
  })
}

function skippedReasons(result: ReturnType<typeof plan>): Record<string, string> {
  return Object.fromEntries(result.skipped.map((entry) => [entry.ptyId, entry.reason]))
}

describe('planLiveTerminalSurfaceReveals', () => {
  it('plans a live local terminal with a valid surface', () => {
    const result = plan([pty()])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.items[0]).toMatchObject({ ptyId: 'pty-1', tabId: TAB, leafId: LEAF_A })
  })

  it('does not plan a terminal missing from the inventory', () => {
    const result = plan([pty()], { live: [] })
    expect(result.groups).toEqual([])
    expect(skippedReasons(result)).toEqual({ 'pty-1': 'not_in_inventory' })
  })

  it('skips SSH and remote-scoped terminals', () => {
    const result = plan([
      pty({ ptyId: 'ssh-1', connectionId: 'conn-1' }),
      pty({ ptyId: 'remote:1', remoteScoped: true, seq: 2 })
    ])
    expect(result.groups).toEqual([])
    expect(skippedReasons(result)).toEqual({ 'ssh-1': 'remote', 'remote:1': 'remote' })
  })

  it('skips a bad leaf, a tab-id mismatch and a missing worktree', () => {
    const result = plan([
      pty({ ptyId: 'bad-leaf', paneKey: `${TAB}:not-a-uuid` }),
      pty({ ptyId: 'tab-mismatch', paneKey: `other-tab:${LEAF_A}`, seq: 2 }),
      pty({ ptyId: 'no-tab', tabId: null, seq: 3 }),
      pty({ ptyId: 'no-worktree', worktreeId: '', seq: 4 })
    ])
    expect(result.groups).toEqual([])
    expect(skippedReasons(result)).toEqual({
      'bad-leaf': 'bad_surface',
      'tab-mismatch': 'bad_surface',
      'no-tab': 'bad_surface',
      'no-worktree': 'no_worktree'
    })
  })

  it('orders two leaves of one tab into one group, oldest first', () => {
    const result = plan([
      pty({ ptyId: 'pty-b', paneKey: `${TAB}:${LEAF_B}`, seq: 2 }),
      pty({ ptyId: 'pty-a', seq: 1 })
    ])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.items.map((item) => item.leafId)).toEqual([LEAF_A, LEAF_B])
    expect(result.groups[0]!.anchorLeafId).toBeNull()
  })

  it('refuses two live ptys that claim the same leaf', () => {
    const result = plan([pty(), pty({ ptyId: 'pty-2', seq: 2 })])
    expect(result.groups).toEqual([])
    expect(skippedReasons(result)).toEqual({
      'pty-1': 'duplicate_pane_key',
      'pty-2': 'duplicate_pane_key'
    })
  })

  it('requires the record incarnation to match the inventory and forwards the identity', () => {
    const identities = { 'pty-1': { handle: 'term_a', incarnationId: 'inc-1' } }
    expect(plan([pty({ incarnationId: 'inc-OTHER' })], { identities }).groups).toEqual([])
    expect(plan([pty({ incarnationId: 'inc-1' })], {}).groups).toEqual([])
    const ok = plan([pty({ incarnationId: 'inc-1' })], { identities })
    expect(ok.groups[0]!.items[0]!.expectedProcessIdentity).toEqual({
      terminalHandle: 'term_a',
      incarnationId: 'inc-1'
    })
  })

  describe('terminals that are tab-less on purpose or owned by another recovery path', () => {
    it('excludes legacy-worker candidates (by pty and by pane key)', () => {
      const byPty = plan([pty()], { exclusions: { legacyWorkerPtyIds: new Set(['pty-1']) } })
      const byPane = plan([pty()], {
        exclusions: { legacyWorkerPaneKeys: new Set([`${TAB}:${LEAF_A}`]) }
      })
      expect(skippedReasons(byPty)).toEqual({ 'pty-1': 'legacy_worker' })
      expect(skippedReasons(byPane)).toEqual({ 'pty-1': 'legacy_worker' })
    })

    it('excludes desktop materialize-queue candidates (by pty and by pane key)', () => {
      const byPty = plan([pty()], { exclusions: { materializeQueuePtyIds: new Set(['pty-1']) } })
      const byPane = plan([pty()], {
        exclusions: { materializeQueuePaneKeys: new Set([`${TAB}:${LEAF_A}`]) }
      })
      expect(skippedReasons(byPty)).toEqual({ 'pty-1': 'materialize_queue' })
      expect(skippedReasons(byPane)).toEqual({ 'pty-1': 'materialize_queue' })
    })

    it('excludes a terminal whose close was requested (kill still pending)', () => {
      const result = plan([pty()], { exclusions: { shutdownRequestedPtyIds: new Set(['pty-1']) } })
      expect(skippedReasons(result)).toEqual({ 'pty-1': 'shutdown_requested' })
    })

    it('excludes background-created terminals (automation, workers, lane wakes)', () => {
      const result = plan([pty()], {
        exclusions: { surfacelessBackgroundPtyIds: new Set(['pty-1']) }
      })
      expect(skippedReasons(result)).toEqual({ 'pty-1': 'surfaceless_background' })
    })

    it('excludes terminals of a worktree that is gone and of the floating workspace', () => {
      const removed = plan([pty()], { knownWorktrees: [] })
      const floating = plan([pty({ worktreeId: 'global-floating-terminal' })], {
        knownWorktrees: ['global-floating-terminal']
      })
      expect(skippedReasons(removed)).toEqual({ 'pty-1': 'unknown_worktree' })
      expect(skippedReasons(floating)).toEqual({ 'pty-1': 'floating_workspace' })
    })

    it('positive control: the same terminal without any exclusion is planned', () => {
      expect(plan([pty()]).groups).toHaveLength(1)
    })
  })

  it('does not plan a terminal with a receipt for the current epoch, but does after an epoch bump', () => {
    const receipts = new LiveSurfaceReceipts()
    receipts.record('pty-1', null, 1, 'owned')
    expect(plan([pty()], { receipts, epoch: 1 }).groups).toEqual([])
    expect(plan([pty()], { receipts, epoch: 2 }).groups).toHaveLength(1)
  })

  it('anchors a new leaf on a sibling leaf already handled this epoch', () => {
    const receipts = new LiveSurfaceReceipts()
    receipts.record('pty-a', null, 1, 'revealed')
    const result = plan(
      [pty({ ptyId: 'pty-a' }), pty({ ptyId: 'pty-b', paneKey: `${TAB}:${LEAF_B}`, seq: 2 })],
      { receipts }
    )
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]!.anchorLeafId).toBe(LEAF_A)
    expect(result.groups[0]!.items.map((item) => item.ptyId)).toEqual(['pty-b'])
  })
})

function makeDrain(
  ptys: LiveSurfacePtyRecord[],
  overrides: Partial<Parameters<typeof drainLiveTerminalSurfaceReveals>[0]> = {},
  receipts = new LiveSurfaceReceipts(),
  epoch = 1
) {
  const planned = plan(ptys, { receipts, epoch })
  const reveal = vi.fn(async (worktreeId: string, opts: LiveSurfaceRevealOptions) => ({
    identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
  }))
  const recordBreadcrumb = vi.fn()
  const deps = {
    groups: planned.groups,
    reveal,
    checkLiveness: vi.fn(async () => ({ live: true as boolean | null })),
    receipts,
    planEpoch: epoch,
    getEpoch: () => epoch,
    recordBreadcrumb,
    ...overrides
  }
  return {
    deps,
    reveal,
    recordBreadcrumb,
    receipts,
    run: () => drainLiveTerminalSurfaceReveals(deps)
  }
}

describe('drainLiveTerminalSurfaceReveals', () => {
  it('requests the reveal with the exact options and never forwards a launch token', async () => {
    const launchConfig = { agentArgs: '--x', agentEnv: {} } as never
    const identities = { 'pty-1': { handle: 'term_a', incarnationId: 'inc-1' } }
    const planned = plan([pty({ incarnationId: 'inc-1', launchConfig, title: 'Claude title' })], {
      identities
    })
    const revealMock = vi.fn(async (worktreeId: string, opts: LiveSurfaceRevealOptions) => ({
      identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
    }))
    await drainLiveTerminalSurfaceReveals({
      groups: planned.groups,
      reveal: revealMock,
      checkLiveness: async () => ({ live: true, incarnationId: 'inc-1' }),
      receipts: new LiveSurfaceReceipts(),
      planEpoch: 1,
      getEpoch: () => 1,
      recordBreadcrumb: vi.fn()
    })
    expect(revealMock).toHaveBeenCalledTimes(1)
    expect(revealMock).toHaveBeenCalledWith(WORKTREE, {
      ptyId: 'pty-1',
      title: 'Claude title',
      launchAgent: 'claude',
      launchConfig,
      activate: false,
      focus: false,
      presentation: 'background',
      materializeOnly: true,
      tabId: TAB,
      leafId: LEAF_A,
      expectedProcessIdentity: { terminalHandle: 'term_a', incarnationId: 'inc-1' }
    })
    expect(Object.keys(revealMock.mock.calls[0]![1])).not.toContain('launchToken')
  })

  it('a terminal not marked connected but present in the inventory is still revealed', async () => {
    // The planner only consults the inventory; the cached `connected` flag is not an input at all.
    const { reveal, run } = makeDrain([pty()])
    await run()
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('passes splitFromLeafId for the second leaf of one tab, after the first lands', async () => {
    const order: string[] = []
    const { reveal, run } = makeDrain([
      pty({ ptyId: 'pty-a' }),
      pty({ ptyId: 'pty-b', paneKey: `${TAB}:${LEAF_B}`, seq: 2 })
    ])
    reveal.mockImplementation(async (worktreeId, opts) => {
      order.push(opts.ptyId)
      return { identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId } }
    })
    await run()
    expect(order).toEqual(['pty-a', 'pty-b'])
    expect(reveal.mock.calls[0]![1].splitFromLeafId).toBeUndefined()
    expect(reveal.mock.calls[1]![1].splitFromLeafId).toBe(LEAF_A)
  })

  it('an owned reply records a receipt: no repeat in the same epoch, a repeat after an epoch bump', async () => {
    const receipts = new LiveSurfaceReceipts()
    const first = makeDrain([pty()], {}, receipts, 1)
    first.reveal.mockResolvedValue({ skipped: 'owned' } as never)
    const summary = await first.run()
    expect(summary.owned).toBe(1)

    const sameEpoch = makeDrain([pty()], {}, receipts, 1)
    await sameEpoch.run()
    expect(sameEpoch.reveal).not.toHaveBeenCalled()

    const nextEpoch = makeDrain([pty()], {}, receipts, 2)
    await nextEpoch.run()
    expect(nextEpoch.reveal).toHaveBeenCalledTimes(1)
  })

  it('does not reveal when liveness is unknown, and defers it', async () => {
    const { reveal, run, recordBreadcrumb } = makeDrain([pty()], {
      checkLiveness: vi.fn(async () => ({ live: null }))
    })
    const summary = await run()
    expect(reveal).not.toHaveBeenCalled()
    expect(summary.deferred).toBe(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'live_terminal_surface_deferred',
      expect.objectContaining({ ptyId: 'pty-1' })
    )
  })

  it('gives a terminal that exited in the gap no tab', async () => {
    const { reveal, run, receipts } = makeDrain([pty()], {
      checkLiveness: vi.fn(async () => ({ live: false }))
    })
    await run()
    expect(reveal).not.toHaveBeenCalled()
    expect(receipts.get('pty-1', null, 1)).toBeNull()
  })

  it('refuses ambiguous / conflicting ownership for the rest of the epoch', async () => {
    for (const error of [
      MATERIALIZE_ONLY_ERROR_AMBIGUOUS,
      MATERIALIZE_ONLY_ERROR_TAB_CONFLICT,
      'terminal_reveal_identity_mismatch'
    ]) {
      const receipts = new LiveSurfaceReceipts()
      const first = makeDrain([pty()], {}, receipts)
      first.reveal.mockRejectedValue(new Error(error))
      const summary = await first.run()
      expect(summary.refused).toBe(1)
      expect(first.recordBreadcrumb).toHaveBeenCalledWith(
        'live_terminal_surface_refused',
        expect.objectContaining({ ptyId: 'pty-1' })
      )
      const again = makeDrain([pty()], {}, receipts)
      await again.run()
      expect(again.reveal).not.toHaveBeenCalled()
    }
  })

  it('retries an unknown-worktree or transport failure on the next call', async () => {
    for (const error of [MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE, 'Terminal reveal timed out']) {
      const receipts = new LiveSurfaceReceipts()
      const first = makeDrain([pty()], {}, receipts)
      first.reveal.mockRejectedValue(new Error(error))
      const summary = await first.run()
      expect(summary.deferred).toBe(1)
      const again = makeDrain([pty()], {}, receipts)
      await again.run()
      expect(again.reveal).toHaveBeenCalledTimes(1)
    }
  })

  it('does not reveal the second leaf when the first leaf of its tab failed', async () => {
    const { reveal, run } = makeDrain([
      pty({ ptyId: 'pty-a' }),
      pty({ ptyId: 'pty-b', paneKey: `${TAB}:${LEAF_B}`, seq: 2 })
    ])
    reveal.mockRejectedValue(new Error(MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE))
    const summary = await run()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(summary.deferred).toBe(2)
  })

  it('runs at most 4 reveals at a time', async () => {
    const ptys = Array.from({ length: 9 }, (_, index) => {
      const tabId = `tab-${index}`
      return pty({
        ptyId: `pty-${index}`,
        tabId,
        paneKey: `${tabId}:${LEAF_A}`,
        seq: index
      })
    })
    let inFlight = 0
    let peak = 0
    const { reveal, run } = makeDrain(ptys)
    reveal.mockImplementation(async (worktreeId, opts) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId } }
    })
    const summary = await run()
    expect(summary.revealed).toBe(9)
    expect(peak).toBe(4)
  })

  it('stops starting reveals when the time budget is spent and leaves the rest for the next call', async () => {
    vi.useFakeTimers()
    try {
      const ptys = Array.from({ length: 3 }, (_, index) => {
        const tabId = `tab-${index}`
        return pty({
          ptyId: `pty-${index}`,
          tabId,
          paneKey: `${tabId}:${LEAF_A}`,
          seq: index
        })
      })
      const { reveal, deps } = makeDrain(ptys)
      // A reveal that never answers: the drain must give up at the budget instead of hanging.
      reveal.mockImplementation(() => new Promise(() => {}))
      const done = drainLiveTerminalSurfaceReveals({
        ...deps,
        concurrency: 1,
        now: () => Date.now()
      })
      await vi.advanceTimersByTimeAsync(10_001)
      const summary = await done
      expect(summary.budgetExhausted).toBe(true)
      expect(reveal).toHaveBeenCalledTimes(1)
      expect(summary.deferred).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
  function twoTabs(): LiveSurfacePtyRecord[] {
    return ['a', 'b'].map((name, index) => {
      const tabId = `tab-${name}`
      return pty({ ptyId: `pty-${name}`, tabId, paneKey: `${tabId}:${LEAF_A}`, seq: index })
    })
  }

  it('reveals nothing more once the renderer epoch moves, leaves no receipt, and the next call reveals it', async () => {
    const receipts = new LiveSurfaceReceipts()
    let currentEpoch = 1
    const first = makeDrain(twoTabs(), { getEpoch: () => currentEpoch }, receipts)
    first.reveal.mockImplementation(async (worktreeId, opts) => {
      // A renderer reload lands while the first tab is being revealed.
      currentEpoch = 2
      return { identity: { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId } }
    })
    const summary = await drainLiveTerminalSurfaceReveals({ ...first.deps, concurrency: 1 })

    expect(first.reveal).toHaveBeenCalledTimes(1)
    expect(first.reveal.mock.calls[0]![1].ptyId).toBe('pty-a')
    expect(summary).toMatchObject({ revealed: 1, deferred: 1 })
    expect(receipts.get('pty-a', null, 1)).toBe('revealed')
    // No receipt under either epoch for the deferred terminal.
    expect(receipts.get('pty-b', null, 1)).toBeNull()
    expect(receipts.get('pty-b', null, 2)).toBeNull()

    // Next call re-plans against the new epoch and reveals it.
    const next = makeDrain(twoTabs(), {}, receipts, 2)
    await next.run()
    expect(next.reveal.mock.calls.map((call) => call[1].ptyId)).toContain('pty-b')
  })

  it('defers the item when the liveness round used up the whole budget', async () => {
    vi.useFakeTimers()
    try {
      const { reveal, deps } = makeDrain([pty()], {
        checkLiveness: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10_001))
          return { live: true as boolean | null }
        })
      })
      const done = drainLiveTerminalSurfaceReveals({ ...deps, now: () => Date.now() })
      await vi.advanceTimersByTimeAsync(10_002)
      const summary = await done
      expect(reveal).not.toHaveBeenCalled()
      expect(summary).toMatchObject({ budgetExhausted: true, deferred: 1, revealed: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
})
