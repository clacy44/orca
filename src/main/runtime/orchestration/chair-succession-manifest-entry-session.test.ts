// 10z.5 R287 (T10): the host-scoped manifest chair whose resumable session is X. Never throws.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const SEED = '11111111-1111-4111-8111-111111111111'
const HEAD = '22222222-2222-4222-8222-222222222222'

let home: string
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home }
})

const { findHostScopedManifestChairForSession } = await import('./chair-succession-manifest-entry')

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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chair-manifest-session-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('findHostScopedManifestChairForSession', () => {
  it('matches the seed conversationId when no lastSessionId was recorded (host unset applies)', async () => {
    await writeManifest([chair('alpha')])
    expect((await findHostScopedManifestChairForSession(SEED))?.name).toBe('alpha')
  })

  it('matches lastSessionId, not the seed, once a live head was recorded', async () => {
    await writeManifest([chair('alpha', { lastSessionId: HEAD })])
    expect((await findHostScopedManifestChairForSession(HEAD))?.name).toBe('alpha')
    expect(await findHostScopedManifestChairForSession(SEED)).toBeNull()
  })

  it('applies a chair naming this host', async () => {
    await writeManifest([chair('alpha', { host: hostname() })])
    expect((await findHostScopedManifestChairForSession(SEED))?.name).toBe('alpha')
  })

  it('never applies a chair for another host', async () => {
    await writeManifest([chair('alpha', { host: `${hostname()}-elsewhere` })])
    expect(await findHostScopedManifestChairForSession(SEED)).toBeNull()
  })

  it('is null for an unknown session, a bad manifest, and an absent manifest', async () => {
    await writeManifest([chair('alpha')])
    expect(await findHostScopedManifestChairForSession(HEAD)).toBeNull()
    await writeFile(join(home, '.orca', 'chairs.json'), '{not json')
    expect(await findHostScopedManifestChairForSession(SEED)).toBeNull()
    await writeManifest('not an array')
    expect(await findHostScopedManifestChairForSession(SEED)).toBeNull()
    await rm(join(home, '.orca', 'chairs.json'))
    expect(await findHostScopedManifestChairForSession(SEED)).toBeNull()
  })
})
