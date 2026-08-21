import { describe, expect, it } from 'vitest'
import { resolveDispatchMailboxTerminalHandle } from './dispatch-mailbox-terminal'
import { WORKER_SETTLED_STATES } from './worker-terminal-ownership'

describe('resolveDispatchMailboxTerminalHandle', () => {
  it('returns null when the Dispatch has no row on this runtime', () => {
    expect(resolveDispatchMailboxTerminalHandle({})).toBeNull()
    expect(
      resolveDispatchMailboxTerminalHandle({ dispatch: null, worker: null, attachment: null })
    ).toBeNull()
  })

  it('prefers the worker row terminal over a differing assignee handle', () => {
    // The assignee handle is the pane the coordinator dispatched into; the worker row
    // records where the agent actually runs, and a wrapper pane can differ.
    expect(
      resolveDispatchMailboxTerminalHandle({
        dispatch: { status: 'dispatched', assignee_handle: 'term_assignee' },
        worker: { state: 'ready', agent_terminal_handle: 'term_agent' }
      })
    ).toBe('term_agent')
  })

  it('falls back to the assignee handle when the worker row owns no terminal yet', () => {
    expect(
      resolveDispatchMailboxTerminalHandle({
        dispatch: { status: 'dispatched', assignee_handle: 'term_assignee' },
        worker: { state: 'starting', agent_terminal_handle: null }
      })
    ).toBe('term_assignee')
  })

  it.each(['pending', 'dispatched'] as const)('points a %s Dispatch', (status) => {
    expect(
      resolveDispatchMailboxTerminalHandle({
        dispatch: { status, assignee_handle: 'term_assignee' }
      })
    ).toBe('term_assignee')
  })

  it.each(['completed', 'failed', 'circuit_broken'] as const)(
    'refuses a %s Dispatch even with a live terminal',
    (status) => {
      expect(
        resolveDispatchMailboxTerminalHandle({
          dispatch: { status, assignee_handle: 'term_assignee' },
          worker: { state: 'ready', agent_terminal_handle: 'term_agent' }
        })
      ).toBeNull()
    }
  )

  it.each(WORKER_SETTLED_STATES)('refuses a %s worker row', (state) => {
    expect(
      resolveDispatchMailboxTerminalHandle({
        dispatch: { status: 'dispatched', assignee_handle: 'term_assignee' },
        worker: { state, agent_terminal_handle: 'term_agent' }
      })
    ).toBeNull()
  })

  it.each(WORKER_SETTLED_STATES)('refuses a %s peer attachment', (state) => {
    expect(
      resolveDispatchMailboxTerminalHandle({
        attachment: { state, terminal_handle: 'term_peer_worker' },
        isAttachmentProcessCurrent: true
      })
    ).toBeNull()
  })

  it('points a live peer attachment whose pane process is still current', () => {
    expect(
      resolveDispatchMailboxTerminalHandle({
        attachment: { state: 'ready', terminal_handle: 'term_peer_worker' },
        isAttachmentProcessCurrent: true
      })
    ).toBe('term_peer_worker')
  })

  it('refuses a peer attachment whose pane process moved on', () => {
    // check() answers dispatch_inactive for exactly this row; the push must not be laxer.
    expect(
      resolveDispatchMailboxTerminalHandle({
        attachment: { state: 'ready', terminal_handle: 'term_peer_worker' },
        isAttachmentProcessCurrent: false
      })
    ).toBeNull()
    expect(
      resolveDispatchMailboxTerminalHandle({
        attachment: { state: 'ready', terminal_handle: 'term_peer_worker' }
      })
    ).toBeNull()
  })

  it('keeps a local dispatch pointable when only its stale attachment is not current', () => {
    // The process check fences the peer row alone; a home-side Dispatch is matched by
    // assignee identity, exactly as the pull path matches it.
    expect(
      resolveDispatchMailboxTerminalHandle({
        dispatch: { status: 'dispatched', assignee_handle: 'term_assignee' },
        attachment: { state: 'ready', terminal_handle: 'term_peer_worker' },
        isAttachmentProcessCurrent: false
      })
    ).toBe('term_assignee')
  })

  it('returns null when every present row owns no terminal', () => {
    expect(
      resolveDispatchMailboxTerminalHandle({
        dispatch: { status: 'dispatched', assignee_handle: null },
        worker: { state: 'ready', agent_terminal_handle: null },
        attachment: { state: 'ready', terminal_handle: null },
        isAttachmentProcessCurrent: true
      })
    ).toBeNull()
  })
})
