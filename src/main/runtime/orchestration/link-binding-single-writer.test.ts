// S10-16 C4: grep-based structural proof that `peer_link_bindings` has exactly ONE writer in
// production — `putPeerLinkBinding` — called from exactly one call site (the round settle,
// link-binding-prover-settle.ts), never from any RPC handler (confirm/probe never write it).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '../../../..')

function allProductionTsFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir)
  const out: string[] = []
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...allProductionTsFiles(join(dir, entry.name)))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

describe('peer_link_bindings has exactly one writer (R14.2/Ruling 17(a))', () => {
  it('db.putPeerLinkBinding is called from exactly one production call site: the round settle', () => {
    const files = allProductionTsFiles('src/main')
    const callers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      // Match a CALL (`.putPeerLinkBinding(`), not the method's own declaration inside db.ts/
      // link-binding-store.ts (a `function putPeerLinkBinding(` or `putPeerLinkBinding(row...):`
      // signature line never has a preceding `.`).
      if (
        /[.)]\s*putPeerLinkBinding\s*\(/.test(source) ||
        /\bdb\.putPeerLinkBinding\s*\(/.test(source)
      ) {
        callers.push(file)
      }
    }
    expect(callers).toEqual(['src/main/runtime/link-binding-prover-settle.ts'])
  })

  // F11: the qualified-call regex above requires a preceding `.` or `)` — a module that imports
  // `putPeerLinkBinding` directly and calls it BARE-WORD (`putPeerLinkBinding(row)`, no receiver)
  // matches neither assertion above nor the SQL-text scan below. Excludes the two definition
  // sites (the raw function declaration and the DB wrapper's own method declaration), which are
  // themselves bare-word by construction and are not calls.
  it('no bare-word (unqualified) call site bypasses the qualified-call scan', () => {
    const definitionFiles = new Set([
      'src/main/runtime/orchestration/link-binding-store.ts',
      'src/main/runtime/orchestration/db.ts'
    ])
    const files = allProductionTsFiles('src/main').filter((f) => !definitionFiles.has(f))
    const bareWordRe = /(?<![\w.$])putPeerLinkBinding\s*\(/
    const bareCallers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (bareWordRe.test(source)) {
        bareCallers.push(file)
      }
    }
    expect(bareCallers).toEqual([])
  })

  it('the SQL INSERT/UPDATE into peer_link_bindings lives in exactly two places: the store (the proof writer) and the R14.4 fail-closed repair (revoke-only, schema-completeness only)', () => {
    // Ruling 23 Addendum 4(hh)/review C4b finding 12: rooted at `src/main` (was `src/main/
    // runtime`), matching the two call-site scans above — a new `src/main/ipc` writer must not
    // evade this assertion the way it could evade the narrower root.
    const files = allProductionTsFiles('src/main')
    const writers: string[] = []
    for (const file of files) {
      if (file.endsWith('.test.ts')) {
        continue
      }
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (/INSERT INTO peer_link_bindings|UPDATE peer_link_bindings/.test(source)) {
        writers.push(file)
      }
    }
    // db.ts's own occurrence is R14.4's unshipped-v40 repair (`link_binding_unshipped_v40_repair`)
    // — it ONLY ever sets state='revoked'/revoked_at on a schema-incomplete row at migration time,
    // never any proof field. It is a documented, narrowly-scoped exception to "one writer", not a
    // second proof writer — confirmed by the next assertion.
    expect(writers.sort()).toEqual(
      [
        'src/main/runtime/orchestration/db.ts',
        'src/main/runtime/orchestration/link-binding-store.ts'
      ].sort()
    )
    const dbSource = readFileSync(join(REPO_ROOT, 'src/main/runtime/orchestration/db.ts'), 'utf8')
    expect(dbSource).toContain('link_binding_unshipped_v40_repair')
    expect(dbSource).not.toMatch(/UPDATE peer_link_bindings SET[^;]*environment_id\s*=/)
  })

  // Ruling 23 Addendum 4(hh)/review C4b finding 12: the qualified-call and bare-word regexes
  // above both require the literal identifier `putPeerLinkBinding` at the call site — an aliased
  // import (`import { putPeerLinkBinding as writeBinding }` then `writeBinding(...)`) or a
  // dynamic `import('.../link-binding-store').then(m => m.putPeerLinkBinding(...))` evades both.
  // This catches the import itself: ANY production file (other than the definition site) that
  // mentions both the symbol name and the module is flagged, regardless of call syntax.
  it('putPeerLinkBinding is imported (any alias, any import form) only by its definition site (db.ts)', () => {
    const files = allProductionTsFiles('src/main').filter(
      (f) => f !== 'src/main/runtime/orchestration/link-binding-store.ts'
    )
    const importers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (/\bputPeerLinkBinding\b/.test(source) && /link-binding-store/.test(source)) {
        importers.push(file)
      }
    }
    expect(importers).toEqual(['src/main/runtime/orchestration/db.ts'])
  })

  // Ruling 23 Addendum 6(uu)/review C4d finding 4: `peer_link_bindings` now has TWO writers —
  // `putPeerLinkBinding` (pinned above) and `contestPeerLinkBinding` (new in C4d). Mirrors the
  // three assertions above for the second writer, pinned to the same sole caller.
  it('db.contestPeerLinkBinding is called from exactly one production call site: the round settle', () => {
    const files = allProductionTsFiles('src/main')
    const callers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (
        /[.)]\s*contestPeerLinkBinding\s*\(/.test(source) ||
        /\bdb\.contestPeerLinkBinding\s*\(/.test(source)
      ) {
        callers.push(file)
      }
    }
    expect(callers).toEqual(['src/main/runtime/link-binding-prover-settle.ts'])
  })

  it('no bare-word (unqualified) call site bypasses the qualified-call scan for contestPeerLinkBinding', () => {
    const definitionFiles = new Set([
      'src/main/runtime/orchestration/link-binding-store.ts',
      'src/main/runtime/orchestration/db.ts'
    ])
    const files = allProductionTsFiles('src/main').filter((f) => !definitionFiles.has(f))
    const bareWordRe = /(?<![\w.$])contestPeerLinkBinding\s*\(/
    const bareCallers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (bareWordRe.test(source)) {
        bareCallers.push(file)
      }
    }
    expect(bareCallers).toEqual([])
  })

  it('contestPeerLinkBinding is imported (any alias, any import form) only by its definition site (db.ts)', () => {
    const files = allProductionTsFiles('src/main').filter(
      (f) => f !== 'src/main/runtime/orchestration/link-binding-store.ts'
    )
    const importers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (/\bcontestPeerLinkBinding\b/.test(source) && /link-binding-store/.test(source)) {
        importers.push(file)
      }
    }
    expect(importers).toEqual(['src/main/runtime/orchestration/db.ts'])
  })

  // Ruling 28(a)/(h) (C8a): a THIRD, differently-shaped writer — `resolvePeerLinkBindingContest`,
  // the one write licensed to clear an existing contest (the operator's forced `proveNow` round).
  it('db.resolvePeerLinkBindingContest is called from exactly one production call site: the round settle', () => {
    const files = allProductionTsFiles('src/main')
    const callers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (
        /[.)]\s*resolvePeerLinkBindingContest\s*\(/.test(source) ||
        /\bdb\.resolvePeerLinkBindingContest\s*\(/.test(source)
      ) {
        callers.push(file)
      }
    }
    expect(callers).toEqual(['src/main/runtime/link-binding-prover-settle.ts'])
  })

  it('resolvePeerLinkBindingContest is imported (any alias, any import form) only by its definition site (db.ts)', () => {
    const files = allProductionTsFiles('src/main').filter(
      (f) => f !== 'src/main/runtime/orchestration/link-binding-store.ts'
    )
    const importers: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (/\bresolvePeerLinkBindingContest\b/.test(source) && /link-binding-store/.test(source)) {
        importers.push(file)
      }
    }
    expect(importers).toEqual(['src/main/runtime/orchestration/db.ts'])
  })

  // Ruling 28(h): pins C7's two mutators (`revokePeerLinkBinding`, `deleteBindingsAndAttemptsIn`
  // — the renamed inclusion-based purge) plus C8a's own `unrevokePeerLinkBinding`, all reachable
  // from exactly one production module: the local RPC surface.
  it('revokePeerLinkBinding, unrevokePeerLinkBinding and deleteBindingsAndAttemptsIn are called from exactly one production call site: the local RPC surface', () => {
    const files = allProductionTsFiles('src/main')
    for (const symbol of [
      'revokePeerLinkBinding',
      'unrevokePeerLinkBinding',
      'deleteBindingsAndAttemptsIn'
    ]) {
      const callers: string[] = []
      const callRe = new RegExp(`[.)]\\s*${symbol}\\s*\\(|\\bdb\\.${symbol}\\s*\\(`)
      for (const file of files) {
        if (file.endsWith('link-binding-store.ts') || file.endsWith('/db.ts')) {
          continue
        }
        const source = readFileSync(join(REPO_ROOT, file), 'utf8')
        if (callRe.test(source)) {
          callers.push(file)
        }
      }
      expect(callers).toEqual(['src/main/runtime/rpc/methods/orchestration-link-binding-local.ts'])
    }
  })

  it('no RPC handler (probe/confirm) ever calls putPeerLinkBinding — confirm writes advisory only (R7.5)', () => {
    const probe = readFileSync(
      join(REPO_ROOT, 'src/main/runtime/rpc/methods/orchestration-link-binding-probe.ts'),
      'utf8'
    )
    const confirm = readFileSync(
      join(REPO_ROOT, 'src/main/runtime/rpc/methods/orchestration-link-binding-confirm.ts'),
      'utf8'
    )
    expect(probe.includes('putPeerLinkBinding')).toBe(false)
    expect(confirm.includes('putPeerLinkBinding')).toBe(false)
  })
})
