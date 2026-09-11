// S10-21f b2-10q R143: AgentHookServer.liveReportPanesForSession — the pane-granular twin of
// hasLiveReportOfSession (hook-live-report-of-session.test.ts), same excludePaneKey and
// restoredUnconfirmed/retainedForLiveness recency rule, but returning the reporter pane(s) +
// executionHostId instead of a collapsed boolean.
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const BOUNDARY_MARGIN_MS = 1_000
const STALE_RECEIVED_AT = Date.now() - AGENT_STATUS_STALE_AFTER_MS - BOUNDARY_MARGIN_MS
function recentReceivedAt(): number {
  return Date.now() - AGENT_STATUS_STALE_AFTER_MS + BOUNDARY_MARGIN_MS
}

const HOLDER_PANE = makePaneKey('tab-holder', '11111111-1111-4111-8111-111111111111')
const OTHER_PANE = makePaneKey('tab-other', '22222222-2222-4222-8222-222222222222')
const SESSION_ID = 'session-under-test'

type TestEntry = AgentHookEventPayload & {
  receivedAt: number
  stateStartedAt: number
  restoredUnconfirmed?: true
  retainedForLiveness?: true
  connectionId?: string
}

function entry(overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    paneKey: HOLDER_PANE,
    tabId: 'tab-holder',
    payload: { state: 'working', prompt: '' },
    providerSession: { key: 'session_id', id: SESSION_ID },
    receivedAt: 100,
    stateStartedAt: 100,
    ...overrides
  } as TestEntry
}

describe('R143: AgentHookServer.liveReportPanesForSession', () => {
  const servers: AgentHookServer[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
  })

  it('excludePaneKey skips the holder pane so its own stale row naming X does not count', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server._getStateForTests().lastStatusByPaneKey.set(HOLDER_PANE, entry())
    expect(server.liveReportPanesForSession(SESSION_ID)).toEqual([
      { paneKey: HOLDER_PANE, executionHostId: LOCAL_EXECUTION_HOST_ID }
    ])
    expect(server.liveReportPanesForSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toEqual(
      []
    )
  })

  it('a DIFFERENT pane naming X is never excluded, and its executionHostId is local by default', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server._getStateForTests().lastStatusByPaneKey.set(OTHER_PANE, entry({ paneKey: OTHER_PANE }))
    expect(server.liveReportPanesForSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toEqual([
      { paneKey: OTHER_PANE, executionHostId: LOCAL_EXECUTION_HOST_ID }
    ])
  })

  it('a STALE restoredUnconfirmed entry on a non-holder pane is never live evidence', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        OTHER_PANE,
        entry({ paneKey: OTHER_PANE, restoredUnconfirmed: true, receivedAt: STALE_RECEIVED_AT })
      )
    expect(server.liveReportPanesForSession(SESSION_ID)).toEqual([])
  })

  it('a STALE retainedForLiveness entry on a non-holder pane is never live evidence', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        OTHER_PANE,
        entry({ paneKey: OTHER_PANE, retainedForLiveness: true, receivedAt: STALE_RECEIVED_AT })
      )
    expect(server.liveReportPanesForSession(SESSION_ID)).toEqual([])
  })

  it('a RECENT restoredUnconfirmed entry on a non-holder pane IS live evidence', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        OTHER_PANE,
        entry({ paneKey: OTHER_PANE, restoredUnconfirmed: true, receivedAt: recentReceivedAt() })
      )
    expect(server.liveReportPanesForSession(SESSION_ID)).toEqual([
      { paneKey: OTHER_PANE, executionHostId: LOCAL_EXECUTION_HOST_ID }
    ])
  })

  it("the holder's own RECENT retainedForLiveness row is still excluded by excludePaneKey", () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        HOLDER_PANE,
        entry({ paneKey: HOLDER_PANE, retainedForLiveness: true, receivedAt: recentReceivedAt() })
      )
    expect(server.liveReportPanesForSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toEqual(
      []
    )
  })

  it('multiple reporter panes are all returned', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server._getStateForTests().lastStatusByPaneKey.set(HOLDER_PANE, entry())
    server._getStateForTests().lastStatusByPaneKey.set(OTHER_PANE, entry({ paneKey: OTHER_PANE }))
    const result = server.liveReportPanesForSession(SESSION_ID)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.paneKey).sort()).toEqual([HOLDER_PANE, OTHER_PANE].sort())
  })
})
