// S10-22a WAVE 1 (b1-slice1-succession.md): 0700 dirs, atomic write leaves no tmp, every legal
// and illegal transition, lock contention between two createSealed calls, ORCA_HOME injection,
// retired-handles append.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendRetiredHandle,
  createSealed,
  listActive,
  read,
  SuccessionBadTransitionError,
  transition,
  type ChairSuccessionStoreDeps,
  type CreateSealedInput
} from './chair-succession-store'

let tempDir: string
let deps: ChairSuccessionStoreDeps

function sealedInput(overrides: Partial<CreateSealedInput> = {}): CreateSealedInput {
  return {
    reason: 'batch_end',
    checkpointText: 'schema: orca.chair-checkpoint/1\n',
    checkpointSha: 'a'.repeat(64),
    charterPath: '/repo/CHARTER.md',
    charterSha: 'b'.repeat(64),
    charterMode: 'reference',
    resumeContextText: '# SUCCESSION CONTEXT succ_test\n',
    incumbent: { paneKey: 'pane-1', terminalHandle: 'handle-1', sessionId: 'sess-1' },
    ...overrides
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-succession-store-'))
  deps = { orcaHome: tempDir }
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('S10-22a chair-succession-store: directory modes', () => {
  it('creates the chair root and the succession directory at mode 0700', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    const chairRoot = join(tempDir, 'chairs', 'chair-a')
    const succDir = join(chairRoot, 'successions', meta.id)
    expect(statSync(chairRoot).mode & 0o777).toBe(0o700)
    expect(statSync(succDir).mode & 0o777).toBe(0o700)
  })

  it('writes checkpoint.md, charter-ref.json, resume-context.md, meta.json', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    const succDir = join(tempDir, 'chairs', 'chair-a', 'successions', meta.id)
    const files = readdirSync(succDir).sort()
    expect(files).toEqual(['charter-ref.json', 'checkpoint.md', 'meta.json', 'resume-context.md'])
  })

  it('also writes charter.md only when charterMode is embed', async () => {
    const embedMeta = await createSealed(
      deps,
      'chair-embed',
      sealedInput({ charterMode: 'embed', charterText: 'charter body' })
    )
    const embedDir = join(tempDir, 'chairs', 'chair-embed', 'successions', embedMeta.id)
    expect(readdirSync(embedDir)).toContain('charter.md')

    const refMeta = await createSealed(deps, 'chair-ref', sealedInput())
    const refDir = join(tempDir, 'chairs', 'chair-ref', 'successions', refMeta.id)
    expect(readdirSync(refDir)).not.toContain('charter.md')
  })
})

describe('S10-22a chair-succession-store: atomic write leaves no tmp', () => {
  it('the succession directory holds no *.tmp files after createSealed resolves', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    const succDir = join(tempDir, 'chairs', 'chair-a', 'successions', meta.id)
    const stray = readdirSync(succDir).filter((f) => f.includes('.tmp'))
    expect(stray).toEqual([])
  })
})

describe('S10-22a chair-succession-store: legal and illegal transitions', () => {
  it('sealed -> launching -> confirmed succeeds', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    const launching = await transition(deps, 'chair-a', meta.id, 'launching')
    expect(launching.state).toBe('launching')
    const confirmed = await transition(deps, 'chair-a', meta.id, 'confirmed')
    expect(confirmed.state).toBe('confirmed')
  })

  it('sealed -> aborted succeeds', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    const aborted = await transition(deps, 'chair-a', meta.id, 'aborted', {
      abortReason: 'no accept'
    })
    expect(aborted.state).toBe('aborted')
    expect(aborted.abortReason).toBe('no accept')
  })

  it('launching -> aborted succeeds', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', meta.id, 'launching')
    const aborted = await transition(deps, 'chair-a', meta.id, 'aborted')
    expect(aborted.state).toBe('aborted')
  })

  it('sealed -> confirmed throws succession_bad_transition (skips launching)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await expect(transition(deps, 'chair-a', meta.id, 'confirmed')).rejects.toBeInstanceOf(
      SuccessionBadTransitionError
    )
  })

  it('confirmed -> anything throws succession_bad_transition (terminal state)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', meta.id, 'launching')
    await transition(deps, 'chair-a', meta.id, 'confirmed')
    await expect(transition(deps, 'chair-a', meta.id, 'aborted')).rejects.toMatchObject({
      code: 'succession_bad_transition'
    })
  })

  it('aborted -> anything throws succession_bad_transition (terminal state)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', meta.id, 'aborted')
    await expect(transition(deps, 'chair-a', meta.id, 'launching')).rejects.toMatchObject({
      code: 'succession_bad_transition'
    })
  })

  it('transitioning an unknown id throws succession_bad_transition', async () => {
    await expect(
      transition(deps, 'chair-a', 'succ_doesnotexist', 'launching')
    ).rejects.toMatchObject({ code: 'succession_bad_transition' })
  })
})

describe('S10-22a chair-succession-store: lock contention between two createSealed calls', () => {
  it('serializes two concurrent createSealed calls for the same chair (FIFO, not rejection)', async () => {
    const order: string[] = []
    const first = createSealed(deps, 'chair-lock', sealedInput()).then((meta) => {
      order.push('first')
      return meta
    })
    const second = createSealed(deps, 'chair-lock', sealedInput()).then((meta) => {
      order.push('second')
      return meta
    })
    const [firstMeta, secondMeta] = await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    expect(firstMeta.id).not.toBe(secondMeta.id)
    const active = await listActive(deps, 'chair-lock')
    expect(active.map((m) => m.id).sort()).toEqual([firstMeta.id, secondMeta.id].sort())
  })
})

describe('S10-22a chair-succession-store: ORCA_HOME injection', () => {
  it('two distinct orcaHome roots keep the same chair name fully isolated', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'orca-succession-store-other-'))
    try {
      const otherDeps: ChairSuccessionStoreDeps = { orcaHome: otherDir }
      const meta = await createSealed(deps, 'chair-a', sealedInput())
      const found = await read(deps, 'chair-a', meta.id)
      const notFound = await read(otherDeps, 'chair-a', meta.id)
      expect(found?.id).toBe(meta.id)
      expect(notFound).toBeNull()
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

describe('S10-22a chair-succession-store: retired-handles append', () => {
  it('appends entries without dropping prior ones, across multiple calls', async () => {
    await appendRetiredHandle(deps, 'chair-a', {
      handle: 'handle-1',
      succession: 'succ_one',
      at: '2026-09-25T00:00:00.000Z'
    })
    await appendRetiredHandle(deps, 'chair-a', {
      handle: 'handle-2',
      succession: 'succ_two',
      at: '2026-09-25T00:01:00.000Z'
    })
    const raw = await readFile(join(tempDir, 'chairs', 'chair-a', 'retired-handles.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual([
      { handle: 'handle-1', succession: 'succ_one', at: '2026-09-25T00:00:00.000Z' },
      { handle: 'handle-2', succession: 'succ_two', at: '2026-09-25T00:01:00.000Z' }
    ])
  })
})

describe('S10-22a chair-succession-store: listActive', () => {
  it('lists only sealed/launching successions, excluding confirmed and aborted', async () => {
    const sealedMeta = await createSealed(deps, 'chair-a', sealedInput())
    const launchingMeta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', launchingMeta.id, 'launching')
    const confirmedMeta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', confirmedMeta.id, 'launching')
    await transition(deps, 'chair-a', confirmedMeta.id, 'confirmed')
    const abortedMeta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', abortedMeta.id, 'aborted')

    const active = await listActive(deps, 'chair-a')
    expect(active.map((m) => m.id).sort()).toEqual([sealedMeta.id, launchingMeta.id].sort())
  })
})
