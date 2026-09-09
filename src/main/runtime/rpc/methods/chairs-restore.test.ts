// S10-21d b3b (D-R165): unit coverage for chairs-restore.ts's own pure/IO helpers — the RPC
// method handlers themselves need a full runtime+db double to exercise end-to-end (see
// chairs-restore-e2e.test.ts); these three helpers are testable in isolation.
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertLocalCaller, pathExists, writeFileAtomic } from './chairs-restore'

describe('assertLocalCaller (D-R165 M4)', () => {
  it('allows a caller with neither accessProfile nor clientKind set (local socket / in-process)', () => {
    expect(() => assertLocalCaller({})).not.toThrow()
  })

  it('forbids a caller carrying accessProfile', () => {
    expect(() => assertLocalCaller({ accessProfile: 'peer' })).toThrow(/local-transport only/)
  })

  it('forbids a caller carrying clientKind', () => {
    expect(() => assertLocalCaller({ clientKind: 'mobile' })).toThrow(/local-transport only/)
  })
})

describe('pathExists / writeFileAtomic (D-R165 H2/M2)', () => {
  let dir: string

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('pathExists is existence-based, not parse-based — a non-JSON file still exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chairs-restore-test-'))
    const path = join(dir, 'not-a-manifest.txt')
    expect(await pathExists(path)).toBe(false)
    await writeFile(path, 'not json at all', 'utf8')
    expect(await pathExists(path)).toBe(true)
  })

  it('writeFileAtomic leaves no .tmp file behind and the target holds the full content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chairs-restore-test-'))
    const path = join(dir, 'chairs.json')
    await writeFileAtomic(path, '{"version":1,"chairs":[]}\n')
    const entries = await readdir(dir)
    expect(entries).toEqual(['chairs.json'])
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('{"version":1,"chairs":[]}\n')
  })
})
