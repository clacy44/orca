// S10-21d b3b (D-R163 M4 fix): registerAgentForPane now lives under runtime/orchestration/ (moved
// from runtime/rpc/methods/ — orca-runtime.ts, a core runtime module, was importing a wire-layer
// module for an in-process-only write with no caller-identity round-trip). This guard mirrors
// restore-ticket-registry-import-boundary.test.ts's pattern: the module must stay reachable only
// in-process (the runtime itself, and the one RPC method that still delegates to it for the wire
// path's OWN auth-then-write shape) — never directly from ipc/**, relay/**, or renderer/**, which
// would bypass both the runtime's own callers and reintroduce a wire-adjacent dependency.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const TARGET_MODULE = resolve(
  REPO_ROOT,
  'src',
  'main',
  'runtime',
  'orchestration',
  'register-agent-for-pane.ts'
)
const FORBIDDEN_ROOTS = [
  resolve(REPO_ROOT, 'src', 'main', 'ipc'),
  resolve(REPO_ROOT, 'src', 'relay'),
  resolve(REPO_ROOT, 'src', 'renderer')
]

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(path)
    }
    return entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx')) ? [path] : []
  })
}

const IMPORT_SPECIFIER_RE =
  /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))/g

function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }
  const base = resolve(fromFile, '..', specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return base
}

function findOffenses(): { file: string; specifier: string }[] {
  const offenses: { file: string; specifier: string }[] = []
  for (const root of FORBIDDEN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (!specifier) {
          continue
        }
        if (resolveRelativeSpecifier(file, specifier) === TARGET_MODULE) {
          offenses.push({ file: file.slice(REPO_ROOT.length + 1), specifier })
        }
      }
    }
  }
  return offenses
}

describe('register-agent-for-pane import boundary (D-R163 M4)', () => {
  it('the guard scans a non-empty set of forbidden-root files (matcher sanity)', () => {
    const totalFiles = FORBIDDEN_ROOTS.reduce((n, root) => n + listSourceFiles(root).length, 0)
    expect(totalFiles).toBeGreaterThan(0)
  })

  it('no module under ipc/**, relay/**, or renderer/** imports register-agent-for-pane', () => {
    expect(findOffenses()).toEqual([])
  })
})
