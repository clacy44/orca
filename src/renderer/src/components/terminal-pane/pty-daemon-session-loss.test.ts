import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  capture: vi.fn<(paneKey: string, opts?: { reanchor?: boolean }) => void>(),
  recover: vi.fn<(request: unknown) => Promise<boolean>>(async () => true),
  mount: vi.fn<(detail: unknown) => void>(),
  order: [] as string[]
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => h.state } }))
vi.mock('./terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: (request: unknown) => {
    h.order.push('recover')
    return h.recover(request)
  }
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: (detail: unknown) => {
    h.order.push('mount')
    h.mount(detail)
  }
}))

import {
  _resetDaemonSessionLossForTests,
  handleDaemonSessionsLost
} from './pty-daemon-session-loss'
import { ptyDaemonSessionLostHandlers } from './pty-daemon-session-loss-registry'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = `tab-1:${LEAF_A}`
const PANE_B = `tab-1:${LEAF_B}`
const SHELL_PANE = `tab-shell:${LEAF_A}`

function agentEntry(paneKey: string, tabId: string) {
  return { paneKey, tabId, state: 'done', agentType: 'claude' }
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'], 'tab-shell': ['pty-shell'] },
    terminalLayoutsByTabId: {},
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', worktreeId: 'wt-1' }],
      'wt-2': [{ id: 'tab-shell', worktreeId: 'wt-2' }]
    },
    agentStatusByPaneKey: { [PANE_A]: agentEntry(PANE_A, 'tab-1') },
    sleepingAgentSessionsByPaneKey: {},
    captureSleepingAgentSessionForDaemonDeath: (paneKey: string, opts?: { reanchor?: boolean }) => {
      h.order.push(`capture:${paneKey}`)
      h.capture(paneKey, opts)
    },
    ...overrides
  }
}

beforeEach(() => {
  _resetDaemonSessionLossForTests()
  h.capture.mockReset()
  h.recover.mockReset()
  h.recover.mockResolvedValue(true)
  h.mount.mockReset()
  h.order.length = 0
  h.state = baseState()
})

afterEach(() => {
  _resetDaemonSessionLossForTests()
})

describe('handleDaemonSessionsLost (R315)', () => {
  it('calls a bound pane handler with the chair verdict and mounts nothing in the background', () => {
    const handler = vi.fn(() => true)
    ptyDaemonSessionLostHandlers.set('pty-a', handler)

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: true }]
    })

    expect(handler).toHaveBeenCalledWith({ reanchor: true, paneKeys: [PANE_A] })
    expect(h.recover).not.toHaveBeenCalled()
    expect(h.mount).not.toHaveBeenCalled()
    expect(h.capture).toHaveBeenCalledWith(PANE_A, { reanchor: true })
  })

  it('on an unbound agent tab: captures first, then one recovery request and one background mount', () => {
    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: true }]
    })

    expect(h.order).toEqual([`capture:${PANE_A}`, 'recover', 'mount'])
    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.recover).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-a',
      reason: 'daemon-session-lost',
      relaunchPaneKeys: [PANE_A]
    })
    expect(h.mount).toHaveBeenCalledTimes(1)
    expect(h.mount).toHaveBeenCalledWith({ worktreeId: 'wt-1', tabIds: ['tab-1'] })
  })

  it('captures BOTH records for two lost panes in one tab and remounts the tab once', () => {
    h.state = baseState({
      agentStatusByPaneKey: {
        [PANE_A]: agentEntry(PANE_A, 'tab-1'),
        [PANE_B]: agentEntry(PANE_B, 'tab-1')
      }
    })

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [
        { id: 'pty-a', paneKey: PANE_A, reanchor: true },
        { id: 'pty-b', paneKey: PANE_B, reanchor: false }
      ]
    })

    expect(h.capture).toHaveBeenCalledTimes(2)
    expect(h.capture).toHaveBeenCalledWith(PANE_A, { reanchor: true })
    expect(h.capture).toHaveBeenCalledWith(PANE_B, { reanchor: false })
    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.mount).toHaveBeenCalledTimes(1)
    // Both captures land before the single recovery.
    expect(h.order.indexOf('recover')).toBeGreaterThan(h.order.lastIndexOf(`capture:${PANE_B}`))
  })

  it('calls only one bound handler when two bound panes of one tab are lost', () => {
    const handlerA = vi.fn(() => true)
    const handlerB = vi.fn(() => true)
    ptyDaemonSessionLostHandlers.set('pty-a', handlerA)
    ptyDaemonSessionLostHandlers.set('pty-b', handlerB)

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [
        { id: 'pty-a', paneKey: PANE_A, reanchor: false },
        { id: 'pty-b', paneKey: PANE_B, reanchor: false }
      ]
    })

    expect(handlerA.mock.calls.length + handlerB.mock.calls.length).toBe(1)
  })

  it('falls back to a plain recovery and background mount when the bound handler declines (stale or disposed)', () => {
    ptyDaemonSessionLostHandlers.set(
      'pty-a',
      vi.fn(() => false)
    )

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: true }]
    })

    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.recover).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-a',
      reason: 'daemon-session-lost',
      relaunchPaneKeys: [PANE_A]
    })
    expect(h.mount).toHaveBeenCalledTimes(1)
  })

  it('treats a repeated epoch:id as a no-op', () => {
    const payload = { epoch: 4, sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: true }] }
    handleDaemonSessionsLost(payload)
    handleDaemonSessionsLost(payload)

    expect(h.capture).toHaveBeenCalledTimes(1)
    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.mount).toHaveBeenCalledTimes(1)
  })

  it('treats the same id in a LATER epoch as a new death', () => {
    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: false }]
    })
    handleDaemonSessionsLost({
      epoch: 2,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: false }]
    })

    expect(h.recover).toHaveBeenCalledTimes(2)
  })

  it('is a no-op for a tab already rebound to a new pty id', () => {
    h.state = baseState({ ptyIdsByTabId: { 'tab-1': ['pty-new'] } })

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: true }]
    })

    expect(h.capture).not.toHaveBeenCalled()
    expect(h.recover).not.toHaveBeenCalled()
    expect(h.mount).not.toHaveBeenCalled()
  })

  it('does not background-mount an unmounted plain-shell tab (it recovers on reveal)', () => {
    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-shell', paneKey: SHELL_PANE, reanchor: false }]
    })

    expect(h.recover).toHaveBeenCalledWith({
      tabId: 'tab-shell',
      ptyId: 'pty-shell',
      reason: 'daemon-session-lost',
      relaunchPaneKeys: [SHELL_PANE]
    })
    expect(h.mount).not.toHaveBeenCalled()
  })

  it('finds a never-mounted tab through its persisted layout binding', () => {
    h.state = baseState({
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-1': { root: { type: 'leaf', leafId: LEAF_A }, ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } }
      }
    })

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: false }]
    })

    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.mount).toHaveBeenCalledTimes(1)
  })

  it('counts a sleeping record as an agent pane for the background mount', () => {
    h.state = baseState({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [PANE_A]: { paneKey: PANE_A, tabId: 'tab-1' } }
    })

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: false }]
    })

    expect(h.mount).toHaveBeenCalledTimes(1)
  })

  it('survives a throwing capture and still recovers the tab', () => {
    h.state = baseState({
      captureSleepingAgentSessionForDaemonDeath: () => {
        throw new Error('store torn down')
      }
    })

    handleDaemonSessionsLost({
      epoch: 1,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: false }]
    })

    expect(h.recover).toHaveBeenCalledTimes(1)
  })

  // R326: the manual restart announces through this same dispatcher. The tab still holds the killed
  // pty id and the chair is mid-turn, because main sent no pty:exit and cleared no status first.
  it('R326: a restart-shaped notice (tab still holds the id, chair working) captures a re-anchor daemon-death record from the live status and requests one recovery', () => {
    const captured: { paneKey: string; reanchor: boolean | undefined; liveState: unknown }[] = []
    h.state = baseState({
      agentStatusByPaneKey: {
        [PANE_A]: { paneKey: PANE_A, tabId: 'tab-1', state: 'working', agentType: 'claude' }
      },
      captureSleepingAgentSessionForDaemonDeath: (
        paneKey: string,
        opts?: { reanchor?: boolean }
      ) => {
        const live = (h.state.agentStatusByPaneKey as Record<string, { state: string }>)[paneKey]
        captured.push({ paneKey, reanchor: opts?.reanchor, liveState: live?.state })
      }
    })

    handleDaemonSessionsLost({
      epoch: 9001,
      sessions: [{ id: 'pty-a', paneKey: PANE_A, reanchor: true }]
    })

    expect(captured).toEqual([{ paneKey: PANE_A, reanchor: true, liveState: 'working' }])
    expect(h.recover).toHaveBeenCalledTimes(1)
    expect(h.recover).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-a',
      reason: 'daemon-session-lost',
      relaunchPaneKeys: [PANE_A]
    })
  })
})
