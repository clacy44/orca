// The live-agent marks are keyed by the pty that holds the conversation; that pty's exit must drop
// them, or a legitimate wake/cold-restore later in the session stays blocked for good.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { LiveAgentSessionMark } from '../../../shared/sweep-restore-mark-list'
import { useAppStore } from '@/store'
import { ensurePtyDispatcher } from '@/components/terminal-pane/pty-dispatcher'
import { stopTerminalDeliveryWatchdog } from '@/components/terminal-pane/terminal-delivery-watchdog'
import { isHeldByOtherLiveAgentTerminal } from './live-agent-session-guard'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: true } }))

type ExitPayload = { id: string; code: number }
let emitExit: (payload: ExitPayload) => void = () => {
  throw new Error('dispatcher exit listener was never attached')
}

beforeAll(() => {
  // Why: the dispatcher binds its global exit listener once, so capture it here instead of per test.
  vi.stubGlobal('window', {
    api: {
      pty: {
        onData: vi.fn(() => () => {}),
        onReplay: vi.fn(() => () => {}),
        onExit: vi.fn((cb: (payload: ExitPayload) => void) => {
          emitExit = cb
          return () => {}
        }),
        onDeliveryResyncRequest: vi.fn(() => () => {}),
        respondDeliveryResync: vi.fn()
      }
    }
  })
  ensurePtyDispatcher()
  vi.unstubAllGlobals()
})

afterAll(() => {
  stopTerminalDeliveryWatchdog()
})

useAppStore.setState({ sweepRestoreMarksHydrated: true })
const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

const WORKTREE = 'wt-1'

function makeRecord(): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep'
  }
}

// K = the sleeping record's pane, P = the live pty that holds its conversation from another pane.
const MARK: LiveAgentSessionMark = {
  ptyId: 'pty-P',
  paneKey: 'tab-9:leaf-9',
  worktreeId: WORKTREE,
  agent: 'claude',
  providerSessionId: 'sess-1'
}

function seed(): SleepingAgentSessionRecord {
  const record = makeRecord()
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
    sweepRestoredPaneKeys: new Set<string>()
  } as never)
  useAppStore.getState().setLiveAgentSessions([MARK])
  return record
}

describe('live agent session marks and pty exit', () => {
  it('positive control: without an exit the live mark still blocks the worktree-sleep record', () => {
    const record = seed()

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('an exit of the holding pty drops its marks, so the worktree-sleep record launches', () => {
    seed()

    emitExit({ id: 'pty-P', code: 0 })

    const state = useAppStore.getState()
    expect(state.liveAgentSessionMarksByPtyId).toEqual({})
    expect(state.liveAgentSessionPaneKeys.size).toBe(0)
    expect(state.liveAgentSessionKeys.size).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE)).toBe(1)
  })

  it('an exit of an unrelated pty leaves the marks alone', () => {
    seed()

    emitExit({ id: 'pty-other', code: 0 })

    expect(useAppStore.getState().liveAgentSessionMarksByPtyId).toEqual({ 'pty-P': [MARK] })
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE)).toBe(0)
  })

  it('after the holder exits, the cold-restore guard lets another pane resume the same session', () => {
    seed()
    const otherPane = {
      paneKey: 'tab-2:leaf-2',
      worktreeId: WORKTREE,
      agent: 'claude',
      providerSessionId: 'sess-1'
    }
    expect(isHeldByOtherLiveAgentTerminal(useAppStore.getState(), otherPane)).toBe(true)

    emitExit({ id: 'pty-P', code: 0 })

    expect(isHeldByOtherLiveAgentTerminal(useAppStore.getState(), otherPane)).toBe(false)
  })

  it("keeps one pty's marks when a different pty of the same snapshot exits", () => {
    seed()
    const second: LiveAgentSessionMark = {
      ...MARK,
      ptyId: 'pty-Q',
      paneKey: 'tab-8:leaf-8',
      providerSessionId: 'sess-2'
    }
    useAppStore.getState().setLiveAgentSessions([MARK, second])

    emitExit({ id: 'pty-P', code: 0 })

    const state = useAppStore.getState()
    expect(state.liveAgentSessionMarksByPtyId).toEqual({ 'pty-Q': [second] })
    expect(state.liveAgentSessionPaneKeys).toEqual(new Set([second.paneKey]))
  })
})
