// 10z.5 R289 (T13): the host-scoped launch pins a caller resume of an attributed session inherits.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import type Database from '../../sqlite/sync-database'
import type { LaunchPrefSource } from './agent-launch-sessions'
import type { CallerResumePinRequest } from './caller-resume-launch-preferences'
import { OrchestrationDb } from './db'

let home: string
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home }
})

const { resolveCallerResumeLaunchPreferences } = await import('./caller-resume-launch-preferences')

const HOST = 'local'
const EXEC = 'local'
const X = '44444444-4444-4444-8444-444444444444'
const PANE_A = 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NAME = 'chair-a'
const NO_ARGS: CallerResumePinRequest = {
  agentArgs: undefined,
  appendAgentArgs: undefined,
  shell: 'posix'
}

let db: OrchestrationDb | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'caller-resume-prefs-'))
})
afterEach(async () => {
  db?.close()
  db = undefined
  await rm(home, { recursive: true, force: true })
})

async function writeManifest(chairs: unknown): Promise<void> {
  await mkdir(join(home, '.orca'), { recursive: true })
  await writeFile(join(home, '.orca', 'chairs.json'), JSON.stringify({ version: 1, chairs }))
}
const chair = (extra: Record<string, unknown> = {}) => ({
  name: NAME,
  conversationId: X,
  worktree: '/work',
  agent: 'claude',
  ...extra
})

function register(d: OrchestrationDb): string {
  const created = d.upsertAgentByPaneSuffix({
    displayName: NAME,
    role: null,
    hostId: HOST,
    paneKey: PANE_A,
    terminalHandle: null,
    processIncarnation: null,
    worktreeId: null,
    worktreePath: null,
    branch: null,
    title: null,
    agentLabel: null,
    originHandle: null,
    originHostId: HOST
  })
  if (created.outcome === 'name_taken') {
    throw new Error('fixture setup failed')
  }
  return created.agent.id
}

function attributedSession(
  prefs?: { model?: string; effort?: string; source?: LaunchPrefSource },
  executionHostId = EXEC
): OrchestrationDb {
  const d = new OrchestrationDb(':memory:')
  db = d
  const id = register(d)
  const result = d.recordLaunch({
    hostId: HOST,
    paneKey: PANE_A,
    agentType: 'claude',
    sessionId: X,
    launchGeneration: 'gen-1',
    executionHostId,
    evidence: 'host_launch',
    ...(prefs ? { prefs: { ...prefs, source: prefs.source ?? 'launch' } } : {})
  })
  if (!result.ok) {
    throw new Error('fixture setup failed')
  }
  d.setLaunchAgentId({ seq: result.row.seq }, id)
  return d
}
const raw = (d: OrchestrationDb) => (d as unknown as { db: Database.Database }).db
const resolve = (d: OrchestrationDb, request = NO_ARGS) =>
  resolveCallerResumeLaunchPreferences(d, HOST, EXEC, X, request)

describe('resolveCallerResumeLaunchPreferences', () => {
  it('takes the launch row pins first, then fills the missing field from the manifest', async () => {
    await writeManifest([chair({ model: 'manifest-model', effort: 'high' })])
    expect(await resolve(attributedSession({ model: 'row-model' }))).toEqual({
      model: 'row-model',
      effort: 'high'
    })
    expect(await resolve(attributedSession({ model: 'row-model', effort: 'max' }))).toEqual({
      model: 'row-model',
      effort: 'max'
    })
  })

  it('falls back to the manifest alone when the row carries no pins', async () => {
    await writeManifest([chair({ model: 'manifest-model', effort: 'xhigh' })])
    expect(await resolve(attributedSession())).toEqual({
      model: 'manifest-model',
      effort: 'xhigh'
    })
  })

  it('DEC-9: an observed xhigh row never overrides a manifest ultracode', async () => {
    await writeManifest([chair({ effort: 'ultracode' })])
    expect(await resolve(attributedSession({ effort: 'xhigh', source: 'observed' }))).toEqual({
      effort: 'ultracode'
    })
    expect(await resolve(attributedSession({ effort: 'xhigh', source: 'launch' }))).toEqual({
      effort: 'xhigh'
    })
  })

  it('skips fields the request agentArgs or appendAgentArgs already set', async () => {
    await writeManifest([chair({ model: 'manifest-model', effort: 'high' })])
    const d = attributedSession({ model: 'row-model', effort: 'max' })
    expect(await resolve(d, { ...NO_ARGS, agentArgs: '--model=opus' })).toEqual({ effort: 'max' })
    expect(await resolve(d, { ...NO_ARGS, appendAgentArgs: '--effort low' })).toEqual({
      model: 'row-model'
    })
    expect(
      await resolve(d, { ...NO_ARGS, agentArgs: '--model a', appendAgentArgs: '--effort b' })
    ).toBeUndefined()
    expect(await resolve(d, { ...NO_ARGS, agentArgs: '--verbose' })).toEqual({
      model: 'row-model',
      effort: 'max'
    })
  })

  it('ignores a launch row of another execution host and a manifest chair for another host', async () => {
    await writeManifest([chair({ host: `${hostname()}-elsewhere`, model: 'other-host-model' })])
    expect(
      await resolve(attributedSession({ model: 'row-model' }, 'ssh-elsewhere'))
    ).toBeUndefined()
    // Attributed through a same-host row that carries no pins: the other host's manifest is ignored.
    expect(await resolve(attributedSession())).toBeUndefined()
    await writeManifest([chair({ host: hostname(), model: 'this-host-model' })])
    expect(await resolve(attributedSession())).toEqual({ model: 'this-host-model' })
  })

  it('an unattributed session gets undefined', async () => {
    await writeManifest([chair({ model: 'manifest-model' })])
    db = new OrchestrationDb(':memory:')
    expect(await resolve(db)).toBeUndefined()
  })

  it('a derived, tombstoned or quarantined identity gets undefined', async () => {
    await writeManifest([chair({ model: 'manifest-model' })])
    const d = attributedSession({ model: 'row-model' })
    raw(d).prepare(`UPDATE agents SET derived = 1`).run()
    expect(await resolve(d)).toBeUndefined()
    raw(d).prepare(`UPDATE agents SET derived = 0, quarantined = 1`).run()
    expect(await resolve(d)).toBeUndefined()
    raw(d).prepare(`UPDATE agents SET quarantined = 0, tombstoned_at = datetime('now')`).run()
    expect(await resolve(d)).toBeUndefined()
  })

  it('a missing or throwing manifest leaves the row pins alone and never throws', async () => {
    const d = attributedSession({ model: 'row-model' })
    expect(await resolve(d)).toEqual({ model: 'row-model' })
    await mkdir(join(home, '.orca'), { recursive: true })
    await writeFile(join(home, '.orca', 'chairs.json'), '{not json')
    expect(await resolve(d)).toEqual({ model: 'row-model' })
    const throwing = {
      ...d,
      newestHostScopedLaunchForSession: () => {
        throw new Error('boom')
      }
    }
    expect(
      await resolveCallerResumeLaunchPreferences(
        throwing as unknown as OrchestrationDb,
        HOST,
        EXEC,
        X,
        NO_ARGS
      )
    ).toBeUndefined()
  })
})
