// S10-21c B2 (design §2 S4): `resolveResumeTranscript`'s own `hasTurn` discriminator, checked
// against the REAL bridge-session stub shape captured from a live stub file on this box
// (execution-truth-2026-09-07.md:14 — 1 line, 267 bytes, `type":"bridge-session"`; verified
// byte-for-byte against `~/.claude/projects/-home-ubuntu/b8d7ef3a-...jsonl` while drafting this
// brief — see B2's RETURN).
// S10-21c B2b (D-R145 medium 5/low 9): the bounded (64 KiB) read and the third `{coverage:
// 'uncovered'}` state.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveResumeTranscript } from './resolve-resume-transcript'

let tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})
async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

// Byte-for-byte the real stub Claude Code CLI writes for `claude --session-id X` before any
// turn (267 bytes total, 1 record, trailing newline included).
const REAL_STUB_RECORD =
  '{"type":"bridge-session","sessionId":"b8d7ef3a-932d-4ac5-956b-2b52a33b848c",' +
  '"bridgeSessionId":"cse_01EVB2HKjhCsk6PdmkQMhupM","lastSequenceNum":0,' +
  '"ownerAccountUuid":"3e0391d3-9cc7-4ade-a36e-1fa14954b716",' +
  '"ownerOrganizationUuid":"61612677-f11b-43ef-af72-f372dedf5c30"}'
const REAL_STUB_LINE = `${REAL_STUB_RECORD}\n`

describe('resolveResumeTranscript (S10-21c B2, design S4)', () => {
  it('a missing transcript -> null', async () => {
    const root = await makeRoot('orca-resume-preflight-miss-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const resolved = await resolveResumeTranscript('claude', 'no-such-session', {
      claudeProjectsDir
    })
    expect(resolved).toBeNull()
  })

  it('a stub-only transcript (real bridge-session shape, 267 bytes) -> hasTurn false', async () => {
    expect(Buffer.byteLength(REAL_STUB_LINE)).toBe(267) // matches the captured stub exactly
    const root = await makeRoot('orca-resume-preflight-stub-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'b8d7ef3a-932d-4ac5-956b-2b52a33b848c.jsonl')
    await writeFile(target, REAL_STUB_LINE)

    const resolved = await resolveResumeTranscript(
      'claude',
      'b8d7ef3a-932d-4ac5-956b-2b52a33b848c',
      { claudeProjectsDir }
    )
    expect(resolved).toEqual({ path: target, hasTurn: false })
  })

  it('a transcript with a real record after the bridge-session stub -> hasTurn true', async () => {
    const root = await makeRoot('orca-resume-preflight-turn-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'real-session.jsonl')
    await writeFile(
      target,
      `${REAL_STUB_LINE}\n{"type":"user","message":{"role":"user","content":"hi"}}\n`
    )

    const resolved = await resolveResumeTranscript('claude', 'real-session', { claudeProjectsDir })
    expect(resolved).toEqual({ path: target, hasTurn: true })
  })

  it('an empty file (no records at all) -> hasTurn false', async () => {
    const root = await makeRoot('orca-resume-preflight-empty-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'empty-session.jsonl')
    await writeFile(target, '')

    const resolved = await resolveResumeTranscript('claude', 'empty-session', { claudeProjectsDir })
    expect(resolved).toEqual({ path: target, hasTurn: false })
  })

  it('[D-R145 medium 5] a >64 KiB transcript whose first record is a stub and second is a real turn -> hasTurn true, bounded read', async () => {
    const root = await makeRoot('orca-resume-preflight-bounded-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'big-session.jsonl')
    // First record: the real stub (267 B). Second: a synthetic turn padded well past 64 KiB, so
    // the bounded read's prefix cannot see it directly — the resolver must fall back to "every
    // complete record in the prefix was a stub AND the file continues beyond it".
    const bigTurn = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(80 * 1024) }
    })
    await writeFile(target, `${REAL_STUB_LINE}${bigTurn}\n`)
    expect((await stat(target)).size).toBeGreaterThan(64 * 1024)

    const resolved = await resolveResumeTranscript('claude', 'big-session', { claudeProjectsDir })
    expect(resolved).toEqual({ path: target, hasTurn: true })
  })

  it('[D-R145 low 9] an agent type the resolver does not cover -> {coverage: "uncovered"}, never null', async () => {
    const resolved = await resolveResumeTranscript('gemini', 'sess-uncovered')
    expect(resolved).toEqual({ coverage: 'uncovered' })
  })
})
