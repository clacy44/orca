// S10-21d b3b (D-R163 M1 fix): hasLiveReportOfSession's excludePaneKey and its
// restoredUnconfirmed/retainedForLiveness exclusion — the GEN_ABSENCE signal's own live-report
// half must never see the dying holder's OWN stale rehydrated row as "live elsewhere" evidence.
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

// [D-R170 L9] Pin the boundary against the real constant, close on either side of the
// threshold, rather than 0 vs Date.now() — either of which passes for ANY threshold strictly
// between 0 and now, so a future tightening of this ~40-consumer UI constant would silently
// collapse the safety window with nothing turning red. A 1s margin (not 1ms) keeps this stable
// against ordinary test-runner scheduling jitter between computing the value and the
// production code's own `Date.now()` read.
const BOUNDARY_MARGIN_MS = 1_000
const STALE_RECEIVED_AT = Date.now() - AGENT_STATUS_STALE_AFTER_MS - BOUNDARY_MARGIN_MS
// [D-R171 LOW] Call-time, not module-load-time: compared against the production code's own
// Date.now() read, so a value fixed at import time could drift past the margin under load.
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

describe('D-R163 M1: AgentHookServer.hasLiveReportOfSession', () => {
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
    expect(server.hasLiveReportOfSession(SESSION_ID)).toBe(true)
    expect(server.hasLiveReportOfSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toBe(false)
  })

  it('a DIFFERENT pane naming X is never excluded', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server._getStateForTests().lastStatusByPaneKey.set(OTHER_PANE, entry({ paneKey: OTHER_PANE }))
    expect(server.hasLiveReportOfSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toBe(true)
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
    expect(server.hasLiveReportOfSession(SESSION_ID)).toBe(false)
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
    expect(server.hasLiveReportOfSession(SESSION_ID)).toBe(false)
  })

  it('[G1-10o B5/C35 fix] a RECENT restoredUnconfirmed entry on a non-holder pane IS live evidence', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        OTHER_PANE,
        entry({ paneKey: OTHER_PANE, restoredUnconfirmed: true, receivedAt: recentReceivedAt() })
      )
    expect(server.hasLiveReportOfSession(SESSION_ID)).toBe(true)
  })

  it('[G1-10o B5/C35 fix] a RECENT retainedForLiveness entry on a non-holder pane IS live evidence', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        OTHER_PANE,
        entry({ paneKey: OTHER_PANE, retainedForLiveness: true, receivedAt: recentReceivedAt() })
      )
    expect(server.hasLiveReportOfSession(SESSION_ID)).toBe(true)
  })

  it("[G1-10o B5/C35 fix] the holder's own RECENT retainedForLiveness row is still excluded by excludePaneKey", () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        HOLDER_PANE,
        entry({ paneKey: HOLDER_PANE, retainedForLiveness: true, receivedAt: recentReceivedAt() })
      )
    expect(server.hasLiveReportOfSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toBe(false)
  })

  // [D-R170 M10] The single remaining guard on OD-21d-1 (the pane-key comparison at :864-866)
  // pinned for the flag hydrate ACTUALLY stamps on every non-done row — restoredUnconfirmed,
  // not retainedForLiveness. Twin of the test above.
  it("[D-R170 M10] the holder's own RECENT restoredUnconfirmed row is still excluded by excludePaneKey", () => {
    const server = new AgentHookServer()
    servers.push(server)
    server
      ._getStateForTests()
      .lastStatusByPaneKey.set(
        HOLDER_PANE,
        entry({ paneKey: HOLDER_PANE, restoredUnconfirmed: true, receivedAt: recentReceivedAt() })
      )
    expect(server.hasLiveReportOfSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toBe(false)
  })
})
