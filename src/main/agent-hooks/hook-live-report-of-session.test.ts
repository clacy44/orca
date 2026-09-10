// S10-21d b3b (D-R163 M1 fix): hasLiveReportOfSession's excludePaneKey and its
// restoredUnconfirmed/retainedForLiveness exclusion — the GEN_ABSENCE signal's own live-report
// half must never see the dying holder's OWN stale rehydrated row as "live elsewhere" evidence.
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

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
        entry({ paneKey: OTHER_PANE, restoredUnconfirmed: true, receivedAt: 0 })
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
        entry({ paneKey: OTHER_PANE, retainedForLiveness: true, receivedAt: 0 })
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
        entry({ paneKey: OTHER_PANE, restoredUnconfirmed: true, receivedAt: Date.now() })
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
        entry({ paneKey: OTHER_PANE, retainedForLiveness: true, receivedAt: Date.now() })
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
        entry({ paneKey: HOLDER_PANE, retainedForLiveness: true, receivedAt: Date.now() })
      )
    expect(server.hasLiveReportOfSession(SESSION_ID, { excludePaneKey: HOLDER_PANE })).toBe(false)
  })
})
