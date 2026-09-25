import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetRetiredHandlesIndexForTest,
  refreshRetiredHandlesIndexSync,
  retiredHandleChair
} from './chair-succession-retired-index'

describe('chair-succession-retired-index', () => {
  let orcaHome: string

  beforeEach(() => {
    _resetRetiredHandlesIndexForTest()
  })

  afterEach(async () => {
    if (orcaHome) {
      await rm(orcaHome, { recursive: true, force: true })
    }
  })

  it('is empty before any load, and empty when chairs/ does not exist', () => {
    expect(retiredHandleChair('handle-x')).toBeUndefined()
    refreshRetiredHandlesIndexSync('/no/such/orca/home')
    expect(retiredHandleChair('handle-x')).toBeUndefined()
  })

  it("indexes every chair's retired-handles.json and resolves a handle to its chair", async () => {
    orcaHome = await mkdtemp(join(tmpdir(), 'orca-retired-index-'))
    const chairADir = join(orcaHome, 'chairs', 'chair-a')
    const chairBDir = join(orcaHome, 'chairs', 'chair-b')
    await mkdir(chairADir, { recursive: true })
    await mkdir(chairBDir, { recursive: true })
    await writeFile(
      join(chairADir, 'retired-handles.json'),
      JSON.stringify([{ handle: 'old-handle-a', succession: 'succ_1', at: '2026-01-01T00:00:00Z' }])
    )
    await writeFile(
      join(chairBDir, 'retired-handles.json'),
      JSON.stringify([{ handle: 'old-handle-b', succession: 'succ_2', at: '2026-01-01T00:00:00Z' }])
    )

    refreshRetiredHandlesIndexSync(orcaHome)

    expect(retiredHandleChair('old-handle-a')).toBe('chair-a')
    expect(retiredHandleChair('old-handle-b')).toBe('chair-b')
    expect(retiredHandleChair('never-retired')).toBeUndefined()
  })

  it('a chair with no retired-handles.json contributes nothing (no throw)', async () => {
    orcaHome = await mkdtemp(join(tmpdir(), 'orca-retired-index-empty-'))
    await mkdir(join(orcaHome, 'chairs', 'chair-c'), { recursive: true })
    expect(() => refreshRetiredHandlesIndexSync(orcaHome)).not.toThrow()
    expect(retiredHandleChair('anything')).toBeUndefined()
  })

  it('a second refresh fully replaces the prior index', async () => {
    orcaHome = await mkdtemp(join(tmpdir(), 'orca-retired-index-refresh-'))
    const chairDir = join(orcaHome, 'chairs', 'chair-d')
    await mkdir(chairDir, { recursive: true })
    await writeFile(
      join(chairDir, 'retired-handles.json'),
      JSON.stringify([{ handle: 'handle-1', succession: 'succ_1', at: '2026-01-01T00:00:00Z' }])
    )
    refreshRetiredHandlesIndexSync(orcaHome)
    expect(retiredHandleChair('handle-1')).toBe('chair-d')

    await writeFile(
      join(chairDir, 'retired-handles.json'),
      JSON.stringify([
        { handle: 'handle-1', succession: 'succ_1', at: '2026-01-01T00:00:00Z' },
        { handle: 'handle-2', succession: 'succ_2', at: '2026-01-02T00:00:00Z' }
      ])
    )
    refreshRetiredHandlesIndexSync(orcaHome)
    expect(retiredHandleChair('handle-1')).toBe('chair-d')
    expect(retiredHandleChair('handle-2')).toBe('chair-d')
  })

  // [G1-10z Q8 repair] "make the index load incremental (read only chairs whose
  // retired-handles.json mtime changed)". Proven behaviorally (chmod 0000, POSIX-only — skipped
  // on win32) rather than by spying on node:fs (ESM export spying is unsupported by the runner):
  // if chair-e's file were re-read despite its mtime being unchanged, the read would fail closed
  // (unreadable) and drop chair-e's entry — it must NOT.
  it.skipIf(platform() === 'win32')(
    'an unchanged chair (same mtime) is not re-read on a second refresh',
    async () => {
      orcaHome = await mkdtemp(join(tmpdir(), 'orca-retired-index-incremental-'))
      const chairEDir = join(orcaHome, 'chairs', 'chair-e')
      const chairFDir = join(orcaHome, 'chairs', 'chair-f')
      await mkdir(chairEDir, { recursive: true })
      await mkdir(chairFDir, { recursive: true })
      const chairEFile = join(chairEDir, 'retired-handles.json')
      await writeFile(
        chairEFile,
        JSON.stringify([{ handle: 'handle-e1', succession: 'succ_1', at: '2026-01-01T00:00:00Z' }])
      )
      await writeFile(
        join(chairFDir, 'retired-handles.json'),
        JSON.stringify([{ handle: 'handle-f1', succession: 'succ_2', at: '2026-01-01T00:00:00Z' }])
      )
      refreshRetiredHandlesIndexSync(orcaHome)
      expect(retiredHandleChair('handle-e1')).toBe('chair-e')
      expect(retiredHandleChair('handle-f1')).toBe('chair-f')

      // chair-f's file changes (new mtime); chair-e's file becomes unreadable WITHOUT its mtime
      // changing (chmod alone does not bump mtime) — an incremental refresh must skip re-reading
      // it and keep serving its cached entry.
      await writeFile(
        join(chairFDir, 'retired-handles.json'),
        JSON.stringify([
          { handle: 'handle-f1', succession: 'succ_2', at: '2026-01-01T00:00:00Z' },
          { handle: 'handle-f2', succession: 'succ_3', at: '2026-01-02T00:00:00Z' }
        ])
      )
      await chmod(chairEFile, 0o000)

      try {
        refreshRetiredHandlesIndexSync(orcaHome)
        expect(retiredHandleChair('handle-f2')).toBe('chair-f')
        expect(retiredHandleChair('handle-e1')).toBe('chair-e') // never re-read -> never failed closed
      } finally {
        await chmod(chairEFile, 0o600)
      }
    }
  )

  it('a chair removed from disk has its entries dropped on the next refresh', async () => {
    orcaHome = await mkdtemp(join(tmpdir(), 'orca-retired-index-removed-'))
    const chairGDir = join(orcaHome, 'chairs', 'chair-g')
    await mkdir(chairGDir, { recursive: true })
    await writeFile(
      join(chairGDir, 'retired-handles.json'),
      JSON.stringify([{ handle: 'handle-g1', succession: 'succ_1', at: '2026-01-01T00:00:00Z' }])
    )
    refreshRetiredHandlesIndexSync(orcaHome)
    expect(retiredHandleChair('handle-g1')).toBe('chair-g')

    await rm(chairGDir, { recursive: true, force: true })
    refreshRetiredHandlesIndexSync(orcaHome)
    expect(retiredHandleChair('handle-g1')).toBeUndefined()
  })
})
