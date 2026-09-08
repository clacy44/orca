import { describe, expect, it } from 'vitest'
import {
  executeChairsRestorePlan,
  gatherChairsRestoreLookups,
  runChairsRestore,
  type ChairsRestoreExecutorDeps,
  type RequestChairRestoreOutcome
} from './chairs-restore-execute'
import { planChairsRestore } from './chairs-restore-plan'
import type { ChairsManifest } from './chairs-manifest'

const HOST = 'local'

function fakeDeps(overrides: Partial<ChairsRestoreExecutorDeps> = {}): {
  deps: ChairsRestoreExecutorDeps
  calls: string[]
} {
  const calls: string[] = []
  const launches = new Map<string, string>() // paneKey -> session_id
  const livePanes = new Set<string>()
  const deps: ChairsRestoreExecutorDeps = {
    hostId: HOST,
    getAgentByName: () => undefined,
    paneHoldingSession: () => undefined,
    newestLaunchForPane: (_h, paneKey) => {
      const sessionId = launches.get(paneKey)
      return sessionId ? { session_id: sessionId } : undefined
    },
    isPaneLive: (paneKey) => livePanes.has(paneKey),
    requestChairRestore: async (request) => {
      calls.push(request.displayName)
      const paneKey = `tab:${request.displayName}`
      launches.set(paneKey, request.sessionId)
      livePanes.add(paneKey)
      const outcome: RequestChairRestoreOutcome = {
        ok: true,
        paneKey,
        agentId: `agent-${request.displayName}`,
        holderPaneKey: null,
        adoptionSignal: null
      }
      return outcome
    },
    hasLiveHookReportOfSession: () => true,
    hasResumableTranscriptTurn: async () => true,
    ...overrides
  }
  return { deps, calls }
}

function manifest(chairs: ChairsManifest['chairs']): ChairsManifest {
  return { version: 1, chairs }
}

describe('executeChairsRestorePlan', () => {
  it('calls requestChairRestore in plan ORDER for launch/rebind, writes lastSessionId back, and marks ok', async () => {
    const { deps, calls } = fakeDeps()
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' },
      { name: 'b', worktree: 'path:/repo/b', agent: 'claude', conversationId: 'sess-b' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(calls).toEqual(['a', 'b'])
    expect(m.chairs[0].lastSessionId).toBe('sess-a')
    expect(m.chairs[1].lastSessionId).toBe('sess-b')
    expect(summary.exitNonZero).toBe(false)
    expect(summary.rows.every((r) => r.ok)).toBe(true)
  })

  it('a failed requestChairRestore produces an error row and a non-zero summary, without aborting the remaining actions', async () => {
    const { deps, calls } = fakeDeps({
      isPaneLive: (paneKey) => paneKey === 'tab:b',
      newestLaunchForPane: (_h, paneKey) =>
        paneKey === 'tab:b' ? { session_id: 'sess-b' } : undefined,
      requestChairRestore: async (request) => {
        calls.push(request.displayName)
        if (request.displayName === 'a') {
          return { ok: false, reason: 'restore_target_live_elsewhere', holderPaneKey: 'tab:x' }
        }
        return {
          ok: true,
          paneKey: 'tab:b',
          agentId: 'agent-b',
          holderPaneKey: null,
          adoptionSignal: null
        }
      }
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' },
      { name: 'b', worktree: 'path:/repo/b', agent: 'claude', conversationId: 'sess-b' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(calls).toEqual(['a', 'b'])
    expect(summary.exitNonZero).toBe(true)
    expect(summary.rows[0]).toMatchObject({ name: 'a', kind: 'error', ok: false })
    expect(summary.rows[1]).toMatchObject({ name: 'b', kind: 'launch', ok: true })
    // The failed chair's lastSessionId is never written back.
    expect(m.chairs[0].lastSessionId).toBeUndefined()
  })

  it('a refuse action never calls requestChairRestore and marks the summary non-zero', async () => {
    const { deps, calls } = fakeDeps({
      getAgentByName: () => ({ pane_key: 'tab:a-own' }),
      paneHoldingSession: () => 'tab:a-live-elsewhere',
      isPaneLive: (paneKey) => paneKey === 'tab:a-live-elsewhere'
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(calls).toEqual([])
    expect(summary.exitNonZero).toBe(true)
    expect(summary.rows).toEqual([
      {
        name: 'a',
        kind: 'refuse',
        reason: expect.any(String),
        holderPaneKey: 'tab:a-live-elsewhere',
        ok: false
      }
    ])
  })

  it('skip_live builds a verification row without calling requestChairRestore, and flags inequality as SHORT', async () => {
    const { deps, calls } = fakeDeps({
      getAgentByName: () => ({ pane_key: 'tab:a' }),
      paneHoldingSession: () => 'tab:a',
      isPaneLive: () => true,
      newestLaunchForPane: () => ({ session_id: 'stale-session' })
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(calls).toEqual([])
    expect(summary.rows).toHaveLength(1)
    const row = summary.rows[0]
    expect(row).toMatchObject({
      name: 'a',
      kind: 'skip_live',
      recorded: 'stale-session',
      minted: 'sess-a'
    })
    if (row.kind !== 'refuse' && row.kind !== 'error') {
      expect(row.ok).toBe(false)
    }
    expect(summary.exitNonZero).toBe(true)
  })

  it('gatherChairsRestoreLookups skips entries whose host differs from the local host', () => {
    const { deps } = fakeDeps()
    const m = manifest([
      {
        name: 'a',
        worktree: 'path:/repo/a',
        agent: 'claude',
        conversationId: 'sess-a',
        host: 'other-host'
      }
    ])
    const lookups = gatherChairsRestoreLookups(m, deps)
    expect(lookups.size).toBe(0)
  })

  it('--only limits execution to the named chairs (executeChairsRestorePlan honours whatever the plan already filtered)', async () => {
    const { deps, calls } = fakeDeps()
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' },
      { name: 'b', worktree: 'path:/repo/b', agent: 'claude', conversationId: 'sess-b' }
    ])
    const lookups = gatherChairsRestoreLookups(m, deps)
    const plan = planChairsRestore(m, HOST, lookups, new Set(['b']))
    await executeChairsRestorePlan(m, plan, deps)
    expect(calls).toEqual(['b'])
  })
})
