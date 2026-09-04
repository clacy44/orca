// S10-21a C6c (Ruling 34 Addendum 20(c)): a mechanical fence — greps every audit verb literal
// this surface actually writes and asserts each is present in the ONE shared
// `ADMISSION_AUDIT_VERBS` constant agent-lineage-mismatch.ts's unrecorded_launch downgrade
// consumes (D-R108 R1(a)). A verb added here without updating the constant fails this test
// rather than silently escaping the downgrade's enumeration.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMISSION_AUDIT_VERBS } from './agent-launch-admission-support'

const HERE = __dirname

function readSource(relativePath: string): string {
  return readFileSync(join(HERE, relativePath), 'utf8')
}

describe('S10-21a C6c: ADMISSION_AUDIT_VERBS enumerates every admission audit verb literal', () => {
  it('every `audit(db, ...)` call in agent-launch-admission*.ts uses a verb from the constant', () => {
    const files = [
      'agent-launch-admission.ts',
      'agent-launch-admission-lock.ts',
      'agent-launch-admission-support.ts',
      'agent-launch-admission-errors.ts',
      'agent-launch-classification.ts'
    ]
    const found = new Set<string>()
    for (const file of files) {
      let source: string
      try {
        source = readSource(file)
      } catch {
        continue // not every candidate file need exist; skip absent ones
      }
      // `audit(db, <paneKeyExpr>, <hostIdExpr>, 'VERB', ...)` — the verb is always the fourth
      // positional argument, a plain string literal.
      const pattern = /\baudit\(\s*db,\s*[^,]+,\s*[^,]+,\s*'([a-z_]+)'/g
      for (const match of source.matchAll(pattern)) {
        found.add(match[1])
      }
    }
    expect(found.size).toBeGreaterThan(0)
    for (const verb of found) {
      expect(ADMISSION_AUDIT_VERBS as readonly string[]).toContain(verb)
    }
  })

  it("pty.ts's contestedLineage writeAgentAudit call uses a verb from the constant", () => {
    const source = readFileSync(join(HERE, 'pty.ts'), 'utf8')
    const contestedLineageStart = source.indexOf('contestedLineage: (claimantPaneKey')
    expect(contestedLineageStart).toBeGreaterThan(-1)
    // Scope the search to the contestedLineage closure body only, not the whole 8000+ line file.
    const closureBody = source.slice(contestedLineageStart, contestedLineageStart + 2000)
    const match = closureBody.match(/verb:\s*'([a-z_]+)'/)
    expect(match).not.toBeNull()
    expect(ADMISSION_AUDIT_VERBS as readonly string[]).toContain(match![1])
  })

  it('the constant itself is non-empty and has no duplicate entries', () => {
    expect(ADMISSION_AUDIT_VERBS.length).toBeGreaterThan(0)
    expect(new Set(ADMISSION_AUDIT_VERBS).size).toBe(ADMISSION_AUDIT_VERBS.length)
  })
})
