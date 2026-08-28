import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUnverifiedLegacyLane } from './lane-legacy-provenance'
import { writeLaneAccountIndex } from './lane-account-index'

/** §6's S9-L3 migration fixture: a lane loaded by a pre-per-lane-login push (like the live VPS
 * lane), holding `.credentials.json` but never having written `claude-accounts/index.json`. */
function plantLegacyLane(laneDir: string): void {
  mkdirSync(laneDir, { recursive: true })
  writeFileSync(
    join(laneDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
  )
}

describe('isUnverifiedLegacyLane (S9 design §6 S9-L3 migration)', () => {
  it('a lane with a credential and no index.json is unverified-legacy', () => {
    const laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-legacy-'))
    try {
      plantLegacyLane(laneDir)
      expect(isUnverifiedLegacyLane(laneDir)).toBe(true)
    } finally {
      rmSync(laneDir, { recursive: true, force: true })
    }
  })

  it('a lane with no credential at all is not legacy — it is simply absent', () => {
    const laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-legacy-'))
    try {
      mkdirSync(laneDir, { recursive: true })
      expect(isUnverifiedLegacyLane(laneDir)).toBe(false)
    } finally {
      rmSync(laneDir, { recursive: true, force: true })
    }
  })

  // The first successful lane login writes the index (§storeLayout ordering (2)) — the ordinary
  // capture path is what "replaces" the legacy blob; this asserts that write alone flips the flag.
  it('a lane whose first login has captured (index.json now exists) is no longer legacy', () => {
    const laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-legacy-'))
    try {
      plantLegacyLane(laneDir)
      expect(isUnverifiedLegacyLane(laneDir)).toBe(true)

      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [
        {
          laneAccountId: '11111111-1111-4111-8111-111111111111',
          email: 'a@x.com',
          label: null,
          active: true,
          capturedAt: new Date().toISOString()
        }
      ])

      expect(isUnverifiedLegacyLane(laneDir)).toBe(false)
    } finally {
      rmSync(laneDir, { recursive: true, force: true })
    }
  })

  // MP: dropping the `isLaneLoaded` guard would flag every fresh, never-logged-in lane (index
  // absent because nothing has ever run there) as "legacy" instead of merely `absent`.
  it('MP: without the isLaneLoaded guard, an unloaded lane would be misread as legacy', () => {
    const laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-legacy-'))
    try {
      mkdirSync(laneDir, { recursive: true })
      // No `.credentials.json` planted — index.json is also missing, matching the mutated
      // (guardless) predicate's condition, so this fixture is exactly what the guard exists for.
      expect(isUnverifiedLegacyLane(laneDir)).toBe(false)
    } finally {
      rmSync(laneDir, { recursive: true, force: true })
    }
  })
})
