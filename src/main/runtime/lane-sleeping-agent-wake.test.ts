/**
 * S9 §2a — the wake's owner half, now that the resume loop lives beside the partition it pairs
 * with rather than in `orca-runtime.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  buildLaneWakeAgentSessionRequest,
  resumeLaneBoundSleepingRecords,
  withoutSleepingAgentRecord
} from './lane-sleeping-agent-wake'

const WORKTREE = 'w-1'

function record(paneKey: string, overrides: Partial<SleepingAgentSessionRecord> = {}) {
  return {
    paneKey,
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: { sessionId: `s-${paneKey}` },
    prompt: '',
    state: 'idle',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  } as SleepingAgentSessionRecord
}

describe('buildLaneWakeAgentSessionRequest', () => {
  it('asks the HOST create path for a background pane, by worktree id', () => {
    expect(buildLaneWakeAgentSessionRequest(record('p-1'), WORKTREE)).toEqual({
      kind: 'explicit',
      worktree: `id:${WORKTREE}`,
      agent: 'claude',
      providerSession: { sessionId: 's-p-1' },
      presentation: 'background'
    })
  })

  it('carries the launch config a record had', () => {
    const request = buildLaneWakeAgentSessionRequest(
      record('p-1', {
        launchConfig: { agentArgs: '--resume', ompResumeFilePath: '/tmp/omp.json' }
      }),
      WORKTREE
    )

    expect(request).toMatchObject({ agentArgs: '--resume', ompResumeFilePath: '/tmp/omp.json' })
  })
})

describe('resumeLaneBoundSleepingRecords', () => {
  function harness(resume: (request: RuntimeEnsureAgentSessionRequest) => Promise<unknown>) {
    const cleared: string[] = []
    let flushes = 0
    return {
      cleared,
      flushCount: () => flushes,
      deps: {
        resume,
        clearRecord: (paneKey: string) => cleared.push(paneKey),
        flush: async () => {
          flushes += 1
        }
      }
    }
  }

  it('clears each resumed record and flushes once', async () => {
    const h = harness(async () => undefined)

    const resumed = await resumeLaneBoundSleepingRecords(
      [record('p-1'), record('p-2')],
      WORKTREE,
      h.deps
    )

    expect(resumed).toBe(2)
    expect(h.cleared).toEqual(['p-1', 'p-2'])
    expect(h.flushCount()).toBe(1)
  })

  // One unresumable agent must not withhold the others, and its record stays asleep.
  it('leaves a failed record asleep and resumes the rest', async () => {
    const h = harness(async (request) => {
      if (request.kind === 'explicit' && request.providerSession.sessionId === 's-p-1') {
        throw new Error('spawn failed')
      }
      return undefined
    })

    const resumed = await resumeLaneBoundSleepingRecords(
      [record('p-1'), record('p-2')],
      WORKTREE,
      h.deps
    )

    expect(resumed).toBe(1)
    expect(h.cleared).toEqual(['p-2'])
  })

  it('does not flush when nothing resumed', async () => {
    const h = harness(async () => {
      throw new Error('spawn failed')
    })

    expect(await resumeLaneBoundSleepingRecords([record('p-1')], WORKTREE, h.deps)).toBe(0)
    expect(h.flushCount()).toBe(0)
  })
})

describe('withoutSleepingAgentRecord', () => {
  it('removes only the named pane', () => {
    const records = { 'p-1': record('p-1'), 'p-2': record('p-2') }

    expect(withoutSleepingAgentRecord(records, 'p-1', () => true)).toEqual({
      'p-2': records['p-2']
    })
  })

  // Negative control: a record naming another worktree is not this wake's to clear.
  it('answers null when the record belongs to another worktree, or does not exist', () => {
    const records = { 'p-1': record('p-1') }

    expect(withoutSleepingAgentRecord(records, 'p-1', () => false)).toBeNull()
    expect(withoutSleepingAgentRecord(records, 'p-9', () => true)).toBeNull()
    expect(withoutSleepingAgentRecord(undefined, 'p-1', () => true)).toBeNull()
  })
})
