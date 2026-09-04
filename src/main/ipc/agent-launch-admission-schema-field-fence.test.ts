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
  resolve(REPO_ROOT, 'src', 'shared')
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

/** Every `z.object({`/`z.strictObject({`/`z.looseObject({` call's own balanced-brace body. */
function zodSchemaBodies(source: string): string[] {
  const bodies: string[] = []
  const callRe = /z\.(?:strictObject|looseObject|object)\(\s*\{/g
  let match: RegExpExecArray | null
  while ((match = callRe.exec(source))) {
    const start = match.index + match[0].length - 1 // position of the opening `{`
    let depth = 0
    let i = start
    for (; i < source.length; i++) {
      if (source[i] === '{') {
        depth++
      } else if (source[i] === '}') {
        depth--
        if (depth === 0) {
          break
        }
      }
    }
    bodies.push(source.slice(start, i + 1))
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

  it('no zod schema under rpc/methods, ipc, preload, relay, renderer, or shared names any of the three fields', () => {
    expect(findOffenses()).toEqual([])
  })
})
