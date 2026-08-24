/**
 * Release-audit T1 (S9, B1/B3): a static guard against exactly the failure mode the audit found —
 * a lane module exporting `attachX`/`startX` that nothing in production ever calls, so the class
 * it wires stays permanently unattached and every method behind it either refuses by name or
 * silently no-ops. `attachLaneWireService` (B1) was that shape until this stage's composition
 * (`lane-wire-composition.ts`) gave it a production caller; this test is what keeps it that way,
 * and what will fail loudly the moment another `attach*`/`start*` seam regresses the same way.
 *
 * KNOWN_OPEN_GAPS lists the seams the audit found in this same pass that are NOT yet composed in
 * production. Removing an entry from that list, rather than adding to it, is the only correct fix
 * for a new failure here. B3 (`attachLaneDelegationLeaseStore`) closed this stage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_MAIN = join(process.cwd(), 'src/main')

/** Tracked, audited gaps — composition work for a later stage, not a regression. Currently empty. */
const KNOWN_OPEN_GAPS = new Set<string>()

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) {
      continue
    }
    files.push(path)
  }
  return files
}

const ALL_MAIN_FILES = listSourceFiles(SRC_MAIN)
const LANE_MODULE_FILES = ALL_MAIN_FILES.filter((path) => /lane/i.test(path))

type ExportedSeam = { name: string; file: string }

function laneAttachStartExports(): ExportedSeam[] {
  const seams: ExportedSeam[] = []
  // `set*Dependencies` is included alongside `attach*`/`start*`: T1's own mutation proof found
  // that deleting the production call to `setLaneWireHostDependencies` (B1's actual fix) left
  // every other guard green, because a `set*` provider is invisible to the narrower pattern.
  const pattern = /^export\s+(?:async\s+)?function\s+(attach\w+|start\w+|set\w*Dependencies)\s*\(/gm
  for (const file of LANE_MODULE_FILES) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) {
      seams.push({ name: match[1]!, file })
    }
  }
  return seams
}

function hasNonTestProductionCaller(seam: ExportedSeam): boolean {
  const callPattern = new RegExp(`\\b${seam.name}\\s*\\(`)
  for (const file of ALL_MAIN_FILES) {
    const source = readFileSync(file, 'utf8')
    for (const line of source.split('\n')) {
      if (!callPattern.test(line)) {
        continue
      }
      // Skip the export's own declaration line, and re-exports (`export { attachX }`).
      if (/^export\s+(?:async\s+)?function\s+/.test(line.trim())) {
        continue
      }
      if (/^export\s*\{/.test(line.trim())) {
        continue
      }
      return true
    }
  }
  return false
}

describe('lane composition parity (release-audit T1)', () => {
  const seams = laneAttachStartExports()

  it('found at least the seams this test exists to guard', () => {
    // A canary: if the lane-module scan starts finding nothing, the test is vacuously passing.
    const names = seams.map((seam) => seam.name)
    expect(names).toContain('attachLaneWireService')
    expect(names).toContain('attachPrincipalLaneConsentService')
    expect(names).toContain('attachManagedAccountResidencyGuard')
    expect(names).toContain('setLaneWireHostDependencies')
  })

  it.each(seams.map((seam) => [seam.name, seam] as const))(
    '%s has a non-test caller under src/main, or is a tracked open gap',
    (_name, seam) => {
      if (KNOWN_OPEN_GAPS.has(seam.name)) {
        // Tracked, not silently exempted: still assert it is genuinely still open, so this entry
        // is deleted the moment the gap is closed instead of rotting into a permanent bypass.
        expect(hasNonTestProductionCaller(seam)).toBe(false)
        return
      }
      expect(hasNonTestProductionCaller(seam)).toBe(true)
    }
  )

  it('lists no gap that is not actually a lane attach/start export', () => {
    const names = new Set(seams.map((seam) => seam.name))
    for (const gap of KNOWN_OPEN_GAPS) {
      expect(names.has(gap)).toBe(true)
    }
  })
})
