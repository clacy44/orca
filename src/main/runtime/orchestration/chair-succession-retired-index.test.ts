import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
})
