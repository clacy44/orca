// [G1-10z Q8 repair] `successions/<id>/` and `retired-handles.json` grew unbounded before this
// repair. Real mkdtemp ORCA_HOME per test — mirrors chair-succession-startup-scan.test.ts's shape.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSealed,
  transition,
  read,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import { appendRetiredHandle } from './chair-succession-retired-handles'
import { purgeSuccessionsAtStartup, purgeSuccessionsForChair } from './chair-succession-purge'

let tempDir: string
let storeDeps: ChairSuccessionStoreDeps

function sealedInput() {
  return {
    reason: 'batch_end' as const,
    checkpointText: 'schema: orca.chair-checkpoint/1\n',
    checkpointSha: 'a'.repeat(64),
    charterPath: '/repo/CHARTER.md',
    charterSha: 'b'.repeat(64),
    charterMode: 'reference' as const,
    resumeContextText: '# SUCCESSION CONTEXT succ_test\n',
    incumbent: {
      paneKey: 'pane-incumbent',
      terminalHandle: 'handle-incumbent',
      sessionId: 'sess-1'
    }
  }
}

async function sealAndAbort(chair: string, updatedAtMs: number): Promise<string> {
  const meta = await createSealed(storeDeps, chair, sealedInput())
  await transition(storeDeps, chair, meta.id, 'aborted', { abortReason: 'startup' })
  // Back-date updatedAt directly on disk (transition() always stamps "now").
  const metaPath = join(storeDeps.orcaHome, 'chairs', chair, 'successions', meta.id, 'meta.json')
  const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
  raw.updatedAt = new Date(updatedAtMs).toISOString()
  writeFileSync(metaPath, JSON.stringify(raw, null, 2))
  return meta.id
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-succession-purge-'))
  storeDeps = { orcaHome: tempDir }
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('purgeSuccessionsForChair: succession directories', () => {
  it('deletes a terminal (aborted) dir older than 7 days when more than 5 newer ones exist', async () => {
    const now = Date.now()
    const oldId = await sealAndAbort('chair-a', now - 8 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 5; i += 1) {
      await sealAndAbort('chair-a', now - i * 60 * 1000)
    }

    const summary = await purgeSuccessionsForChair(storeDeps, 'chair-a')

    expect(summary.successionDirsDeleted).toBe(1)
    const oldDir = join(tempDir, 'chairs', 'chair-a', 'successions', oldId)
    expect(existsSync(oldDir)).toBe(false)
  })

  it('keeps the newest 5 even if older than 7 days (safety margin)', async () => {
    const now = Date.now()
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      ids.push(await sealAndAbort('chair-b', now - 30 * 24 * 60 * 60 * 1000 - i * 1000))
    }

    const summary = await purgeSuccessionsForChair(storeDeps, 'chair-b')

    expect(summary.successionDirsDeleted).toBe(0)
    for (const id of ids) {
      expect(existsSync(join(tempDir, 'chairs', 'chair-b', 'successions', id))).toBe(true)
    }
  })

  it('never deletes an active (sealed/launching/confirming) record, even when very old', async () => {
    const meta = await createSealed(storeDeps, 'chair-c', sealedInput())
    // Leave it sealed (active) — never transitioned to a terminal state.
    const metaPath = join(tempDir, 'chairs', 'chair-c', 'successions', meta.id, 'meta.json')
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
    raw.updatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(metaPath, JSON.stringify(raw, null, 2))

    await purgeSuccessionsForChair(storeDeps, 'chair-c')

    const after = await read(storeDeps, 'chair-c', meta.id)
    expect(after?.state).toBe('sealed')
    expect(existsSync(metaPath)).toBe(true)
  })
})

describe('purgeSuccessionsForChair: retired-handles.json cap', () => {
  it('caps at the newest 50 entries, dropping the oldest first', async () => {
    for (let i = 0; i < 55; i += 1) {
      await appendRetiredHandle(storeDeps, 'chair-d', {
        handle: `handle-${i}`,
        succession: `succ_${i}`,
        at: new Date(2026, 0, 1, 0, 0, i).toISOString()
      })
    }

    const summary = await purgeSuccessionsForChair(storeDeps, 'chair-d')

    expect(summary.retiredHandlesTrimmed).toBe(5)
    const { listRetiredHandles } = await import('./chair-succession-retired-handles')
    const remaining = await listRetiredHandles(storeDeps, 'chair-d')
    expect(remaining).toHaveLength(50)
    expect(remaining[0].handle).toBe('handle-5') // oldest 5 dropped
    expect(remaining[49].handle).toBe('handle-54')
  })

  it('is a no-op when at or under the cap', async () => {
    await appendRetiredHandle(storeDeps, 'chair-e', {
      handle: 'handle-only',
      succession: 'succ_1',
      at: new Date().toISOString()
    })
    const summary = await purgeSuccessionsForChair(storeDeps, 'chair-e')
    expect(summary.retiredHandlesTrimmed).toBe(0)
  })

  it('a missing retired-handles.json is a silent no-op', async () => {
    mkdirSync(join(tempDir, 'chairs', 'chair-f'), { recursive: true })
    const summary = await purgeSuccessionsForChair(storeDeps, 'chair-f')
    expect(summary.retiredHandlesTrimmed).toBe(0)
  })
})

describe('purgeSuccessionsAtStartup', () => {
  it('purges every chair under chairs/ and returns a summed summary', async () => {
    const now = Date.now()
    await sealAndAbort('chair-g', now - 8 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 5; i += 1) {
      await sealAndAbort('chair-g', now - i * 1000)
    }
    await sealAndAbort('chair-h', now - 8 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 5; i += 1) {
      await sealAndAbort('chair-h', now - i * 1000)
    }

    const summary = await purgeSuccessionsAtStartup(storeDeps)

    expect(summary.successionDirsDeleted).toBe(2)
  })

  it('a missing chairs/ directory is a silent no-op', async () => {
    const summary = await purgeSuccessionsAtStartup({ orcaHome: join(tempDir, 'never-created') })
    expect(summary).toEqual({ successionDirsDeleted: 0, retiredHandlesTrimmed: 0 })
  })
})
