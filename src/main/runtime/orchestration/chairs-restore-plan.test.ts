import { describe, expect, it } from 'vitest'
import { planChairsRestore, type ChairPlanLookup } from './chairs-restore-plan'
import type { ChairsManifest } from './chairs-manifest'

const HOST = 'local'

function manifest(chairs: ChairsManifest['chairs']): ChairsManifest {
  return { version: 1, chairs }
}

describe('planChairsRestore', () => {
  it('live -> skip_live: the chair row is live and its pane resolves', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      [
        'a',
        {
          ownRow: { paneKey: 'tab:leaf-1', isLive: true },
          holder: { paneKey: 'tab:leaf-1', isLive: true }
        }
      ]
    ])
    const plan = planChairsRestore(m, HOST, lookups)
    expect(plan.actions).toEqual([
      { name: 'a', kind: 'skip_live', reason: expect.any(String), paneKey: 'tab:leaf-1' }
    ])
  })

  it('dead -> rebind: the row exists but the pane does not resolve live', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      [
        'a',
        {
          ownRow: { paneKey: 'tab:leaf-1', isLive: false },
          holder: { paneKey: null, isLive: false }
        }
      ]
    ])
    const plan = planChairsRestore(m, HOST, lookups)
    expect(plan.actions).toEqual([
      {
        name: 'a',
        kind: 'rebind',
        reason: expect.any(String),
        sessionId: 'sess-1',
        holderPaneKey: 'tab:leaf-1'
      }
    ])
  })

  it('absent -> launch: no registered row for this chair name on this host', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      ['a', { ownRow: null, holder: { paneKey: null, isLive: false } }]
    ])
    const plan = planChairsRestore(m, HOST, lookups)
    expect(plan.actions).toEqual([
      { name: 'a', kind: 'launch', reason: expect.any(String), sessionId: 'sess-1' }
    ])
  })

  it('uses lastSessionId over conversationId as the launch target when present', () => {
    const m = manifest([
      {
        name: 'a',
        worktree: 'path:/repo',
        agent: 'claude',
        conversationId: 'sess-seed',
        lastSessionId: 'sess-head'
      }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      ['a', { ownRow: null, holder: { paneKey: null, isLive: false } }]
    ])
    const plan = planChairsRestore(m, HOST, lookups)
    expect(plan.actions[0]).toMatchObject({ kind: 'launch', sessionId: 'sess-head' })
  })

  it('live-elsewhere -> refuse: the target session is held live by a DIFFERENT pane than the chair own row', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      [
        'a',
        {
          ownRow: { paneKey: 'tab:leaf-own', isLive: false },
          holder: { paneKey: 'tab:leaf-other', isLive: true }
        }
      ]
    ])
    const plan = planChairsRestore(m, HOST, lookups)
    expect(plan.actions).toEqual([
      {
        name: 'a',
        kind: 'refuse',
        reason: expect.any(String),
        holderPaneKey: 'tab:leaf-other'
      }
    ])
  })

  it('foreign host -> remote: never enters actions, never touched locally', () => {
    const m = manifest([
      {
        name: 'a',
        worktree: 'path:/repo',
        agent: 'claude',
        conversationId: 'sess-1',
        host: 'other-host'
      }
    ])
    const plan = planChairsRestore(m, HOST, new Map())
    expect(plan.actions).toEqual([])
    expect(plan.remote).toEqual([{ name: 'a', host: 'other-host' }])
  })

  it('--only filters which local chairs get planned at all', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' },
      { name: 'b', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-2' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      ['a', { ownRow: null, holder: { paneKey: null, isLive: false } }],
      ['b', { ownRow: null, holder: { paneKey: null, isLive: false } }]
    ])
    const plan = planChairsRestore(m, HOST, lookups, new Set(['a']))
    expect(plan.actions.map((a) => a.name)).toEqual(['a'])
  })

  it('throws rather than silently mis-plan when a lookup is missing for a local chair', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    expect(() => planChairsRestore(m, HOST, new Map())).toThrow()
  })

  // [S10-21d b3b, D-R165 H1] the caller passes a machine-distinct id (os.hostname()), never the
  // orchestration-compatibility constant — two different hostname strings classify correctly.
  it('classifies foreign vs local by whatever machine-distinct id the caller passes in', () => {
    const m = manifest([
      {
        name: 'a',
        worktree: 'path:/repo',
        agent: 'claude',
        conversationId: 'sess-1',
        host: 'desktop'
      },
      { name: 'b', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-2', host: 'vps' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      ['b', { ownRow: null, holder: { paneKey: null, isLive: false } }]
    ])
    const plan = planChairsRestore(m, 'vps', lookups)
    expect(plan.remote).toEqual([{ name: 'a', host: 'desktop' }])
    expect(plan.actions.map((a) => a.name)).toEqual(['b'])
  })

  // [S10-21d b3b, D-R165 L1] a live own-pane that is NOT the holder of the target session is
  // running something else — the skip_live reason must say so, not read as an unqualified skip.
  it('skip_live reason flags when the live pane is running a DIFFERENT session than the target', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      [
        'a',
        {
          ownRow: { paneKey: 'tab:leaf-1', isLive: true },
          holder: { paneKey: 'tab:leaf-other', isLive: true }
        }
      ]
    ])
    const plan = planChairsRestore(m, HOST, lookups)
    expect(plan.actions[0]).toMatchObject({
      kind: 'skip_live',
      reason: expect.stringContaining('running a different session')
    })
  })

  // [S10-21d b3b, D-R165 L2] an `only` name absent from the manifest previously vanished
  // silently (the loop simply never visits it) — refuse loudly instead.
  it('throws when --only names a chair absent from the manifest', () => {
    const m = manifest([
      { name: 'a', worktree: 'path:/repo', agent: 'claude', conversationId: 'sess-1' }
    ])
    const lookups = new Map<string, ChairPlanLookup>([
      ['a', { ownRow: null, holder: { paneKey: null, isLive: false } }]
    ])
    expect(() => planChairsRestore(m, HOST, lookups, new Set(['nope']))).toThrow(/unknown chair/)
  })
})
