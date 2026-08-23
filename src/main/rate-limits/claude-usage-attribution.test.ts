/**
 * S9 §2k — the statusline attribution map: paneKey → lane, config dir second, drop third, and an
 * opaque provenance on every peer-readable row.
 */
import { describe, expect, it } from 'vitest'
import {
  ClaudeUsageAttributionMap,
  REDACTED_LANE_PROVENANCE,
  publishedAuthProvenance,
  type ClaudeLaneUsageAttribution
} from './claude-usage-attribution'

const LANE_A = '11111111-1111-4111-8111-111111111111'
const LANE_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = 'tab-a:33333333-3333-4333-8333-333333333333'
const PANE_B = 'tab-b:44444444-4444-4444-8444-444444444444'
const LABEL_A = 'a'.repeat(32)
const LABEL_B = 'b'.repeat(32)

function laneRow(laneId: string, configDir: string, label: string): ClaudeLaneUsageAttribution {
  return {
    laneId,
    configDir,
    provenance: `lane:${label}`
  }
}

function mapWithTwoLanes(): ClaudeUsageAttributionMap {
  const map = new ClaudeUsageAttributionMap()
  map.rememberSharedLane('/home/dev/.claude', 'managed:acct-1:host')
  map.rememberLanes([
    laneRow(LANE_A, `/data/claude-lanes/${LANE_A}`, LABEL_A),
    laneRow(LANE_B, `/data/claude-lanes/${LANE_B}`, LABEL_B)
  ])
  map.setPaneLaneLookup((paneKey) =>
    paneKey === PANE_A ? { laneId: LANE_A } : paneKey === PANE_B ? { laneId: null } : null
  )
  return map
}

describe('ClaudeUsageAttributionMap', () => {
  it("lands a post carrying lane A's paneKey on A's row, not on the shared bar", () => {
    const attributed = mapWithTwoLanes().attribute({
      paneKey: PANE_A,
      // The posted dir is the SHARED one — a stale inherited env, the case the paneKey key exists
      // to beat. The pane binding wins and the row is still lane A's.
      configDir: '/home/dev/.claude'
    })

    expect(attributed?.laneId).toBe(LANE_A)
    expect(attributed?.provenance).toBe(`lane:${LABEL_A}`)
  })

  it('attributes a shared-lane pane to the shared row', () => {
    expect(mapWithTwoLanes().attribute({ paneKey: PANE_B, configDir: null })?.laneId).toBeNull()
  })

  it('falls back to the config-dir map when the paneKey names no known pane', () => {
    const attributed = mapWithTwoLanes().attribute({
      paneKey: 'tab-z:55555555-5555-4555-8555-555555555555',
      configDir: `/data/claude-lanes/${LANE_B}`
    })

    expect(attributed?.laneId).toBe(LANE_B)
  })

  // Negative control: the whole point of the map is that a dir it does not know stays dropped.
  it('drops a post whose config dir is unknown and whose pane is unknown', () => {
    expect(mapWithTwoLanes().attribute({ paneKey: null, configDir: '/somewhere/else' })).toBeNull()
    expect(mapWithTwoLanes().attribute({ configDir: null })).toBeNull()
  })

  it('matches a system-default post against a shared row that has no config dir', () => {
    const map = new ClaudeUsageAttributionMap()
    map.rememberSharedLane(null, 'system')

    expect(map.attribute({ configDir: null })?.provenance).toBe('system')
  })

  it('drops a post from a pane whose lane has no loaded row', () => {
    const map = mapWithTwoLanes()
    map.rememberLanes([laneRow(LANE_B, `/data/claude-lanes/${LANE_B}`, LABEL_B)])

    // Lane A was wiped between ticks: its post is dropped, never redirected to the shared bar.
    expect(map.attribute({ paneKey: PANE_A, configDir: '/home/dev/.claude' })).toBeNull()
  })

  it('normalizes separators and trailing slashes on the config-dir key', () => {
    const map = new ClaudeUsageAttributionMap()
    map.rememberLanes([laneRow(LANE_A, `C:\\lanes\\${LANE_A}`, LABEL_A)])

    expect(map.attribute({ configDir: `C:/lanes/${LANE_A}/` })?.laneId).toBe(LANE_A)
  })

  it('stops attributing to the shared lane once the account switch clears it', () => {
    const map = mapWithTwoLanes()
    map.clearSharedLane()

    expect(map.attribute({ paneKey: PANE_B, configDir: '/home/dev/.claude' })).toBeNull()
    expect(map.attribute({ paneKey: PANE_A, configDir: null })?.laneId).toBe(LANE_A)
  })
})

describe('publishedAuthProvenance', () => {
  it('publishes the opaque lane label unchanged', () => {
    expect(publishedAuthProvenance(laneRow(LANE_A, '/lane', LABEL_A))).toBe(`lane:${LABEL_A}`)
  })

  // Mutation-proof anchor: this row is peer-readable, so a provenance carrying the principalId or
  // the lane path must never reach it (§2a, §2k).
  it('redacts a lane provenance that carries a principal id or a path', () => {
    for (const provenance of [
      `lane:${LANE_A}`,
      `lane:${LABEL_A}:${LANE_A}`,
      `lane:/data/claude-lanes/${LANE_A}`,
      `managed:${LANE_A}:inactive-preview`,
      'lane:'
    ]) {
      const published = publishedAuthProvenance({ provenance, laneId: LANE_A })
      expect(published).toBe(REDACTED_LANE_PROVENANCE)
      expect(published).not.toContain(LANE_A)
    }
  })

  it('leaves the shared lane provenance alone', () => {
    expect(publishedAuthProvenance({ provenance: 'managed:acct-1:host', laneId: null })).toBe(
      'managed:acct-1:host'
    )
  })
})
