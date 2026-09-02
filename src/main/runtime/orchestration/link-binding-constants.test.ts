import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as constants from './link-binding-constants'

// S10-16 chair briefing §0 decision 1 / Ruling 23(i): test 77, REWRITTEN as a repository test over
// code rather than a grep over the design document (Ruling 23's option B — "a fact cannot be
// stated two ways in a running test suite"). link-binding-constants.ts is THE REGISTER; no other
// file in the slice's own surface may write a numeric literal or duplicate one of its unions.

const REPO_ROOT = join(import.meta.dirname, '../../../..')

function tsFilesMatching(dir: string, prefix: string): string[] {
  const abs = join(REPO_ROOT, dir)
  if (!existsSync(abs)) {
    return []
  }
  return readdirSync(abs)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(abs, f))
}

// The exact surface Ruling 23(i)/chair briefing §0 names — NOT `reply-outbox-*` (a plan scoping
// choice, recorded in the C2 return rather than silently widened by the implementer).
function registeredSurfaceFiles(): string[] {
  const files = [
    ...tsFilesMatching('src/main/runtime/orchestration', 'link-binding-'),
    ...tsFilesMatching('src/main/runtime/rpc/methods', 'orchestration-link-binding-')
  ]
  const health = join(REPO_ROOT, 'src/shared/link-binding-health.ts')
  const cli = join(REPO_ROOT, 'src/cli/handlers/environment-link-binding.ts')
  if (existsSync(health)) {
    files.push(health)
  }
  if (existsSync(cli)) {
    files.push(cli)
  }
  // link-binding-constants.ts IS the register — excluded from the ban.
  return files.filter((f) => !f.endsWith('link-binding-constants.ts'))
}

// Strips // line comments and /* */ block comments so a comment mentioning "v40" or "R14.1"
// never false-positives.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// C2 delta D1: the prior strip removed whole regex-literal bodies and whole `new RegExp(...)`
// argument lists, which is unforced — C3's patterns are all built by interpolating THE REGISTER's
// own constants (`link-binding-proof.ts:20-21,27-29`: `new RegExp(\`^[0-9a-f]{${LINK_BINDING_HEX32_LENGTH}}$\`)`),
// and simulating the whole surface with and without the wide strip found zero hits either way — so
// the wide strip protected nothing that exists while disarming the guard against exactly the
// literal-quantifier shape (`{32}`, `{1,3}`) the rule exists to catch. F12's recommendation, taken
// literally: strip ONLY `{n}`/`{n,m}` quantifiers, everywhere in the source, not whole regex
// bodies — so a literal `{32}` restating LINK_BINDING_HEX32_LENGTH still can never hide inside a
// regex, in or out of a pattern.
function stripRegexContexts(source: string): string {
  return source.replace(/\{\d+(,\d*)?\}/g, '{}')
}

// Numeric literals this rule is about: multi-digit integers (tuning values, TTLs, caps) and
// underscore-grouped numeric literals (1_000 style). Single digits (0, 1, 2 as loop/array
// indices, exponents, etc.) are not the L-2 class this test guards and would false-positive on
// ordinary code.
const NUMERIC_LITERAL_RE = /\b\d[\d_]{1,}\b/g

describe('link-binding-constants.ts is THE REGISTER (test 77, rewritten)', () => {
  const files = registeredSurfaceFiles()

  it('found at least the files that exist today (health module, binding-side stores)', () => {
    // Sanity: the test must not silently match zero files (which would make every assertion
    // below vacuous). C3/C4/C6/C7 files are expected to appear as later commits land.
    expect(files.some((f) => f.endsWith('link-binding-health.ts'))).toBe(true)
  })

  it.each(files.map((f) => [f.slice(REPO_ROOT.length + 1), f]))(
    '%s writes no numeric literal outside link-binding-constants.ts',
    (_label, file) => {
      const code = stripRegexContexts(stripComments(readFileSync(file, 'utf8')))
      const hits = code.match(NUMERIC_LITERAL_RE) ?? []
      expect(hits).toEqual([])
    }
  )

  it('the register re-exports base-tree constants rather than redeclaring them (F4 class)', () => {
    // MAX_LIVE_MINTED_GRANTS / PENDING_GRANT_TTL_MS are owned by device-registry-pending-grants.ts
    // (base tree, pre-S10-16) — the register must `export { NAME } from '...'`, never restate
    // `export const NAME = ...`, or the two definition sites can drift silently (F4).
    const baseTreeFile = join(REPO_ROOT, 'src/main/runtime/device-registry-pending-grants.ts')
    const baseSource = stripComments(readFileSync(baseTreeFile, 'utf8'))
    const baseNames = [...baseSource.matchAll(/^export const (\w+)/gm)].map((m) => m[1])
    expect(baseNames.length).toBeGreaterThan(0)

    const registerFile = join(REPO_ROOT, 'src/main/runtime/orchestration/link-binding-constants.ts')
    const registerSource = stripComments(readFileSync(registerFile, 'utf8'))
    for (const name of baseNames) {
      const redeclared = new RegExp(`export const ${name}\\b`).test(registerSource)
      expect(redeclared).toBe(false)
    }
    // And the register must actually still expose them (as a re-export), so nothing silently
    // dropped the import while satisfying the redeclaration check above.
    expect(constants).toHaveProperty('MAX_LIVE_MINTED_GRANTS')
    expect(constants).toHaveProperty('PENDING_GRANT_TTL_MS')
  })

  it('LinkBindingHealth precedence is total over the twenty-member union (no drift between the two lists)', async () => {
    const health = await import('../../../shared/link-binding-health')
    expect(health.LINK_BINDING_HEALTH_PRECEDENCE).toHaveLength(20)
    expect(new Set(health.LINK_BINDING_HEALTH_PRECEDENCE).size).toBe(20)
  })

  it('the A2 reset-exempt / never-dropped / drop-and-recreate lists are disjoint and complete', () => {
    // Membership, not length (F9/MOD2) — a length assertion cannot see a table swapped for a
    // wrong one of the same count.
    expect(new Set(constants.A2_RESET_EXEMPT_TABLES)).toEqual(
      new Set([
        'peer_link_bindings',
        'peer_link_attempts',
        'peer_link_scan_facts',
        'peer_link_containment'
      ])
    )
    expect(new Set(constants.A2_NEVER_DROPPED_TABLES)).toEqual(
      new Set(['peer_link_bindings', 'peer_link_containment', 'peer_reply_outbox'])
    )
    expect(new Set(constants.A2_DROP_AND_RECREATE_TABLES)).toEqual(
      new Set(['peer_link_attempts', 'peer_link_scan_facts', 'peer_link_confirm_observations'])
    )
    const all = [...constants.A2_NEVER_DROPPED_TABLES, ...constants.A2_DROP_AND_RECREATE_TABLES]
    expect(new Set(all).size).toBe(6)
    // Disjoint: no table is both never-dropped and drop-and-recreate.
    const neverDropped = new Set<string>(constants.A2_NEVER_DROPPED_TABLES)
    for (const table of constants.A2_DROP_AND_RECREATE_TABLES) {
      expect(neverDropped.has(table)).toBe(false)
    }
  })

  it('FEDERATED_ASK_RATE_LIMIT is the Ruling 23(f) derived value, 64', () => {
    expect(constants.FEDERATED_ASK_RATE_LIMIT).toBe(64)
  })
})
