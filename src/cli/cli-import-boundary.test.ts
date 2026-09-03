import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Ruling 29 — CLI import boundary (2026-09-03, from the D-B13 packaging failure). No file under
// src/cli imports from src/main: electron-builder does not ship src/main under the CLI's
// packaged path, so any such import is a packaging-time crash that main-module-bundle-parity.test.ts
// (an electron-vite-entry check) cannot see — it only proves the module is bundled somewhere, not
// that the CLI's own packaged closure carries it. This test resolves every import/require
// specifier (static or dynamic) in non-test src/cli source and fails if any resolves under
// src/main.

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_ROOT = join(REPO_ROOT, 'src', 'cli')
const MAIN_ROOT = join(REPO_ROOT, 'src', 'main')

// Pre-existing offenders that predate C8e (S10-16 Ruling 29 return, filed against
// s10-15-chair-rulings.md RULING 29): moving these is a real refactor of working
// business logic (OS keychain access, managed-agent-hook filesystem writes, the
// cross-host agent resolver), not a constants-only move, so C8e leaves them in
// place and grandfathers them here rather than silently widening scope or
// weakening this test to not catch new offenses of the same shape. Removing an
// entry here (by fixing the underlying import) is welcome; adding one requires a
// ruling.
const GRANDFATHERED_OFFENDERS: Record<string, string[]> = {
  'src/cli/handlers/account.ts': ['../../main/claude-accounts/keychain'],
  'src/cli/handlers/agent-hooks.ts': ['../../main/agent-hooks/managed-agent-hook-controls'],
  'src/cli/handlers/agents-cross-host.ts': [
    '../../main/runtime/orchestration/agent-resolver',
    '../../main/runtime/orchestration/agent-name-sanitizer'
  ]
}

function listCliSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listCliSourceFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

// Matches static `from '...'`/`require('...')` and dynamic `import('...')` specifiers, skipping
// `import type` (erased by tsc, ships no module at runtime).
const IMPORT_SPECIFIER_RE =
  /(?<!\btype\s)(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))/g

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    // Bare/package specifiers never resolve under src/main.
    return null
  }
  const base = resolve(dirname(fromFile), specifier)
  // The specifier is extensionless in source; probe the shapes tsc/node16 resolution allows.
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && (candidate === base ? statSync(candidate).isFile() : true)) {
      return candidate
    }
  }
  // Even if the file doesn't exist on disk (shouldn't happen for real source), still
  // classify by path shape so the guard cannot be defeated by a missing extension probe.
  return base
}

type Offense = { file: string; specifier: string; resolved: string }

function findMainOffenses(): Offense[] {
  const offenses: Offense[] = []
  for (const file of listCliSourceFiles(CLI_ROOT)) {
    const source = readFileSync(file, 'utf-8')
    const relFile = file.slice(REPO_ROOT.length + 1)
    for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      if (!specifier) {
        continue
      }
      const resolved = resolveSpecifier(file, specifier)
      if (!resolved) {
        continue
      }
      if (resolved === MAIN_ROOT || resolved.startsWith(`${MAIN_ROOT}/`)) {
        offenses.push({ file: relFile, specifier, resolved })
      }
    }
  }
  return offenses
}

describe('CLI never imports main (Ruling 29)', () => {
  it('finds the imports it is meant to guard (matcher sanity)', () => {
    // Why: a broken matcher would make the assertions below vacuously pass. The
    // grandfathered offenders below are known-present at HEAD, so the raw offense
    // count (before filtering) must be at least that many.
    const totalGrandfathered = Object.values(GRANDFATHERED_OFFENDERS).reduce(
      (n, specs) => n + specs.length,
      0
    )
    expect(findMainOffenses().length).toBeGreaterThanOrEqual(totalGrandfathered)
  })

  it('no non-grandfathered src/cli file imports from src/main', () => {
    const unexpected = findMainOffenses().filter(({ file, specifier }) => {
      const allowed = GRANDFATHERED_OFFENDERS[file]
      return !(allowed && allowed.includes(specifier))
    })
    expect(unexpected).toEqual([])
  })

  it('every grandfathered offender is still present and still needed (no stale allowlist entries)', () => {
    for (const [file, specifiers] of Object.entries(GRANDFATHERED_OFFENDERS)) {
      const absFile = join(REPO_ROOT, file)
      const source = existsSync(absFile) ? readFileSync(absFile, 'utf-8') : ''
      for (const specifier of specifiers) {
        expect(source.includes(specifier)).toBe(true)
      }
    }
  })
})
