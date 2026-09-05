// S10-21a C3-v2f (D-R104 T44, Ruling 34 Addendum 15). No zod/IPC schema definition — anywhere a
// wire-facing `z.object({...})` (or `z.strictObject`/`z.looseObject`) is declared under the roots
// below — may name a field `launchAdmission`, `sequencedAgentLine`, or `restoreProvenance`. Those
// three are non-wire, in-process-only concepts (agent-launch-admission.ts's own doc comments);
// a zod schema naming one would mean a wire param/response could carry it.
//
// Deliberately scoped to the CONTENTS of a `z.object({...})` call, not the whole file: ordinary
// main-process code legitimately CONSTRUCTS a `restoreProvenance: { kind: 'none' }` object literal
// (a fixed, locally-computed value, e.g. rpc/methods/terminal.ts's own handler body calling
// `createTerminal`) or READS `admission.sequencedAgentLine` (agent-launch-classification.ts) —
// neither is a schema naming the field to the wire. Whole-file text scanning would false-positive
// on both; this fence looks only inside the schema literal itself.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const ROOTS = [
  resolve(REPO_ROOT, 'src', 'main', 'runtime', 'rpc', 'methods'),
  resolve(REPO_ROOT, 'src', 'main', 'ipc'),
  resolve(REPO_ROOT, 'src', 'preload'),
  resolve(REPO_ROOT, 'src', 'relay'),
  resolve(REPO_ROOT, 'src', 'renderer'),
  resolve(REPO_ROOT, 'src', 'shared'),
  // [D-R105 R-2] PtySpawnOptions (pty-provider-contract.ts) is the shape every IPtyProvider
  // receives — this root is in scope so a zod schema built here (directly or via .extend/.merge
  // off a base schema) is caught too.
  resolve(REPO_ROOT, 'src', 'main', 'providers')
]
// [Ruling 34 Addendum 15] The two named non-wire construction sites — `pty.ts` builds the
// in-process `LaunchAdmission` descriptor (its two `kind` variants, see agent-launch-admission.ts)
// that
// never reaches a schema; `lane-pinned-spawn.ts` threads it through `spawnWithLane`. Exempted by
// exact path. Nothing else in `src/main/ipc` is exempt.
const ALLOWLISTED_FILES = new Set([
  join(REPO_ROOT, 'src', 'main', 'ipc', 'pty.ts'),
  join(REPO_ROOT, 'src', 'main', 'ipc', 'lane-pinned-spawn.ts')
])

const FORBIDDEN_FIELD_RE =
  /['"]?\b(launchAdmission|sequencedAgentLine|restoreProvenance)\b['"]?\s*[?]?\s*:/

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(path)
    }
    if (!entry.isFile() || !(path.endsWith('.ts') || path.endsWith('.tsx'))) {
      return []
    }
    if (entry.name.includes('.test.')) {
      return []
    }
    return [path]
  })
}

// [S10-21a C12, D-R105 note] The pre-C12 version of this brace walker counted every `{`/`}`
// character verbatim, including ones inside a string/template literal or a comment (e.g. a
// `.describe("a { forged } value")` call) — such a brace would desync `depth` from the schema
// body's REAL nesting, closing the body early (truncating real field names off the scanned
// text, a false negative) or late (pulling in unrelated trailing source, a potential false
// positive). `findMatchingBrace` below walks the source with a minimal string/template/comment-
// aware scanner so only braces that are actually code ever change `depth`. Regex literals are
// deliberately NOT special-cased: none of the roots this fence scans need this walker to skip
// over a regex containing a brace for the currently-known corpus, and doing so soundly needs a
// division-vs-regex disambiguation this fence has no need to carry — noted as a residual
// limitation rather than a silent gap (see the dedicated fence below).
function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0
  let i = openIndex
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i++
        }
        i++
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }
  return i
}

/** Every `z.object({`/`z.strictObject({`/`z.looseObject({` call's own balanced-brace body, PLUS
 * `.extend({`/`.merge({` chains off an existing schema [D-R105 R-2] — both grow a schema's field
 * set exactly like the base call does. */
function zodSchemaBodies(source: string): string[] {
  const bodies: string[] = []
  const callRe = /(?:z\.(?:strictObject|looseObject|object)|\.extend|\.merge)\(\s*\{/g
  let match: RegExpExecArray | null
  while ((match = callRe.exec(source))) {
    const start = match.index + match[0].length - 1 // position of the opening `{`
    const end = findMatchingBrace(source, start)
    bodies.push(source.slice(start, end + 1))
  }
  return bodies
}

type Offense = { file: string; field: string }

function findOffenses(): Offense[] {
  const offenses: Offense[] = []
  for (const root of ROOTS) {
    for (const file of listSourceFiles(root)) {
      if (ALLOWLISTED_FILES.has(file)) {
        continue
      }
      const source = readFileSync(file, 'utf-8')
      for (const body of zodSchemaBodies(source)) {
        const fieldMatch = body.match(FORBIDDEN_FIELD_RE)
        if (fieldMatch) {
          offenses.push({ file: file.slice(REPO_ROOT.length + 1), field: fieldMatch[1]! })
        }
      }
    }
  }
  return offenses
}

describe('D-R104 T44: no zod schema names launchAdmission/sequencedAgentLine/restoreProvenance', () => {
  it('the guard finds a non-empty set of zod schema bodies (matcher sanity)', () => {
    let total = 0
    for (const root of ROOTS) {
      for (const file of listSourceFiles(root)) {
        total += zodSchemaBodies(readFileSync(file, 'utf-8')).length
      }
    }
    expect(total).toBeGreaterThan(0)
  })

  it('no zod schema under rpc/methods, ipc, preload, relay, renderer, shared, or providers names any of the three fields', () => {
    expect(findOffenses()).toEqual([])
  })
})

describe('S10-21a C12, D-R105: the brace matcher is not fooled by a brace inside a string/template literal', () => {
  it('a lone unmatched `}` inside a STRING no longer closes the body early and silently drops a forbidden field after it', () => {
    // RED AT BASE (verified by hand against the pre-C12 walker, which counts every raw `{`/`}`
    // character): the string's stray `}` decrements `depth` to 0 immediately, so the walker
    // BREAKS right there -- `bodies[0]` ends mid-string, before `restoreProvenance:` ever
    // appears in the sliced text, and `findOffenses` would report NO offense for a schema that
    // plainly names the forbidden field. This is the exact "a schema body contains a brace-in-
    // string today" shape the C12 brief names.
    const source = `
      const schema = z.object({
        note: z.string().describe("closes early }"),
        restoreProvenance: z.literal('none')
      })
    `
    const bodies = zodSchemaBodies(source)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('restoreProvenance')
    expect(FORBIDDEN_FIELD_RE.test(bodies[0]!)).toBe(true)
  })

  it('a lone unmatched `}` inside a TEMPLATE literal does not close the body early (RED at base, same shape as the string case)', () => {
    const source = `
      const schema = z.object({
        note: z.string().describe(\`closes early }\`),
        sequencedAgentLine: z.string()
      })
    `
    const bodies = zodSchemaBodies(source)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('sequencedAgentLine')
  })

  it('a lone unmatched `}` inside a LINE COMMENT does not close the body early (RED at base, same shape as the string case)', () => {
    const source = `
      const schema = z.object({
        // a stray } in a comment
        launchAdmission: z.string()
      })
    `
    const bodies = zodSchemaBodies(source)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('launchAdmission')
  })
})
