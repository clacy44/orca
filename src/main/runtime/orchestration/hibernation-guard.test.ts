// R316 (T14): which panes the host protects from agent-sleep. A registered (non-derived) row and
// a host-scoped manifest chair's session both protect their pane; a derived row and another
// host's manifest entry do not.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import type Database from '../../sqlite/sync-database'
import type { BackgroundWorkVerdict } from '../../../shared/hibernation-guard-types'

const SEED = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = '33333333-3333-4333-8333-333333333333'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LEAF_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_A = `tab-a:${LEAF_A}`
const PANE_B = `tab-b:${LEAF_B}`
const PANE_C = `tab-c:${LEAF_C}`

let home: string
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home }
})

const { OrchestrationDb } = await import('./db')
const { upsertAgentByPaneSuffix } = await import('./agent-directory')
const { recordLaunch } = await import('./agent-launch-sessions')
const { computeHibernationGuard } = await import('./hibernation-guard')

let orchestrationDb: InstanceType<typeof OrchestrationDb> | undefined

function rawDb(): Database.Database {
  return (orchestrationDb as unknown as { db: Database.Database }).db
}

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

function insertDerivedRow(paneKey: string): void {
  rawDb()
    .prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         origin_kind, origin_pane_key, origin_handle, origin_host_id
       ) VALUES (?, ?, NULL, 'local', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'live', 1, 0,
         'derived', ?, NULL, 'local')`
    )
    .run(`agt_d_${paneKey.length}`, `derived-${paneKey.length}`, paneKey, paneKey)
}

function launchRow(paneKey: string, sessionId: string): void {
  const result = recordLaunch(rawDb(), {
    hostId: 'local',
    paneKey,
    agentType: 'claude',
    sessionId,
    launchGeneration: `gen-${paneKey}`,
    executionHostId: 'local',
    evidence: 'host_launch'
  })
  expect(result.ok).toBe(true)
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

const idle = (): BackgroundWorkVerdict => 'idle'

async function protectedOf(paneKeys: string[]): Promise<string[]> {
  const guard = await computeHibernationGuard(orchestrationDb!, 'local', paneKeys, idle)
  return guard.protectedPaneKeys
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hibernation-guard-'))
  orchestrationDb = new OrchestrationDb(':memory:')
})
afterEach(async () => {
  orchestrationDb?.close()
  orchestrationDb = undefined
  await rm(home, { recursive: true, force: true })
})

describe('computeHibernationGuard (R316)', () => {
  it('protects a non-derived registered row, matched by pane suffix after a tab move', async () => {
    register(PANE_A, 'worker-a')
    expect(await protectedOf([PANE_A])).toEqual([PANE_A])
    expect(await protectedOf([`moved-tab:${LEAF_A}`])).toEqual([`moved-tab:${LEAF_A}`])
  })

  it('protects a quarantined registered row', async () => {
    register(PANE_A, 'worker-a')
    rawDb().prepare(`UPDATE agents SET quarantined = 1 WHERE pane_key = ?`).run(PANE_A)
    expect(await protectedOf([PANE_A])).toEqual([PANE_A])
  })

  it('does not protect a derived row or a pane with no row', async () => {
    insertDerivedRow(PANE_B)
    expect(await protectedOf([PANE_B, PANE_C])).toEqual([])
  })

  it('protects a pane whose newest launch row holds a host-scoped manifest chair session', async () => {
    await writeManifest([chair('alpha')])
    launchRow(PANE_C, SEED)
    expect(await protectedOf([PANE_C])).toEqual([PANE_C])
  })

  it('matches the chair by its live head (lastSessionId), not the seed, once recorded', async () => {
    await writeManifest([chair('alpha', { lastSessionId: OTHER_SESSION })])
    launchRow(PANE_B, SEED)
    launchRow(PANE_C, OTHER_SESSION)
    expect(await protectedOf([PANE_B, PANE_C])).toEqual([PANE_C])
  })

  it('applies a chair naming this host and ignores another host', async () => {
    launchRow(PANE_C, SEED)
    await writeManifest([chair('alpha', { host: hostname() })])
    expect(await protectedOf([PANE_C])).toEqual([PANE_C])
    await writeManifest([chair('alpha', { host: `${hostname()}-elsewhere` })])
    expect(await protectedOf([PANE_C])).toEqual([])
  })

  it('protects nothing by session when the manifest is absent or invalid, and does not throw', async () => {
    launchRow(PANE_C, SEED)
    expect(await protectedOf([PANE_C])).toEqual([])
    await mkdir(join(home, '.orca'), { recursive: true })
    await writeFile(join(home, '.orca', 'chairs.json'), '{not json')
    expect(await protectedOf([PANE_C])).toEqual([])
  })

  it('reports the verdict for every requested pane, including unprotected ones', async () => {
    const verdicts: Record<string, BackgroundWorkVerdict> = {
      [PANE_A]: 'busy',
      [PANE_B]: 'unknown'
    }
    const guard = await computeHibernationGuard(
      orchestrationDb!,
      'local',
      [PANE_A, PANE_B, PANE_C],
      (key) => verdicts[key] ?? 'idle'
    )
    expect(guard.backgroundWork).toEqual({
      [PANE_A]: 'busy',
      [PANE_B]: 'unknown',
      [PANE_C]: 'idle'
    })
    expect(guard.protectedPaneKeys).toEqual([])
  })
})
