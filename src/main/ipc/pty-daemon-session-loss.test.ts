// R315 (T3): main's handler for ptys that died with the daemon. Audit rows first, then a plan read
// while the runtime still knows the ptys, then main-side exit semantics WITHOUT a renderer
// `pty:exit`, then one boolean-only notice to the window. Chair verdicts come from real host
// facts (a real in-memory directory + a real chairs manifest on a temp HOME).
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import type Database from '../sqlite/sync-database'
import type { DaemonLossRecoveryPlanEntry } from '../runtime/orchestration/daemon-loss-chair-verdict'
import type { DaemonSessionsLostRendererPayload } from './pty-daemon-session-loss'

const SEED = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = '33333333-3333-4333-8333-333333333333'
const FRESH_SESSION = '44444444-4444-4444-8444-444444444444'
const leaf = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const PANE_CHAIR_BY_NAME = `tab-1:${leaf(1)}`
const PANE_CHAIR_BY_SESSION = `tab-2:${leaf(2)}`
const PANE_WORKER = `tab-3:${leaf(3)}`
const PANE_DERIVED = `tab-4:${leaf(4)}`
const PANE_PEER = `tab-5:${leaf(5)}`

let home: string
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home }
})

const { OrchestrationDb } = await import('../runtime/orchestration/db')
const { upsertAgentByPaneSuffix } = await import('../runtime/orchestration/agent-directory')
const { recordLaunch, recordSelfReportRotation } =
  await import('../runtime/orchestration/agent-launch-sessions')
const { planDaemonLossRecovery } =
  await import('../runtime/orchestration/daemon-loss-chair-verdict')
const { readHostScopedManifestChairs } =
  await import('../runtime/orchestration/chair-succession-manifest-entry')
const { createDaemonSessionLossHandler } = await import('./pty-daemon-session-loss')

let orchestrationDb: InstanceType<typeof OrchestrationDb> | undefined
const rawDb = (): Database.Database => (orchestrationDb as unknown as { db: Database.Database }).db

function register(paneKey: string, displayName: string): void {
  upsertAgentByPaneSuffix(rawDb(), {
    displayName,
    role: null,
    hostId: 'local',
    paneKey,
    terminalHandle: `term_${displayName}`,
    processIncarnation: 'inc1',
    worktreeId: 'wt1',
    worktreePath: '/wt',
    branch: 'b',
    title: null,
    agentLabel: 'Claude Code',
    originHandle: `term_${displayName}`,
    originHostId: 'local'
  })
}

function launchRow(paneKey: string, sessionId: string): void {
  expect(
    recordLaunch(rawDb(), {
      hostId: 'local',
      paneKey,
      agentType: 'claude',
      sessionId,
      launchGeneration: `gen-${paneKey}`,
      executionHostId: 'local',
      evidence: 'host_launch'
    }).ok
  ).toBe(true)
}

function insertDerivedRow(paneKey: string): void {
  rawDb()
    .prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         origin_kind, origin_pane_key, origin_handle, origin_host_id
       ) VALUES ('agt_derived', 'alpha', NULL, 'local', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         'live', 1, 0, 'derived', ?, NULL, 'local')`
    )
    .run(paneKey, paneKey)
}

async function writeManifest(chairs: unknown): Promise<void> {
  await mkdir(join(home, '.orca'), { recursive: true })
  await writeFile(join(home, '.orca', 'chairs.json'), JSON.stringify({ version: 1, chairs }))
}
const chair = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  conversationId: SEED,
  worktree: '/work',
  agent: 'claude',
  ...extra
})

/** The plan builder runtime.planDaemonLossRecovery delegates to, over real facts. */
function realPlanner(opts: { peerOwned?: string[] } = {}) {
  const paneByPty: Record<string, string> = {
    'pty-name': PANE_CHAIR_BY_NAME,
    'pty-session': PANE_CHAIR_BY_SESSION,
    'pty-worker': PANE_WORKER,
    'pty-derived': PANE_DERIVED,
    'pty-peer': PANE_PEER
  }
  return async (sessions: readonly { id: string }[]): Promise<DaemonLossRecoveryPlanEntry[]> =>
    planDaemonLossRecovery({
      db: orchestrationDb!,
      hostId: 'local',
      hostScopedChairs: await readHostScopedManifestChairs(),
      sessions,
      paneKeyOf: (id) => paneByPty[id] ?? null,
      isPeerOwned: (id) => opts.peerOwned?.includes(id) ?? false
    })
}

type Harness = ReturnType<typeof buildHarness>
function buildHarness(
  planRecovery: (
    s: readonly { id: string; incarnationId?: string }[]
  ) => Promise<DaemonLossRecoveryPlanEntry[]>,
  extra: {
    windowAvailable?: boolean
    current?: (id: string) => boolean
    sendThrows?: boolean
    inFlight?: (id: string) => boolean
  } = {}
) {
  const order: string[] = []
  const sent: DaemonSessionsLostRendererPayload[] = []
  const applied: { id: string; code: number; incarnationId?: string }[] = []
  const breadcrumbs: { name: string; data: Record<string, unknown> }[] = []
  const handle = createDaemonSessionLossHandler({
    isCurrentPtyExit: ({ id }) => extra.current?.(id) ?? true,
    isSpawnInFlight: (id) => extra.inFlight?.(id) ?? false,
    notifyDaemonDiedFanout: (ids) => order.push(`audit:${ids.join(',')}`),
    planRecovery: async (sessions) => {
      order.push('plan')
      return planRecovery(sessions)
    },
    applyProviderPtyExitState: (payload) => {
      order.push(`exit:${payload.id}`)
      applied.push(payload)
    },
    sendToRenderer: (payload) => {
      order.push('send')
      if (extra.sendThrows) {
        throw new Error('window gone')
      }
      if (extra.windowAvailable === false) {
        return false
      }
      sent.push(payload)
      return true
    },
    recordBreadcrumb: (name, data) => breadcrumbs.push({ name, data })
  })
  return { handle, order, sent, applied, breadcrumbs }
}

const LOST_ALL = {
  epoch: 7,
  sessions: [
    { id: 'pty-name', incarnationId: 'i1' },
    { id: 'pty-session', incarnationId: 'i2' },
    { id: 'pty-worker', incarnationId: 'i3' },
    { id: 'pty-derived', incarnationId: 'i4' },
    { id: 'pty-peer', incarnationId: 'i5' }
  ]
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pty-daemon-session-loss-'))
  orchestrationDb = new OrchestrationDb(':memory:')
})
afterEach(async () => {
  orchestrationDb?.close()
  orchestrationDb = undefined
  await rm(home, { recursive: true, force: true })
})

describe('daemon-session-loss handler: ordering and exit semantics', () => {
  it('writes the daemon_died audit rows, reads the plan, sends to the window, and only then applies exits', async () => {
    const h: Harness = buildHarness(async (sessions) =>
      sessions.map(({ id }) => ({ id, paneKey: `t:${id}`, peerOwned: false, reanchor: false }))
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'a' }, { id: 'b' }] })

    expect(h.order).toEqual(['audit:a,b', 'plan', 'send', 'exit:a', 'exit:b'])
  })

  it('applies the main-side exit helper per id with the daemon-death exit code and its incarnation', async () => {
    const h = buildHarness(async (sessions) =>
      sessions.map(({ id }) => ({ id, paneKey: null, peerOwned: false, reanchor: false }))
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'a', incarnationId: 'inc-a' }, { id: 'b' }] })

    expect(h.applied).toEqual([
      { id: 'a', code: -1, incarnationId: 'inc-a' },
      { id: 'b', code: -1 }
    ])
  })

  it('excludes a peer-owned pane from the notice but still applies its exit semantics', async () => {
    const h = buildHarness(async () => [
      { id: 'a', paneKey: 'tab:a', peerOwned: true, reanchor: false },
      { id: 'b', paneKey: 'tab:b', peerOwned: false, reanchor: false }
    ])
    await h.handle({ epoch: 3, sessions: [{ id: 'a' }, { id: 'b' }] })

    expect(h.applied.map((p) => p.id)).toEqual(['a', 'b'])
    expect(h.sent).toEqual([
      { epoch: 3, sessions: [{ id: 'b', paneKey: 'tab:b', reanchor: false }] }
    ])
  })

  it('sends nothing (but still audits and applies exits) when there is no window', async () => {
    const h = buildHarness(
      async (sessions) =>
        sessions.map(({ id }) => ({ id, paneKey: `t:${id}`, peerOwned: false, reanchor: false })),
      { windowAvailable: false }
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'a' }] })

    expect(h.sent).toEqual([])
    expect(h.order).toEqual(['audit:a', 'plan', 'send', 'exit:a'])
    expect(h.breadcrumbs).toEqual([
      { name: 'daemon_sessions_lost', data: { count: 1, applied: 1, notified: false } }
    ])
  })

  it('ignores a pty id the runtime already moved to a newer incarnation', async () => {
    const h = buildHarness(
      async (sessions) =>
        sessions.map(({ id }) => ({ id, paneKey: `t:${id}`, peerOwned: false, reanchor: false })),
      { current: (id) => id !== 'respawned' }
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'respawned' }, { id: 'lost' }] })

    expect(h.order).toEqual(['audit:lost', 'plan', 'send', 'exit:lost'])
    expect(h.sent[0]?.sessions.map((s) => s.id)).toEqual(['lost'])
  })

  it('audits an id whose same-id relaunch spawn is in flight, but neither notifies nor exits it', async () => {
    const h = buildHarness(
      async (sessions) =>
        sessions.map(({ id }) => ({ id, paneKey: `t:${id}`, peerOwned: false, reanchor: false })),
      { inFlight: (id) => id === 'b' }
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'a' }, { id: 'b' }] })

    expect(h.order).toEqual(['audit:a,b', 'plan', 'send', 'exit:a'])
    expect(h.applied.map((p) => p.id)).toEqual(['a'])
    expect(h.sent[0]?.sessions.map((session) => session.id)).toEqual(['a'])
    expect(h.breadcrumbs).toEqual([
      {
        name: 'daemon_sessions_lost',
        data: { count: 2, applied: 1, notified: true, inFlight: 1 }
      }
    ])
  })

  it('changes nothing but records a stale-only breadcrumb when every lost id is already stale', async () => {
    const h = buildHarness(async () => [], { current: () => false })
    await h.handle({ epoch: 1, sessions: [{ id: 'x' }] })

    expect(h.order).toEqual([])
    expect(h.breadcrumbs).toEqual([
      { name: 'daemon_sessions_lost', data: { count: 0, applied: 0, notified: false, stale: 1 } }
    ])
  })

  it('still applies exit semantics but notifies nobody when planning fails', async () => {
    const h = buildHarness(async () => {
      throw new Error('directory unavailable')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await h.handle({ epoch: 1, sessions: [{ id: 'a' }] })

    expect(h.order).toEqual(['audit:a', 'plan', 'exit:a'])
    expect(h.sent).toEqual([])
  })

  it('still applies every exit, with notified:false, when the window send throws', async () => {
    const h = buildHarness(
      async (sessions) =>
        sessions.map(({ id }) => ({ id, paneKey: `t:${id}`, peerOwned: false, reanchor: false })),
      { sendThrows: true }
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'a' }, { id: 'b' }] })

    expect(h.order).toEqual(['audit:a,b', 'plan', 'send', 'exit:a', 'exit:b'])
    expect(h.breadcrumbs).toEqual([
      { name: 'daemon_sessions_lost', data: { count: 2, applied: 2, notified: false } }
    ])
  })

  it('records a daemon_sessions_lost breadcrumb with the count and the time since disconnect', async () => {
    const h = buildHarness(async (sessions) =>
      sessions.map(({ id }) => ({ id, paneKey: `t:${id}`, peerOwned: false, reanchor: false }))
    )
    await h.handle({ epoch: 1, sessions: [{ id: 'a' }, { id: 'b' }], sinceDisconnectMs: 840 })

    expect(h.breadcrumbs).toEqual([
      {
        name: 'daemon_sessions_lost',
        data: { count: 2, applied: 2, notified: true, sinceDisconnectMs: 840 }
      }
    ])
  })
})

describe('daemon-session-loss handler: chair verdict from real host facts', () => {
  async function reanchorByPty(
    opts: { peerOwned?: string[] } = {}
  ): Promise<Record<string, boolean>> {
    const h = buildHarness(realPlanner(opts))
    await h.handle(LOST_ALL)
    return Object.fromEntries(
      (h.sent[0]?.sessions ?? []).map((session) => [session.id, session.reanchor])
    )
  }

  it('is true for a manifest chair matched by its resumable session, whatever the pane is named', async () => {
    register(PANE_CHAIR_BY_SESSION, 'someone-else')
    launchRow(PANE_CHAIR_BY_SESSION, SEED)
    await writeManifest([chair('alpha', { conversationId: OTHER_SESSION }), chair('beta')])

    expect((await reanchorByPty())['pty-session']).toBe(true)
  })

  it("DN: a pane that merely holds a chair's free name is not a chair (no lineage launch row)", async () => {
    register(PANE_CHAIR_BY_NAME, 'alpha')
    launchRow(PANE_CHAIR_BY_NAME, FRESH_SESSION)
    await writeManifest([chair('alpha')])

    expect((await reanchorByPty())['pty-name']).toBe(false)
  })

  it("DN: a pane with no launch row at all is not a chair, even under the chair's name", async () => {
    register(PANE_CHAIR_BY_NAME, 'alpha')
    await writeManifest([chair('alpha')])

    expect((await reanchorByPty())['pty-name']).toBe(false)
  })

  it('DN: one in-place session rotation keeps the chair lineage (previous_session_id)', async () => {
    register(PANE_CHAIR_BY_NAME, 'someone-else')
    launchRow(PANE_CHAIR_BY_NAME, SEED)
    const rotated = recordSelfReportRotation(rawDb(), {
      hostId: 'local',
      paneKey: PANE_CHAIR_BY_NAME,
      previousSessionId: SEED,
      sessionId: FRESH_SESSION,
      launchGeneration: 'gen-rot',
      executionHostId: 'local',
      evidence: 'self_report_rotation'
    })
    expect(rotated.ok).toBe(true)
    await writeManifest([chair('alpha')])

    expect((await reanchorByPty())['pty-name']).toBe(true)
  })

  it('is false for a registered non-chair, a derived row and a pane with no row', async () => {
    register(PANE_WORKER, 'worker')
    launchRow(PANE_WORKER, OTHER_SESSION)
    insertDerivedRow(PANE_DERIVED)
    await writeManifest([chair('alpha')])

    const reanchor = await reanchorByPty()

    expect(reanchor['pty-worker']).toBe(false)
    expect(reanchor['pty-derived']).toBe(false)
  })

  it('is false when the matching manifest entry belongs to another host', async () => {
    register(PANE_CHAIR_BY_NAME, 'alpha')
    launchRow(PANE_CHAIR_BY_NAME, SEED)
    await writeManifest([chair('alpha', { host: `${hostname()}-elsewhere` })])

    expect((await reanchorByPty())['pty-name']).toBe(false)
  })

  it('is true when the manifest entry names this host', async () => {
    register(PANE_CHAIR_BY_NAME, 'alpha')
    launchRow(PANE_CHAIR_BY_NAME, SEED)
    await writeManifest([chair('alpha', { host: hostname() })])

    expect((await reanchorByPty())['pty-name']).toBe(true)
  })

  it('is false for everything when the manifest is unreadable or invalid', async () => {
    register(PANE_CHAIR_BY_NAME, 'alpha')
    launchRow(PANE_CHAIR_BY_NAME, SEED)
    expect((await reanchorByPty())['pty-name']).toBe(false)
    await mkdir(join(home, '.orca'), { recursive: true })
    await writeFile(join(home, '.orca', 'chairs.json'), '{broken')
    expect((await reanchorByPty())['pty-name']).toBe(false)
  })

  it('never recovers a peer-owned pane, even a manifest chair', async () => {
    register(PANE_PEER, 'alpha')
    await writeManifest([chair('alpha')])

    const reanchor = await reanchorByPty({ peerOwned: ['pty-peer'] })

    expect(reanchor).not.toHaveProperty('pty-peer')
  })

  it('treats a tombstoned registered row as not a chair', async () => {
    register(PANE_CHAIR_BY_NAME, 'alpha')
    launchRow(PANE_CHAIR_BY_NAME, SEED)
    rawDb()
      .prepare(`UPDATE agents SET tombstoned_at = '2026-01-01T00:00:00Z' WHERE pane_key = ?`)
      .run(PANE_CHAIR_BY_NAME)
    await writeManifest([chair('alpha')])

    expect((await reanchorByPty())['pty-name']).toBe(false)
  })
})
