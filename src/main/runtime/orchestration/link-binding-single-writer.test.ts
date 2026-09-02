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
    const files = allProductionTsFiles('src/main/runtime')
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
