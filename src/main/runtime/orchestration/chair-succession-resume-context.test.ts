// S10-22a WAVE 2: `orchestration.chairs.resumeContext` hook-mode lookup — the sealed text for the
// successor pane, `succession_none`-shaped (null) for any other caller.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSealed, transition, type ChairSuccessionStoreDeps } from './chair-succession-store'
import {
  findSuccessionForSuccessorPane,
  findSuccessionById,
  readResumeContextText,
  markResumeContextServed,
  wasResumeContextServed,
  _resetResumeContextServedForTest
} from './chair-succession-resume-context'
import type { ChairSuccessionDeps } from './chair-succession-execute'

describe('S10-22a WAVE 2: chair-succession-resume-context', () => {
  let tmp: string
  let storeDeps: ChairSuccessionStoreDeps
  let deps: ChairSuccessionDeps

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'orca-succession-resume-ctx-'))
    await mkdir(join(tmp, 'chairs'), { recursive: true })
    storeDeps = { orcaHome: tmp }
    deps = { db: undefined as never, runtime: undefined as never, orcaHome: tmp }
    _resetResumeContextServedForTest()
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  async function seal(chair: string) {
    return createSealed(storeDeps, chair, {
      reason: 'batch_end',
      checkpointText: 'checkpoint text',
      checkpointSha: 'sha-1',
      charterPath: '/tmp/charter.md',
      charterSha: 'sha-2',
      charterMode: 'reference',
      resumeContextText: '# SUCCESSION CONTEXT test\nsealed body\nEND SUCCESSION CONTEXT sha-1',
      incumbent: { paneKey: 'tabA:a', terminalHandle: 'term_a' }
    })
  }

  it('hook mode returns the sealed text for the launching succession on the successor pane', async () => {
    const meta = await seal('chair-x')
    await transition(storeDeps, 'chair-x', meta.id, 'launching', {
      successor: { paneKey: 'tabB:b', terminalHandle: 'term_b' }
    })
    const found = await findSuccessionForSuccessorPane(deps, 'tabB:b')
    expect(found?.id).toBe(meta.id)
    const text = await readResumeContextText(deps, found!)
    expect(text).toContain('sealed body')
  })

  it('hook mode finds nothing for a pane that is not a succession successor', async () => {
    const meta = await seal('chair-x')
    await transition(storeDeps, 'chair-x', meta.id, 'launching', {
      successor: { paneKey: 'tabB:b', terminalHandle: 'term_b' }
    })
    const found = await findSuccessionForSuccessorPane(deps, 'tabC:unrelated')
    expect(found).toBeNull()
  })

  it('hook mode finds nothing for a sealed (not yet launching) succession', async () => {
    await seal('chair-y')
    const found = await findSuccessionForSuccessorPane(deps, 'tabB:b')
    expect(found).toBeNull()
  })

  it('findSuccessionById locates a record by id regardless of caller pane', async () => {
    const meta = await seal('chair-z')
    const found = await findSuccessionById(deps, meta.id)
    expect(found?.chair).toBe('chair-z')
    expect(await findSuccessionById(deps, 'succ_nope')).toBeNull()
  })

  it('tracks whether the hook already served a succession, resettable between tests', () => {
    expect(wasResumeContextServed('succ_abc')).toBe(false)
    markResumeContextServed('succ_abc')
    expect(wasResumeContextServed('succ_abc')).toBe(true)
  })
})
