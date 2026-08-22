// @vitest-environment happy-dom
// Why the real hook and not the setter: the leak was that nothing ever cleared selections, so a test
// calling the clearer proves nothing. Only a worktree switch through the hook exercises the teardown.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import {
  getPresenceRosterForEnvironment,
  resetTerminalPresenceStateForTest
} from '@/lib/pane-manager/terminal-presence-state'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const OTHER_WORKTREE = 'repo-a::worktree-b'
const REVISION_A = 101
const MIRROR_KEY = [ENV_A, 'runtime-a', '1', String(REVISION_A)].join('|')
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn(async () => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-test' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function snapshotWithSelections(worktree: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: 'tab-a',
    activeTabType: 'file',
    tabs: [
      {
        type: 'file',
        id: 'tab-a',
        title: 'server.ts',
        filePath: '/repo/server.ts',
        relativePath: 'server.ts',
        language: 'typescript',
        isDirty: false,
        isActive: true
      }
    ],
    deviceSelections: [
      {
        participantId: 'p-ana',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-a',
        activeTabType: 'file'
      }
    ]
  }
}

function findSubscription(selector: string): RuntimeSubscription {
  const subscription = subscriptions.find(
    ({ request }) => request.method === 'session.tabs.subscribe' && request.selector === selector
  )
  if (!subscription) {
    throw new Error(`Missing session.tabs.subscribe subscription for ${selector}`)
  }
  return subscription
}

function seedState(activeWorktreeId: string): void {
  const runtimeEnvironments = [
    { id: ENV_A, createdAt: 100, pairingRevision: REVISION_A }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    },
    true
  )
}

describe('useWebSessionTabsSync presence selections', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetTerminalPresenceStateForTest()
    resetWebSessionTabsSnapshotFreshnessForTests()
    seedState(WORKTREE)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetStaleDocumentVisibilityForTesting()
    resetTerminalPresenceStateForTest()
  })

  it('drops the previous worktree titles when the subscription that produced them goes away', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const subscription = findSubscription(ENV_A)
    expect(subscription.request.params).toMatchObject({ includeDeviceSelections: true })
    await act(async () => {
      subscription.callbacks.onResponse({
        id: 'subscription-event',
        ok: true as const,
        result: { type: 'snapshot', ...snapshotWithSelections(WORKTREE) },
        _meta: { runtimeId: 'runtime-test' }
      })
      await settle()
    })

    expect(
      getPresenceRosterForEnvironment(ENV_A).selections.map((row) => row.activeTabTitle)
    ).toEqual(['server.ts'])

    // A worktree switch resubscribes; the old titles must not survive to be joined against the new one.
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: OTHER_WORKTREE })
      await settle()
    })

    expect(getPresenceRosterForEnvironment(ENV_A).selections).toEqual([])
  })
})
