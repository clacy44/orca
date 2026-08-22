// Why a live two-subscriber test and not another projection call: W9's projection was already covered,
// and the hole it could not see was the cadence — a device activating a tab emits only to itself, so
// every other subscriber's `deviceSelections` column was stale by construction (§2.1's worktreeId-keyed
// coalescer, §2.3 Surface 3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { terminalPresenceRegistry } from './terminal-presence-registry'
import {
  projectSessionTabsForClient,
  type SessionTabProjectionContext
} from './rpc/methods/session-tab-device-selections'

const WORKTREE_ID = 'repo-1::/tmp/session'
const SELECTOR = `id:${WORKTREE_ID}`

function seed(runtime: OrcaRuntimeService): void {
  const tabs = ['tab-a', 'tab-b'].map((id, index) => ({
    type: 'terminal' as const,
    id,
    parentTabId: id,
    leafId: `pane:${index + 1}`,
    ptyId: `pty-${index + 1}`,
    title: id,
    isActive: index === 0
  }))
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'renderer:test',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'tab-a',
        activeTabType: 'terminal',
        tabGroups: [{ id: 'group-1', activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b'] }],
        tabs
      }
    ]
  })
  runtime.registerPty('pty-1', WORKTREE_ID)
  runtime.registerPty('pty-2', WORKTREE_ID)
}

function establish(
  runtime: OrcaRuntimeService,
  connectionId: string,
  grant: string,
  label: string
) {
  runtime.registerSubscriptionCleanup(`sub-${connectionId}`, () => {}, connectionId)
  terminalPresenceRegistry.registerConnection({
    connectionId,
    pairedDeviceId: grant,
    label,
    kind: 'runtime'
  })
}

function projectFor(
  runtime: OrcaRuntimeService,
  frame: RuntimeMobileSessionTabsResult,
  pairedDeviceId: string
): RuntimeMobileSessionTabsResult {
  const ctx: SessionTabProjectionContext = {
    runtime,
    clientKind: 'runtime',
    clientCapabilities: undefined,
    pairedDeviceId
  }
  return projectSessionTabsForClient(frame, ctx, true)
}

describe('W9 device-selection cadence', () => {
  let runtime: OrcaRuntimeService
  const unsubscribes: (() => void)[] = []

  beforeEach(() => {
    terminalPresenceRegistry.reset()
    runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    seed(runtime)
  })

  afterEach(() => {
    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe())
    terminalPresenceRegistry.reset()
  })

  it('reaches the other subscribers of the worktree without moving their own selection', async () => {
    establish(runtime, 'conn-a', 'grant-a', 'Ana laptop')
    establish(runtime, 'conn-b', 'grant-b', 'Ben laptop')
    const ben: RuntimeMobileSessionTabsResult[] = []
    const legacy: RuntimeMobileSessionTabsResult[] = []
    unsubscribes.push(
      runtime.onMobileSessionTabsChanged((frame) => ben.push(frame), 'grant-b', {
        consumesDeviceSelections: true
      })
    )
    // The Rule 3 gate: a subscriber that never asked for deviceSelections must see no extra frame.
    unsubscribes.push(
      runtime.onMobileSessionTabsChanged((frame) => legacy.push(frame), 'grant-legacy')
    )

    await runtime.activateMobileSessionTab(SELECTOR, 'tab-b', undefined, {
      clientNavigationId: 'grant-b',
      navigation: 'caller'
    })
    runtime.flushTerminalPresenceDeviceSelectionsPublish()
    ben.length = 0
    legacy.length = 0

    await runtime.activateMobileSessionTab(SELECTOR, 'tab-a', undefined, {
      clientNavigationId: 'grant-a',
      navigation: 'caller'
    })
    // Ana's own activation reaches Ana alone; without the coalescer Ben never hears about it at all.
    expect(ben).toHaveLength(0)

    runtime.flushTerminalPresenceDeviceSelectionsPublish()

    expect(ben.length).toBeGreaterThan(0)
    expect(legacy).toHaveLength(0)
    const projected = projectFor(runtime, ben.at(-1)!, 'grant-b')
    // Ben's own navigation did not move — the only thing this frame carries is somebody else's row.
    expect(projected.activeTabId).toBe('tab-b')
    expect(projected.deviceSelections?.find((row) => row.label === 'Ana laptop')?.activeTabId).toBe(
      'tab-a'
    )
    expect(projected.deviceSelections?.find((row) => row.label === 'Ben laptop')?.activeTabId).toBe(
      'tab-b'
    )
  })
})
