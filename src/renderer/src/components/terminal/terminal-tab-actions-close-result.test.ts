import { describe, expect, it, vi } from 'vitest'

// Why a dedicated file: terminal-tab-actions.test.ts is at the max-lines
// ratchet ceiling — these tests cover closeTerminalTab's Promise<boolean>
// contract specifically (never-rejects, host-confirmed true) and don't fit.

const {
  closeWebRuntimeSessionTabMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  toHostSessionTabIdMock
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: toHostSessionTabIdMock
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import { closeTerminalTab } from './terminal-tab-actions'

describe('closeTerminalTab return-value contract', () => {
  it('resolves true once the host confirms a host-backed close', async () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    closeWebRuntimeSessionTabMock.mockResolvedValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn(),
      dropAgentStatusByTabPrefix: vi.fn()
    })

    // Why skipRunningProcessConfirm: isolates the host-confirmed return value
    // from the running-process guard's own defer-to-reentry semantics, which
    // always resolves false regardless of what the reentrant call later does.
    await expect(
      closeTerminalTab('local-tab-1', { skipRunningProcessConfirm: true })
    ).resolves.toBe(true)
  })

  it('never rejects: a synchronous throw from the store resolves false instead of propagating', async () => {
    const closeTab = vi.fn(() => {
      throw new Error('store closeTab exploded')
    })
    getStateMock.mockReturnValue({
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      closeTab
    })

    await expect(closeTerminalTab('retired-worker-tab')).resolves.toBe(false)
  })
})
