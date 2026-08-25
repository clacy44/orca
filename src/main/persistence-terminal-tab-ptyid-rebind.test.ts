import { describe, expect, it } from 'vitest'
import { migrateTerminalTabId } from './persistence-terminal-tab-ptyid-rebind'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'

const OLD_ID = 'tab-old-11111111'
const NEW_ID = 'tab-new-22222222'

function fixtureSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: OLD_ID,
    // Why NEW_ID here, not OLD_ID: the caller renames the tab row's own `id`
    // in place before calling migrateTerminalTabId (see the module doc) —
    // this fixture reflects that precondition; migrateTerminalTabId's job is
    // only the OTHER structures still keyed by the stale id.
    tabsByWorktree: { 'wt-1': [{ id: NEW_ID, worktreeId: 'wt-1' } as never] },
    terminalLayoutsByTabId: {
      [OLD_ID]: {
        root: null,
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
      }
    },
    activeTabIdByWorktree: { 'wt-1': OLD_ID, 'wt-2': null },
    unifiedTabs: {
      'wt-1': [
        {
          id: OLD_ID,
          entityId: OLD_ID,
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        } as never
      ]
    },
    remoteSessionIdsByTabId: { [OLD_ID]: 'relay-session-1' },
    terminalPtyIncarnationsByPaneKey: { [`${OLD_ID}:leaf-1`]: 'incarnation-1' },
    terminalCredentialLanesByPaneKey: { [`${OLD_ID}:leaf-1`]: { worktreeId: 'wt-1' } },
    terminalSurfaceTombstonesByPaneKey: {
      [`${OLD_ID}:leaf-1`]: {
        worktreeId: 'wt-1',
        parentTabId: OLD_ID,
        leafId: 'leaf-1',
        ptyId: 'pty-1',
        incarnationId: 'inc-1',
        retiredAt: 0
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [`${OLD_ID}:leaf-1`]: {
        paneKey: `${OLD_ID}:leaf-1`,
        tabId: OLD_ID,
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: {},
        prompt: '',
        state: 'idle',
        capturedAt: 0,
        updatedAt: 0
      } as never
    }
  }
}

describe('migrateTerminalTabId', () => {
  it('migrates activeTabId, activeTabIdByWorktree, and unifiedTabs id/entityId', () => {
    const session = fixtureSession()

    migrateTerminalTabId(session, OLD_ID, NEW_ID)

    expect(session.activeTabId).toBe(NEW_ID)
    expect(session.activeTabIdByWorktree).toEqual({ 'wt-1': NEW_ID, 'wt-2': null })
    expect(session.unifiedTabs?.['wt-1']?.[0]).toMatchObject({ id: NEW_ID, entityId: NEW_ID })
  })

  it('migrates terminalLayoutsByTabId and remoteSessionIdsByTabId keys', () => {
    const session = fixtureSession()

    migrateTerminalTabId(session, OLD_ID, NEW_ID)

    expect(session.terminalLayoutsByTabId[OLD_ID]).toBeUndefined()
    expect(session.terminalLayoutsByTabId[NEW_ID]).toEqual({
      root: null,
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
    })
    expect(session.remoteSessionIdsByTabId).toEqual({ [NEW_ID]: 'relay-session-1' })
  })

  it('migrates every *ByPaneKey map (incarnation, credential lane, tombstone, sleeping agent)', () => {
    const session = fixtureSession()

    migrateTerminalTabId(session, OLD_ID, NEW_ID)

    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [`${NEW_ID}:leaf-1`]: 'incarnation-1'
    })
    expect(session.terminalCredentialLanesByPaneKey).toEqual({
      [`${NEW_ID}:leaf-1`]: { worktreeId: 'wt-1' }
    })
    const tombstone = session.terminalSurfaceTombstonesByPaneKey?.[`${NEW_ID}:leaf-1`]
    expect(tombstone).toMatchObject({ parentTabId: NEW_ID })
    const sleepingRecord = session.sleepingAgentSessionsByPaneKey?.[`${NEW_ID}:leaf-1`]
    expect(sleepingRecord).toMatchObject({ paneKey: `${NEW_ID}:leaf-1`, tabId: NEW_ID })
  })

  it('is a no-op when old and new ids match', () => {
    const session = fixtureSession()
    const before = JSON.stringify(session)

    migrateTerminalTabId(session, OLD_ID, OLD_ID)

    expect(JSON.stringify(session)).toBe(before)
  })

  // Why: a reflection scan, not a fixed list — every property whose name ends
  // in `ByTabId` is discovered dynamically and seeded under the OLD id, then
  // the ENTIRE post-migration session is string-scanned for that id. A future
  // `*ByTabId` map added to WorkspaceSessionState without a matching migration
  // fails this test immediately instead of silently reappearing under a stale id.
  it('reflection: no property ending in ByTabId, and no value anywhere, still references the old id', () => {
    const session = fixtureSession() as unknown as Record<string, unknown>
    const byTabIdKeys = Object.keys(session).filter((key) => key.endsWith('ByTabId'))
    expect(byTabIdKeys.length).toBeGreaterThan(0)
    for (const key of byTabIdKeys) {
      const record = session[key] as Record<string, unknown>
      expect(Object.hasOwn(record, OLD_ID)).toBe(true)
    }

    migrateTerminalTabId(session as unknown as WorkspaceSessionState, OLD_ID, NEW_ID)

    for (const key of byTabIdKeys) {
      const record = session[key] as Record<string, unknown>
      expect(Object.hasOwn(record, OLD_ID)).toBe(false)
    }
    expect(JSON.stringify(session)).not.toContain(OLD_ID)
  })
})
