import { describe, expect, it } from 'vitest'
import { isLaunchAnchorBoundToPty, isNewestPaneHookRowClaude } from './anchored-claude-identity'

const HASH = 'a'.repeat(64)

describe('isLaunchAnchorBoundToPty: the persisted anchor must name the pty on the pane now', () => {
  it('a well-formed anchor bound to exactly this pty identity binds', () => {
    expect(
      isLaunchAnchorBoundToPty({
        anchorLaunchTokenHash: HASH,
        anchorPty: 'pty-1:inc-1',
        ptyIdentity: 'pty-1:inc-1'
      })
    ).toBe(true)
  })

  it.each([
    ['a respawn (same ptyId, new incarnation)', HASH, 'pty-1:inc-1', 'pty-1:inc-2'],
    ['a later occupant (other ptyId)', HASH, 'pty-1:inc-1', 'pty-2:inc-9'],
    ['a legacy anchor with no binding', HASH, undefined, 'pty-1:inc-1'],
    ['a pty with no incarnation', HASH, 'pty-1:inc-1', null],
    ['no anchor on file', undefined, 'pty-1:inc-1', 'pty-1:inc-1'],
    ['a malformed hash', 'not-a-hash', 'pty-1:inc-1', 'pty-1:inc-1']
  ])('refuses %s', (_name, anchorLaunchTokenHash, anchorPty, ptyIdentity) => {
    expect(isLaunchAnchorBoundToPty({ anchorLaunchTokenHash, anchorPty, ptyIdentity })).toBe(false)
  })
})

describe("isNewestPaneHookRowClaude: the pane's newest row, any age, names claude", () => {
  const row = (agentType: string, receivedAt: number, paneKey = 'tab:1') => ({
    paneKey,
    agentType,
    receivedAt
  })

  it('the newest row being Claude counts, however old', () => {
    expect(isNewestPaneHookRowClaude([row('claude', 1)], 'tab:1')).toBe(true)
  })

  it('a newer non-Claude row supersedes an older Claude one', () => {
    expect(isNewestPaneHookRowClaude([row('claude', 1), row('codex', 2)], 'tab:1')).toBe(false)
  })

  it('rows for other panes, no rows, or no pane key never count', () => {
    expect(isNewestPaneHookRowClaude([row('claude', 1, 'tab:2')], 'tab:1')).toBe(false)
    expect(isNewestPaneHookRowClaude([], 'tab:1')).toBe(false)
    expect(isNewestPaneHookRowClaude([row('claude', 1)], null)).toBe(false)
  })
})
