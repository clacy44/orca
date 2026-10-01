// R316 (T15): AgentHookServer.backgroundWorkVerdict — the host's explicit "is anything still
// running behind this pane" answer for agent-sleep. `done` alone is never 'idle'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  clearAllListenerCaches,
  type AgentHookEventPayload
} from '../../shared/agent-hook-listener'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const RUNNING_SHELL = { id: 'shell-1', type: 'shell', status: 'running' }

let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  await server.start({ env: 'production' })
})

afterEach(() => {
  server.stop()
})

async function post(payload: Record<string, unknown>, paneKey = PANE): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      env: 'production',
      payload
    })
  })
  expect(response.status).toBe(204)
}

describe('AgentHookServer.backgroundWorkVerdict (hook-driven)', () => {
  it('is idle only for a done turn whose own inventory said nothing is running', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop', background_tasks: [] })
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
    expect(server.backgroundWorkVerdict(PANE)).toBe('idle')
  })

  it('is unknown for a done turn that carried no background_tasks inventory', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop' })
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
  })

  it('goes back to unknown when a later turn boundary drops the inventory', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop', background_tasks: [] })
    expect(server.backgroundWorkVerdict(PANE)).toBe('idle')
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    await post({ hook_event_name: 'Stop' })
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
  })

  it('is busy for a done turn with a running non-agent task', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    expect(server.backgroundWorkVerdict(PANE)).toBe('busy')
  })

  it('is busy for a done turn with an active session cron', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop', background_tasks: [], session_crons: [{ id: 'cron-1' }] })
    expect(server.backgroundWorkVerdict(PANE)).toBe('busy')
  })

  it('is unknown while the pane is working and for a pane the server has never seen', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
    expect(server.backgroundWorkVerdict(makePaneKey('tab-9', LEAF))).toBe('unknown')
  })

  it('stops reporting idle once the pane cache is cleared', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await post({ hook_event_name: 'Stop', background_tasks: [] })
    expect(server.backgroundWorkVerdict(PANE)).toBe('idle')
    clearAllListenerCaches(server._getStateForTests())
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
  })
})

describe('AgentHookServer.backgroundWorkVerdict (state-driven)', () => {
  function seedDone(
    overrides: Partial<AgentHookEventPayload & { restoredUnconfirmed: true }> = {}
  ) {
    const state = server._getStateForTests()
    state.lastStatusByPaneKey.set(PANE, {
      paneKey: PANE,
      source: 'claude',
      tabId: 'tab-1',
      connectionId: null,
      payload: { state: 'done', prompt: '' },
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      ...overrides
    } as AgentHookEventPayload)
    state.claudeBackgroundInventoryObservedPaneKeys.add(PANE)
    return state
  }

  it('is idle for a live done claude status with an observed empty inventory', () => {
    seedDone()
    expect(server.backgroundWorkVerdict(PANE)).toBe('idle')
  })

  it('is busy for a done status with a working roster child', () => {
    const state = seedDone()
    state.claudeSubagentRosterByPaneKey.set(
      PANE,
      new Map([['agent-1', { startedAt: 1, state: 'working' }]])
    )
    expect(server.backgroundWorkVerdict(PANE)).toBe('busy')
  })

  it('treats an idle (parked) teammate as no work', () => {
    const state = seedDone()
    state.claudeSubagentRosterByPaneKey.set(
      PANE,
      new Map([['mate', { startedAt: 1, state: 'idle' }]])
    )
    expect(server.backgroundWorkVerdict(PANE)).toBe('idle')
  })

  it('is busy for a running non-agent task or an active cron even without an observed inventory', () => {
    const state = seedDone()
    state.claudeBackgroundInventoryObservedPaneKeys.delete(PANE)
    state.claudeRunningNonAgentTaskPaneKeys.add(PANE)
    expect(server.backgroundWorkVerdict(PANE)).toBe('busy')
    state.claudeRunningNonAgentTaskPaneKeys.delete(PANE)
    state.claudeActiveSessionCronPaneKeys.add(PANE)
    expect(server.backgroundWorkVerdict(PANE)).toBe('busy')
  })

  it('is unknown for a restoredUnconfirmed status even when it reads done', () => {
    seedDone({ restoredUnconfirmed: true } as never)
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
  })

  it('is unknown for a claude done status with no observed inventory', () => {
    const state = seedDone()
    state.claudeBackgroundInventoryObservedPaneKeys.delete(PANE)
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
  })

  it('is unknown for any last status other than done', () => {
    seedDone({ payload: { state: 'waiting', prompt: '' } } as never)
    expect(server.backgroundWorkVerdict(PANE)).toBe('unknown')
  })
})
