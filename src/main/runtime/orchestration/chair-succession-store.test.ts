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
  it('sealed -> launching -> confirming -> confirmed succeeds', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    const launching = await transition(deps, 'chair-a', meta.id, 'launching')
    expect(launching.state).toBe('launching')
    const confirming = await transition(deps, 'chair-a', meta.id, 'confirming')
    expect(confirming.state).toBe('confirming')
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

  // G1 repair B3: `confirming` exists exactly so a takeover failure (accept.ts, AFTER closing
  // the incumbent) can still land on a terminal state, without `launching` (which would let a
  // late abort-tail race close the successor pane too).
  it('confirming -> aborted succeeds (accept.ts takeover-failure path)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', meta.id, 'launching')
    await transition(deps, 'chair-a', meta.id, 'confirming')
    const aborted = await transition(deps, 'chair-a', meta.id, 'aborted', {
      abortReason: 'takeover_failed_after_close:name_taken'
    })
    expect(aborted.state).toBe('aborted')
  })

  it('sealed -> confirming throws succession_bad_transition (skips launching)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await expect(transition(deps, 'chair-a', meta.id, 'confirming')).rejects.toBeInstanceOf(
      SuccessionBadTransitionError
    )
  })

  it('launching -> confirmed throws succession_bad_transition (skips confirming)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', meta.id, 'launching')
    await expect(transition(deps, 'chair-a', meta.id, 'confirmed')).rejects.toMatchObject({
      code: 'succession_bad_transition'
    })
  })

  it('confirmed -> anything throws succession_bad_transition (terminal state)', async () => {
    const meta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', meta.id, 'launching')
    await transition(deps, 'chair-a', meta.id, 'confirming')
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
  // G1 repair M2: two concurrent `succeed` calls for the SAME chair must never both launch a
  // successor. Before the fix, the second call raced the first's unlocked `listActive` read and
  // could win, creating two live successions for one chair. `withPaneLock`'s FIFO ordering means
  // the second call's in-lock re-check runs only after the first's full write completes, so it
  // deterministically sees the first's id, not a corrupted or partial read.
  it('the second concurrent createSealed call for the same chair is refused in-flight, never both created', async () => {
    const first = createSealed(deps, 'chair-lock', sealedInput())
    const second = createSealed(deps, 'chair-lock', sealedInput())
    const firstMeta = await first
    await expect(second).rejects.toMatchObject({
      code: 'succession_in_flight',
      successionId: firstMeta.id,
      state: 'sealed'
    })
    const active = await listActive(deps, 'chair-lock')
    expect(active.map((m) => m.id)).toEqual([firstMeta.id])
  })

  // G1 repair N5: `confirming` must count as in flight too — both `listActive`'s read and
  // `createSealed`'s in-lock re-check previously stopped at `sealed`/`launching`, admitting a
  // second seal while an accept was still finishing its takeover.
  it('N5: a record in `confirming` still counts as in flight for both listActive and a concurrent createSealed', async () => {
    const first = await createSealed(deps, 'chair-confirming', sealedInput())
    await transition(deps, 'chair-confirming', first.id, 'launching', {
      successor: { paneKey: 'tabB:b', terminalHandle: 'term_b' }
    })
    await transition(deps, 'chair-confirming', first.id, 'confirming')

    const active = await listActive(deps, 'chair-confirming')
    expect(active.map((m) => m.id)).toEqual([first.id])

    await expect(createSealed(deps, 'chair-confirming', sealedInput())).rejects.toMatchObject({
      code: 'succession_in_flight',
      successionId: first.id,
      state: 'confirming'
    })
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
  // M2 makes "sealed AND launching simultaneously for one chair" impossible in practice (only one
  // succession may be in flight per chair at a time) — this exercises that history (confirmed,
  // then aborted) never leaks into `listActive`, only the current sealed record does.
  it('excludes confirmed and aborted history, listing only the current sealed/launching record', async () => {
    const confirmedMeta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', confirmedMeta.id, 'launching')
    await transition(deps, 'chair-a', confirmedMeta.id, 'confirming')
    await transition(deps, 'chair-a', confirmedMeta.id, 'confirmed')
    const abortedMeta = await createSealed(deps, 'chair-a', sealedInput())
    await transition(deps, 'chair-a', abortedMeta.id, 'aborted')
    const currentMeta = await createSealed(deps, 'chair-a', sealedInput())

    const active = await listActive(deps, 'chair-a')
    expect(active.map((m) => m.id)).toEqual([currentMeta.id])
  })
})
