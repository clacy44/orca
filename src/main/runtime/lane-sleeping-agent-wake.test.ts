/**
 * S9 §2a — the wake's owner half, now that the resume loop lives beside the partition it pairs
 * with rather than in `orca-runtime.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  buildLaneWakeAgentSessionRequest,
  partitionLaneBoundSleepingRecords,
  resumeLaneBoundSleepingRecords,
  withoutSleepingAgentRecord
} from './lane-sleeping-agent-wake'

const WORKTREE = 'w-1'

function record(paneKey: string, overrides: Partial<SleepingAgentSessionRecord> = {}) {
  return {
    paneKey,
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `s-${paneKey}` },
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
      providerSession: { key: 'session_id', id: 's-p-1' },
      presentation: 'background'
    })
  })

  it('carries the launch config a record had', () => {
    const request = buildLaneWakeAgentSessionRequest(
      record('p-1', {
        launchConfig: { agentArgs: '--resume', agentEnv: {}, ompResumeFilePath: '/tmp/omp.json' }
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
      if (request.kind === 'explicit' && request.providerSession.id === 's-p-1') {
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

/**
 * S9 §2a blocker 2 — the partition decides whether the HOST resumes a lane record, so it compares
 * worktree ids the way the runtime does. A Windows id spelled with the other separator, or with a
 * trailing slash, names the same workspace: missed here, the record falls through to the renderer
 * wake and comes back as an unbound pane on the shared credential.
 */
describe('partitionLaneBoundSleepingRecords', () => {
  const PRINCIPAL = 'principal-1'
  const STORED = 'repo-1::C:\\dev\\wt'
  const REQUESTED = 'repo-1::C:/dev/wt/'

  const laneOf = (): { kind: 'principal'; principalId: string } => ({
    kind: 'principal',
    principalId: PRINCIPAL
  })

  it('withholds and owns a record whose id differs only in path spelling', () => {
    const stored = record('p-1', { worktreeId: STORED })

    const partition = partitionLaneBoundSleepingRecords({
      records: { 'p-1': stored },
      worktreeId: REQUESTED,
      laneOf,
      callerPrincipalId: PRINCIPAL
    })

    expect(partition.withheldPaneKeys).toEqual(['p-1'])
    expect(partition.ownedRecords).toEqual([stored])
  })

  // Negative control: a genuinely different workspace is still skipped, spelling or not.
  it('skips a record from another worktree', () => {
    const partition = partitionLaneBoundSleepingRecords({
      records: { 'p-2': record('p-2', { worktreeId: 'repo-1::C:/dev/other' }) },
      worktreeId: REQUESTED,
      laneOf,
      callerPrincipalId: PRINCIPAL
    })

    expect(partition).toEqual({ withheldPaneKeys: [], ownedRecords: [], refusedForeign: false })
  })

  // Negative control: matching the worktree does not grant ownership of someone else's lane.
  it('withholds a foreign lane record without resuming it', () => {
    const partition = partitionLaneBoundSleepingRecords({
      records: { 'p-3': record('p-3', { worktreeId: STORED }) },
      worktreeId: REQUESTED,
      laneOf,
      callerPrincipalId: 'principal-2'
    })

    expect(partition.withheldPaneKeys).toEqual(['p-3'])
    expect(partition.ownedRecords).toEqual([])
    expect(partition.refusedForeign).toBe(true)
  })
})
