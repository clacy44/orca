import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import { applyTerminalRoleRows, buildTerminalRoleAssignment } from './terminal-role-row'

function terminalRow(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_1',
    ptyId: 'pty-1',
    worktreeId: 'repo::/tmp/wt',
    worktreePath: '/tmp/wt',
    branch: 'main',
    tabId: 'tab-1',
    leafId: '33333333-3333-4333-8333-333333333333',
    title: 'Codex',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('applyTerminalRoleRows', () => {
  it('stamps only the rows whose paneKey has a persisted role', () => {
    const rows = [
      terminalRow(),
      terminalRow({
        handle: 'term_2',
        tabId: 'tab-2',
        leafId: '44444444-4444-4444-8444-444444444444'
      })
    ]

    applyTerminalRoleRows(rows, {
      'tab-1:33333333-3333-4333-8333-333333333333': 'merge-restructure backend'
    })

    expect(rows[0]?.role).toBe('merge-restructure backend')
    expect(rows[1]?.role).toBeUndefined()
  })

  it('tolerates a PTY-fallback row whose leafId names no addressable pane', () => {
    const rows = [terminalRow({ leafId: 'not-a-uuid' })]

    expect(() => applyTerminalRoleRows(rows, { 'tab-1:not-a-uuid': 'ignored' })).not.toThrow()
    expect(rows[0]?.role).toBeUndefined()
  })
})

describe('buildTerminalRoleAssignment', () => {
  it('separates the persisted paneKey identity from the handle-addressed result', () => {
    const assignment = buildTerminalRoleAssignment({
      handle: 'term_1',
      tabId: 'tab-1',
      leafId: '33333333-3333-4333-8333-333333333333',
      role: 'merge-restructure backend'
    })

    expect(assignment.persist).toEqual({
      tabId: 'tab-1',
      leafId: '33333333-3333-4333-8333-333333333333',
      role: 'merge-restructure backend'
    })
    expect(assignment.result).toEqual({ handle: 'term_1', role: 'merge-restructure backend' })
  })

  it('clears the role when role is null', () => {
    const assignment = buildTerminalRoleAssignment({
      handle: 'term_1',
      tabId: 'tab-1',
      leafId: '33333333-3333-4333-8333-333333333333',
      role: null
    })

    expect(assignment.persist.role).toBeNull()
    expect(assignment.result.role).toBeNull()
  })
})
