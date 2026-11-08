import { describe, expect, it, vi } from 'vitest'
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
    machineId: HOST,
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
    // Never really wait out the settle window in a unit test; individual tests override to observe it.
    sleep: async () => {},
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

  // [S10-21f b2b-10q M2 follow-up] `same_generation_settling`'s operator-hint `detail`
  // (dead-holder-adoption.ts -> chair-restore.ts's ChairRestoreResult) must survive the executor's
  // narrowing into an `error` row, or the CLI (chairs.ts's formatRow) never sees it.
  const SETTLING_DETAIL =
    'the holder pane read absent just now; run `orca chairs restore` again in ≥10 s to confirm'
  it('a `same_generation_settling` refusal carries its operator-hint detail through to the error row', async () => {
    const { deps } = fakeDeps({
      requestChairRestore: async () => ({
        ok: false,
        reason: 'same_generation_settling',
        holderPaneKey: 'tab:x',
        detail: SETTLING_DETAIL
      })
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(summary.rows[0]).toMatchObject({
      name: 'a',
      kind: 'error',
      reason: 'same_generation_settling',
      detail: SETTLING_DETAIL
    })
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

  // [S10-21d b3b, D-R165 M1] the write-back must use the RECORDED id (what the admission
  // actually wrote), never the requested id blindly, or a mismatch would be pinned forever.
  it('writes back the RECORDED session id, not the requested one, when they diverge', async () => {
    const { deps } = fakeDeps({
      requestChairRestore: async (request) => {
        // admission actually recorded a DIFFERENT session than requested (a stale-generation race)
        const paneKey = `tab:${request.displayName}`
        return { ok: true, paneKey, agentId: 'agent-a', holderPaneKey: null, adoptionSignal: null }
      },
      newestLaunchForPane: () => ({ session_id: 'sess-actually-recorded' })
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-requested' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(m.chairs[0].lastSessionId).toBe('sess-actually-recorded')
    expect(summary.changed).toBe(true)
  })

  // [S10-21d b3b, D-R165 L5] no manifest rewrite is warranted when every write-back is a no-op.
  it('summary.changed stays false when skip_live is the only action (no write-back at all)', async () => {
    const { deps } = fakeDeps({
      getAgentByName: () => ({ pane_key: 'tab:a' }),
      paneHoldingSession: () => 'tab:a',
      isPaneLive: () => true,
      newestLaunchForPane: () => ({ session_id: 'sess-a' })
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(summary.changed).toBe(false)
  })

  // [S10-21d b3b, D-R165 M5] attested must read as unknown (null), never a silent false, when
  // the hook-report check itself is unwired — distinct from a wired check that answers false.
  it('attested is null (unknown) rather than false when the hook-report check is unwired', async () => {
    const { deps } = fakeDeps({
      getAgentByName: () => ({ pane_key: 'tab:a' }),
      paneHoldingSession: () => 'tab:a',
      isPaneLive: () => true,
      newestLaunchForPane: () => ({ session_id: 'sess-a' }),
      hasLiveHookReportOfSession: () => null
    })
    const m = manifest([
      { name: 'a', worktree: 'path:/repo/a', agent: 'claude', conversationId: 'sess-a' }
    ])
    const summary = await runChairsRestore(m, deps)
    expect(summary.rows[0]).toMatchObject({ attested: null })
  })

  // [S10-22a Wave 2 contract, D-R217] launchArgs threads verbatim from the manifest entry into
  // requestChairRestore's request.
  it('threads manifest launchArgs verbatim into requestChairRestore', async () => {
    const seen: (string[] | undefined)[] = []
    const { deps } = fakeDeps({
      requestChairRestore: async (request) => {
        seen.push(request.launchArgs)
        return {
          ok: true,
          paneKey: 'tab:a',
          agentId: 'agent-a',
          holderPaneKey: null,
          adoptionSignal: null
        }
      }
    })
    const m = manifest([
      {
        name: 'a',
        worktree: 'path:/repo/a',
        agent: 'claude',
        conversationId: 'sess-a',
        launchArgs: ['--autocompact', '200000']
      }
    ])
    await runChairsRestore(m, deps)
    expect(seen).toEqual([['--autocompact', '200000']])
  })

  describe('same_generation_settling wait-and-retry', () => {
    const settling: RequestChairRestoreOutcome = {
      ok: false,
      reason: 'same_generation_settling',
      holderPaneKey: 'tab:x',
      detail: 'settling'
    }
    const chair = (name: string): ChairsManifest['chairs'][number] => ({
      name,
      worktree: `path:/repo/${name}`,
      agent: 'claude',
      conversationId: `sess-${name}`
    })

    // E1
    it('waits once for the settle window, retries, and reports the chair ok', async () => {
      const sleeps: number[] = []
      const attempts: string[] = []
      const { deps } = fakeDeps({
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      })
      const inner = deps.requestChairRestore
      deps.requestChairRestore = async (request) => {
        attempts.push(request.displayName)
        return attempts.length === 1 ? settling : inner(request)
      }
      const summary = await runChairsRestore(manifest([chair('a')]), deps)
      expect(sleeps).toHaveLength(1)
      expect(sleeps[0]).toBeGreaterThanOrEqual(10_000)
      expect(sleeps[0]).toBeLessThanOrEqual(15_000)
      expect(attempts).toEqual(['a', 'a'])
      expect(summary.rows).toHaveLength(1)
      expect(summary.rows[0]).toMatchObject({ name: 'a', kind: 'launch', ok: true })
      expect(summary.exitNonZero).toBe(false)
    })

    // E2
    it('uses ONE wait for several settling chairs, retries each, and keeps plan order', async () => {
      const sleeps: number[] = []
      const attempts: string[] = []
      const seen = new Set<string>()
      const { deps } = fakeDeps({
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      })
      const inner = deps.requestChairRestore
      deps.requestChairRestore = async (request) => {
        attempts.push(request.displayName)
        // a and c settle on their first attempt; b succeeds straight away.
        if (request.displayName !== 'b' && !seen.has(request.displayName)) {
          seen.add(request.displayName)
          return settling
        }
        return inner(request)
      }
      const summary = await runChairsRestore(manifest([chair('a'), chair('b'), chair('c')]), deps)
      expect(sleeps).toHaveLength(1)
      expect(attempts).toEqual(['a', 'b', 'c', 'a', 'c'])
      expect(summary.rows.map((row) => row.name)).toEqual(['a', 'b', 'c'])
      expect(summary.rows.every((row) => row.ok)).toBe(true)
      expect(summary.exitNonZero).toBe(false)
    })

    // E3
    it('reports an error row after a second settling refusal, with exactly two attempts', async () => {
      const attempts: string[] = []
      const { deps } = fakeDeps({
        requestChairRestore: async (request) => {
          attempts.push(request.displayName)
          return settling
        }
      })
      const summary = await runChairsRestore(manifest([chair('a')]), deps)
      expect(attempts).toEqual(['a', 'a'])
      expect(summary.rows).toHaveLength(1)
      expect(summary.rows[0]).toMatchObject({
        name: 'a',
        kind: 'error',
        reason: 'same_generation_settling',
        ok: false
      })
      expect(summary.exitNonZero).toBe(true)
    })

    // E4 (control)
    it.each([
      [
        'current_generation',
        { ok: false, reason: 'current_generation', holderPaneKey: 'tab:x' } as const
      ],
      [
        'restore_target_live_elsewhere',
        { ok: false, reason: 'restore_target_live_elsewhere', holderPaneKey: 'tab:x' } as const
      ]
    ])('never waits or retries a %s refusal', async (reason, outcome) => {
      const sleeps: number[] = []
      const attempts: string[] = []
      const { deps } = fakeDeps({
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        requestChairRestore: async (request) => {
          attempts.push(request.displayName)
          return outcome
        }
      })
      const summary = await runChairsRestore(manifest([chair('a')]), deps)
      expect(sleeps).toEqual([])
      expect(attempts).toEqual(['a'])
      expect(summary.rows[0]).toMatchObject({ kind: 'error', reason, ok: false })
      expect(summary.exitNonZero).toBe(true)
    })

    // E5
    it('publishes marks and materializes panes once, after every requestChairRestore', async () => {
      const order: string[] = []
      const { deps } = fakeDeps({
        publishLiveAgentSessionMarks: async () => {
          order.push('publish')
        },
        materializeRestoredPanes: async () => {
          order.push('materialize')
        }
      })
      const inner = deps.requestChairRestore
      deps.requestChairRestore = async (request) => {
        order.push(`restore:${request.displayName}`)
        return inner(request)
      }
      await runChairsRestore(manifest([chair('a'), chair('b')]), deps)
      // Post-run work is fire-and-forget, so it lands a few microtasks after the summary returns.
      await vi.waitFor(() => expect(order).toHaveLength(4))
      expect(order.slice(0, 2)).toEqual(['restore:a', 'restore:b'])
      expect(order.slice(2).sort()).toEqual(['materialize', 'publish'])
    })

    it('publishes and materializes nothing when no chair was restored', async () => {
      const calls: string[] = []
      const { deps } = fakeDeps({
        requestChairRestore: async () => ({
          ok: false,
          reason: 'restore_target_live_elsewhere',
          holderPaneKey: 'tab:x'
        }),
        publishLiveAgentSessionMarks: async () => {
          calls.push('publish')
        },
        materializeRestoredPanes: async () => {
          calls.push('materialize')
        }
      })
      await runChairsRestore(manifest([chair('a')]), deps)
      expect(calls).toEqual([])
    })

    it('a throwing publish or materialize never fails the restore', async () => {
      const { deps } = fakeDeps({
        publishLiveAgentSessionMarks: async () => {
          throw new Error('publish boom')
        },
        materializeRestoredPanes: async () => {
          throw new Error('materialize boom')
        }
      })
      const summary = await runChairsRestore(manifest([chair('a')]), deps)
      expect(summary.exitNonZero).toBe(false)
    })

    it('a dep that throws synchronously never fails the restore and still lets the other run', async () => {
      const calls: string[] = []
      const { deps } = fakeDeps({
        publishLiveAgentSessionMarks: () => {
          throw new Error('sync publish boom')
        },
        materializeRestoredPanes: async () => {
          calls.push('materialize')
        }
      })
      const summary = await runChairsRestore(manifest([chair('a')]), deps)
      expect(summary.exitNonZero).toBe(false)
      await vi.waitFor(() => expect(calls).toEqual(['materialize']))
    })
  })
})
