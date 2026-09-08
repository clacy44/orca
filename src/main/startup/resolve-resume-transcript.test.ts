// S10-21c B2 (design §2 S4): `resolveResumeTranscript`'s own `hasTurn` discriminator, checked
// against the REAL bridge-session stub shape captured from a live stub file on this box
// (execution-truth-2026-09-07.md:14 — 1 line, 267 bytes, `type":"bridge-session"`; verified
// byte-for-byte against `~/.claude/projects/-home-ubuntu/b8d7ef3a-...jsonl` while drafting this
// brief — see B2's RETURN).
// S10-21c B2b (D-R145 medium 5/low 9): the bounded (64 KiB) read and the third `{coverage:
// 'uncovered'}` state.
// S10-21c B2c (D-R148 low 9/low 3): `bytesRead`-bounded read (a short OS read must not feed
// `Buffer.alloc`'s NUL zero-fill to `JSON.parse`) and a whole->stub-only >64 KiB pin.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveResumeTranscript } from './resolve-resume-transcript'

// [D-R148 low 9] Lets exactly one designated path's `open`/`stat` simulate a short OS read
// (bytesRead < the requested length) while every other path goes through the real fs. Reset
// to null in `afterEach` so it never leaks into an unrelated test.
const shortRead = vi.hoisted(() => ({
  targetPath: null as string | null,
  content: '',
  declaredSize: 0,
  bytesRead: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (path: string) => {
      if (shortRead.targetPath !== null && path === shortRead.targetPath) {
        return { size: shortRead.declaredSize } as Awaited<ReturnType<typeof actual.stat>>
      }
      return actual.stat(path)
    },
    open: async (path: string, flags: string) => {
      if (shortRead.targetPath !== null && path === shortRead.targetPath) {
        const source = Buffer.from(shortRead.content, 'utf8')
        return {
          read: async (buf: Buffer, offset: number) => {
            const n = Math.min(shortRead.bytesRead, source.length)
            source.copy(buf, offset, 0, n)
            return { bytesRead: n, buffer: buf }
          },
          close: async () => {}
        } as unknown as Awaited<ReturnType<typeof actual.open>>
      }
      return actual.open(path, flags)
    }
  }
})

let tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  shortRead.targetPath = null
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

  // [S10-21c B-final F3, D-R159 finding 3] A SECOND, distinct zero-turn stub shape Claude Code
  // writes on a `fork_inherit` bridge — measured live on this box at ~137 bytes / 1 line /
  // `{"type":"history-suppression","cause":"fork_inherit",...}`, no `bridge-session` field
  // anywhere in it. The pre-fix predicate ("anything but bridge-session") returned `hasTurn:
  // true` for this; the fixed predicate (turn types only) returns false, same as the stub.
  it('a history-suppression fork_inherit stub (a second, distinct zero-turn shape) -> hasTurn false (fails at base: base returns hasTurn true)', async () => {
    const root = await makeRoot('orca-resume-preflight-history-suppression-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'e105424a-92d2-4dd1-9299-83e797970cbd.jsonl')
    const historySuppressionLine =
      '{"type":"history-suppression","cause":"fork_inherit","sessionId":' +
      '"e105424a-92d2-4dd1-9299-83e797970cbd"}\n'
    await writeFile(target, historySuppressionLine)

    const resolved = await resolveResumeTranscript(
      'claude',
      'e105424a-92d2-4dd1-9299-83e797970cbd',
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

  // [S10-21c B-final H1, D-R160 high 1] Turn types are PER TRANSCRIPT AGENT (resolved from each
  // agent's own decoder) — the pre-fix predicate used claude's vocabulary globally, so a real
  // codex/omp conversation under the 64 KiB bounded read was misclassified as turn-free.
  describe('[D-R160 high 1] turn types are per transcript agent', () => {
    it('claude: a minimal transcript with one user turn -> hasTurn true', async () => {
      const root = await makeRoot('orca-resume-preflight-claude-turn-')
      const claudeProjectsDir = join(root, 'claude-projects')
      const projectDir = join(claudeProjectsDir, '-home-ubuntu')
      await mkdir(projectDir, { recursive: true })
      const target = join(projectDir, 'claude-minimal.jsonl')
      await writeFile(target, '{"type":"user","message":{"role":"user","content":"hi"}}\n')

      const resolved = await resolveResumeTranscript('claude', 'claude-minimal', {
        claudeProjectsDir
      })
      expect(resolved).toEqual({ path: target, hasTurn: true })
    })

    it('codex: a rollout with a session_meta record then a response_item turn -> hasTurn true (fails at base: base predicate only recognized user/assistant/summary)', async () => {
      const root = await makeRoot('orca-resume-preflight-codex-turn-')
      const codexDir = join(root, 'codex-sessions')
      await mkdir(codexDir, { recursive: true })
      const target = join(codexDir, 'rollout-codex-turn.jsonl')
      await writeFile(
        target,
        '{"type":"session_meta","payload":{"id":"codex-turn"}}\n' +
          '{"type":"response_item","payload":{"id":"codex-turn","type":"message","role":"assistant","content":[]}}\n'
      )

      const resolved = await resolveResumeTranscript('codex', 'codex-turn', {
        codexSessionsDirs: [codexDir]
      })
      expect(resolved).toEqual({ path: target, hasTurn: true })
    })

    it('codex: a session_meta-only rollout -> hasTurn false', async () => {
      const root = await makeRoot('orca-resume-preflight-codex-meta-only-')
      const codexDir = join(root, 'codex-sessions')
      await mkdir(codexDir, { recursive: true })
      const target = join(codexDir, 'rollout-codex-meta-only.jsonl')
      await writeFile(target, '{"type":"session_meta","payload":{"id":"codex-meta-only"}}\n')

      const resolved = await resolveResumeTranscript('codex', 'codex-meta-only', {
        codexSessionsDirs: [codexDir]
      })
      expect(resolved).toEqual({ path: target, hasTurn: false })
    })

    it('omp: a session with one message turn -> hasTurn true (fails at base)', async () => {
      const root = await makeRoot('orca-resume-preflight-omp-turn-')
      const ompDir = join(root, 'omp-sessions')
      const workspaceDir = join(ompDir, '-home-ubuntu-project')
      await mkdir(workspaceDir, { recursive: true })
      const target = join(workspaceDir, '2026-01-01T00-00-00_omp-turn.jsonl')
      await writeFile(
        target,
        '{"type":"message","id":"m1","message":{"role":"user","content":"hi"}}\n'
      )

      const resolved = await resolveResumeTranscript('omp', 'omp-turn', {
        ompSessionsDir: ompDir
      })
      expect(resolved).toEqual({ path: target, hasTurn: true })
    })

    it('grok: a chat_history with one user turn -> hasTurn true', async () => {
      const root = await makeRoot('orca-resume-preflight-grok-turn-')
      const grokDir = join(root, 'grok-sessions')
      const sessionDir = join(grokDir, 'workspace-group', 'grok-turn')
      await mkdir(sessionDir, { recursive: true })
      const target = join(sessionDir, 'chat_history.jsonl')
      await writeFile(target, '{"type":"user","content":"hi"}\n')

      const resolved = await resolveResumeTranscript('grok', 'grok-turn', {
        grokSessionsDir: grokDir
      })
      expect(resolved).toEqual({ path: target, hasTurn: true })
    })
  })

  it('[D-R148 low 3] a whole file of nothing but repeated bridge-session stubs, >64 KiB -> hasTurn true (the deliberate false positive; red against a whole-file scan)', async () => {
    const root = await makeRoot('orca-resume-preflight-allstub-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'all-stub-session.jsonl')
    // 300 copies of the real 267-byte stub line (~80 KiB) -- every complete record in the
    // bounded 64 KiB window really is a stub, but the file continues past the window, so the
    // resolver cannot tell this apart from a real conversation it merely couldn't finish
    // scanning. A whole-file scan would correctly see nothing but stubs and return false; the
    // bounded read must not make that promise.
    await writeFile(target, REAL_STUB_LINE.repeat(300))
    expect((await stat(target)).size).toBeGreaterThan(64 * 1024)

    const resolved = await resolveResumeTranscript('claude', 'all-stub-session', {
      claudeProjectsDir
    })
    expect(resolved).toEqual({ path: target, hasTurn: true })
  })

  it('[D-R148 low 9] a short OS read (bytesRead < requested length) never feeds NUL padding to JSON.parse', async () => {
    const root = await makeRoot('orca-resume-preflight-shortread-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-home-ubuntu')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'short-read-session.jsonl')
    // A real file must exist for the resolver to find and return this path -- its actual
    // content is irrelevant, since `stat`/`open` for this exact path are overridden below.
    await writeFile(target, REAL_STUB_LINE)

    shortRead.targetPath = target
    shortRead.declaredSize = Buffer.byteLength(REAL_STUB_LINE)
    shortRead.content = REAL_STUB_LINE
    // The OS returns only the first 200 of the requested 267 bytes -- a genuine short read,
    // cut mid-record (no '\n' anywhere in what was actually delivered). The unread 67 bytes of
    // `Buffer.alloc`'s zero-fill must never reach `JSON.parse`.
    shortRead.bytesRead = 200

    const parseSpy = vi.spyOn(JSON, 'parse')
    const resolved = await resolveResumeTranscript('claude', 'short-read-session', {
      claudeProjectsDir
    })
    for (const call of parseSpy.mock.calls) {
      const arg = call[0]
      expect(typeof arg === 'string' && arg.includes('\u0000')).toBe(false)
    }
    // Nothing complete was actually read (the lone partial line is dropped as unsafe-to-parse),
    // so the deliberate "the read did not cover the whole file" fallback fires -- the same
    // fails-open direction as before, but via the coded rule, never an accidental parse throw.
    expect(resolved).toEqual({ path: target, hasTurn: true })
    parseSpy.mockRestore()
  })
})
