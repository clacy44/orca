// Repro control for the duplicate tab a restored chair used to get: a chair pty created with
// background presentation has no tab, yet its hook reports still become an origin 'live' sleeping
// record, and with no live-session mark for its pty the next resume pass opens a SECOND tab with
// `--resume <id>`. (The mark push that closes this is covered in useIpcEvents-live-session-push.)
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

useAppStore.setState({ sweepRestoreMarksHydrated: true })
const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

const WORKTREE = 'wt-1'
const PANE_KEY = 'tab-chair:11111111-1111-4111-8111-111111111111'
const SESSION = 'sess-chair-1'

function reportFromTablessPane(): void {
  useAppStore.getState().setAgentStatus(
    PANE_KEY,
    { state: 'working', prompt: '', agentType: 'claude' },
    'Claude',
    { updatedAt: Date.now(), stateStartedAt: Date.now() },
    // Hook routing as main stamps it for a background chair: a worktree and a runtime handle, no tab.
    { worktreeId: WORKTREE, terminalHandle: 'term_chair' },
    { providerSession: { key: 'session_id', id: SESSION } }
  )
}

describe('a tab-less agent pane that reports hooks', () => {
  it('becomes an origin live sleeping record', () => {
    reportFromTablessPane()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      origin: 'live',
      worktreeId: WORKTREE,
      agent: 'claude',
      providerSession: { id: SESSION }
    })
  })

  it('with no live-session marks, the resume pass launches one --resume tab for it', () => {
    reportFromTablessPane()
    expect(useAppStore.getState().liveAgentSessionKeys.size).toBe(0)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE)

    expect(launched).toBe(1)
    const tabs = useAppStore.getState().tabsByWorktree[WORKTREE] ?? []
    expect(tabs).toHaveLength(1)
    const startup = useAppStore.getState().pendingStartupByTabId[tabs[0]!.id]
    expect(startup?.command).toContain('--resume')
    expect(startup?.command).toContain(SESSION)
  })
})
