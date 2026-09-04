import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why (INV-P-021, design v3.2 §2.2 clause 2): restore-ticket-registry.ts must be reachable
// in-process only — by the sweep (C7) and the rebind (C5), both under src/main/runtime — never
// from anything that terminates on a wire (RPC/IPC handlers) or the renderer. This resolves
// every import/require specifier (static or dynamic) under the forbidden roots and fails if any
// resolves to restore-ticket-registry.ts, mirroring src/cli/cli-import-boundary.test.ts's pattern.

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const TARGET_MODULE = resolve(REPO_ROOT, 'src', 'main', 'runtime', 'restore-ticket-registry.ts')
const FORBIDDEN_ROOTS = [
  resolve(REPO_ROOT, 'src', 'main', 'runtime', 'rpc'),
  resolve(REPO_ROOT, 'src', 'main', 'ipc'),
  resolve(REPO_ROOT, 'src', 'relay'),
  resolve(REPO_ROOT, 'src', 'renderer')
]

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(path)
    }
    return entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx')) ? [path] : []
  })
}

// Matches static `from '...'`/`require('...')` and dynamic `import('...')` specifiers, skipping
// `import type` (erased by tsc, ships no module at runtime — but this test treats a type-only
// import as an offense too, since even that would document a dependency this boundary forbids).
const IMPORT_SPECIFIER_RE =
  /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))/g

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && (candidate === base ? statSync(candidate).isFile() : true)) {
      return candidate
    }
  }
  return base
}

type Offense = { file: string; specifier: string }

function findOffenses(): Offense[] {
  const offenses: Offense[] = []
  for (const root of FORBIDDEN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (!specifier) {
          continue
        }
        const resolved = resolveSpecifier(file, specifier)
        if (resolved === TARGET_MODULE) {
          offenses.push({ file: file.slice(REPO_ROOT.length + 1), specifier })
        }
      }
    }
  }
  return offenses
}

describe('restore-ticket-registry import boundary (INV-P-021)', () => {
  it('the guard scans a non-empty set of forbidden-root files (matcher sanity)', () => {
    // Why: a broken FORBIDDEN_ROOTS path would make the assertion below vacuously pass.
    const totalFiles = FORBIDDEN_ROOTS.reduce((n, root) => n + listSourceFiles(root).length, 0)
    expect(totalFiles).toBeGreaterThan(0)
  })

  it('no module under rpc/**, ipc/**, relay/**, or renderer/** imports restore-ticket-registry', () => {
    expect(findOffenses()).toEqual([])
  })
})
