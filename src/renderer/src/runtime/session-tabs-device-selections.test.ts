import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toTerminalPresenceSelections } from './session-tabs-device-selections'

function snapshot(
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'id:wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        title: 'server.ts',
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1'
      }
    ],
    ...overrides
  } as RuntimeMobileSessionTabsResult
}

describe('toTerminalPresenceSelections', () => {
  it('joins each selection to the title on the snapshot it arrived with', () => {
    expect(
      toTerminalPresenceSelections(
        snapshot({
          deviceSelections: [
            {
              participantId: 'p-1',
              label: 'Ana laptop',
              kind: 'runtime',
              self: false,
              activeTabId: 'tab-1',
              activeTabType: 'terminal'
            }
          ]
        })
      )
    ).toEqual([
      {
        participantId: 'p-1',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        activeTabTitle: 'server.ts'
      }
    ])
  })

  it('publishes an unresolvable tab with a null title rather than dropping the person', () => {
    const rows = toTerminalPresenceSelections(
      snapshot({
        deviceSelections: [
          {
            participantId: 'p-1',
            label: 'Ben phone',
            kind: 'mobile',
            self: false,
            activeTabId: 'tab-gone',
            activeTabType: 'markdown'
          }
        ]
      })
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].activeTabTitle).toBeNull()
  })

  it('reads a host that never published the key as nobody selecting anything', () => {
    // Negative control: an old host omits `deviceSelections` entirely, and that must not throw.
    expect(toTerminalPresenceSelections(snapshot())).toEqual([])
  })
})
