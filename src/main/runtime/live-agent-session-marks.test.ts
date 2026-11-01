import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { collectLiveAgentSessionMarks } from './live-agent-session-marks'

const NOW = 10_000_000
const livePanes = [{ ptyId: 'pty-1', paneKey: 'tab-1:leaf-1', worktreeId: 'wt-1' }]

describe('collectLiveAgentSessionMarks', () => {
  it('names the session from the latest hook status of a live pane', () => {
    const marks = collectLiveAgentSessionMarks({
      livePanes,
      statuses: [
        {
          paneKey: 'tab-1:leaf-1',
          agentType: 'claude',
          providerSession: { id: 'session-1' },
          receivedAt: NOW
        }
      ],
      books: null,
      hostId: 'host-1',
      now: NOW
    })
    expect(marks).toEqual([
      {
        ptyId: 'pty-1',
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: 'session-1'
      }
    ])
  })

  it('ignores a status for a pane that is not live in the inventory', () => {
    const marks = collectLiveAgentSessionMarks({
      livePanes: [],
      statuses: [
        {
          paneKey: 'tab-1:leaf-1',
          agentType: 'claude',
          providerSession: { id: 'session-1' },
          receivedAt: NOW
        }
      ],
      books: null,
      hostId: 'host-1',
      now: NOW
    })
    expect(marks).toEqual([])
  })

  it('ignores a restored, never-reconfirmed status older than the stale bound', () => {
    const marks = collectLiveAgentSessionMarks({
      livePanes,
      statuses: [
        {
          paneKey: 'tab-1:leaf-1',
          agentType: 'claude',
          providerSession: { id: 'session-1' },
          receivedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
          restoredUnconfirmed: true
        }
      ],
      books: null,
      hostId: 'host-1',
      now: NOW
    })
    expect(marks).toEqual([])
  })

  it('adds the session the launch books say a live pane holds, once', () => {
    const books = {
      newestLaunchForPane: () => ({ agent_type: 'claude', session_id: 'session-2' }),
      paneHoldingSession: (_host: string, session: string) =>
        session === 'session-2' ? 'tab-1:leaf-1' : undefined
    }
    const marks = collectLiveAgentSessionMarks({
      livePanes,
      statuses: [
        {
          paneKey: 'tab-1:leaf-1',
          agentType: 'claude',
          providerSession: { id: 'session-2' },
          receivedAt: NOW
        }
      ],
      books,
      hostId: 'host-1',
      now: NOW
    })
    expect(marks).toEqual([
      {
        ptyId: 'pty-1',
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSessionId: 'session-2'
      }
    ])
  })

  it('does not trust a launch row whose session the books moved to another pane', () => {
    const marks = collectLiveAgentSessionMarks({
      livePanes,
      statuses: [],
      books: {
        newestLaunchForPane: () => ({ agent_type: 'claude', session_id: 'session-3' }),
        paneHoldingSession: () => 'tab-9:leaf-9'
      },
      hostId: 'host-1',
      now: NOW
    })
    expect(marks).toEqual([])
  })
})
