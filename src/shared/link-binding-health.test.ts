import { describe, expect, it } from 'vitest'
import * as linkBindingHealth from './link-binding-health'
import {
  LINK_BINDING_HEALTH_PRECEDENCE,
  LINK_BINDING_UNAVAILABLE_REASONS,
  LINK_BINDING_ATTENTION_HEALTH,
  worstLinkBindingHealth,
  renderLinkBindingHealth,
  type LinkBindingHealth
} from './link-binding-health'

// S10-16 design v6 test 75 (★ TOTALITY, lifecycle M3/protocol M2). C2's slice of this test: the
// pure, DB-free half of R21.6 — the precedence list, the combine step, the render strings and the
// (Ruling 23(c)-amended) attention set. `describeLinkBindingHealth` itself (the DB-reading half)
// lands in C6.

describe('LinkBindingHealth: TOTALITY (test 75, C2 slice)', () => {
  it('the precedence list has exactly twenty members, each unique', () => {
    expect(LINK_BINDING_HEALTH_PRECEDENCE).toHaveLength(20)
    expect(new Set(LINK_BINDING_HEALTH_PRECEDENCE).size).toBe(20)
  })

  // F11: a compile-time exhaustive map over the UNION (not the precedence array) — a 21st union
  // member added without a precedence entry fails TYPE CHECKING here (missing key), which the
  // array-only version of this test could not catch (its length/contains assertions stay green).
  const EVERY_LINK_BINDING_HEALTH_WORD: Record<LinkBindingHealth, true> = {
    quarantined: true,
    revoked: true,
    excluded: true,
    parked: true,
    contested: true,
    misroute_suspected: true,
    peer_reports_contest: true,
    peer_duplicate: true,
    peer_no_environments: true,
    duplicate_environment: true,
    multi_grant: true,
    unavailable: true,
    unreachable: true,
    unsupported: true,
    stale: true,
    legacy_unattested: true,
    proven: true,
    pending: true,
    unpaired: true,
    sender_unverified: true
  }

  it('the precedence list has no drift from the union — same members, either direction', () => {
    expect(Object.keys(EVERY_LINK_BINDING_HEALTH_WORD).sort()).toEqual(
      [...LINK_BINDING_HEALTH_PRECEDENCE].sort()
    )
  })

  it('every member of the union yields a defined word that is itself a member of the precedence list', () => {
    for (const word of Object.keys(EVERY_LINK_BINDING_HEALTH_WORD) as LinkBindingHealth[]) {
      const result = worstLinkBindingHealth([word])
      expect(result).toBe(word)
      expect(LINK_BINDING_HEALTH_PRECEDENCE).toContain(result)
      expect(renderLinkBindingHealth(word)).toBeTruthy()
    }
  })

  it('proven + duplicate_environment resolves to duplicate_environment', () => {
    expect(worstLinkBindingHealth(['proven', 'duplicate_environment'])).toBe(
      'duplicate_environment'
    )
  })

  it('unavailable + multi_grant resolves to multi_grant', () => {
    expect(worstLinkBindingHealth(['unavailable', 'multi_grant'])).toBe('multi_grant')
  })

  it('an empty candidate set returns null, never a fabricated default', () => {
    expect(worstLinkBindingHealth([])).toBeNull()
  })

  it('quarantined outranks every other word (first in precedence)', () => {
    const all = (LINK_BINDING_HEALTH_PRECEDENCE as LinkBindingHealth[]).toReversed()
    expect(worstLinkBindingHealth(all)).toBe('quarantined')
  })

  it('sender_unverified is the least severe word (last in precedence)', () => {
    expect(worstLinkBindingHealth(['sender_unverified'])).toBe('sender_unverified')
    expect(worstLinkBindingHealth(['sender_unverified', 'unpaired'])).toBe('unpaired')
  })

  it('unavailable reasons: exactly seven, unique', () => {
    expect(LINK_BINDING_UNAVAILABLE_REASONS).toHaveLength(7)
    expect(new Set(LINK_BINDING_UNAVAILABLE_REASONS).size).toBe(7)
  })

  // Ruling 27(a) (C6a, C6 fix-up): affirms Ruling 23 ADDENDUM (k) — misroute_suspected IS in the
  // set (a dispatch never outranks a ruling) — and adds the reply-relay words unreachable/
  // unsupported/stale (Ruling 26 Addendum 2(z)/3(gg)), on top of the standing Ruling 23(c)
  // membership (unavailable/revoked/peer_reports_contest/contested/quarantined/parked) that no
  // ruling has withdrawn. One test per word, per Ruling 27(a)'s own text.
  it.each([
    'contested',
    'quarantined',
    'parked',
    'peer_reports_contest',
    'unavailable',
    'revoked',
    'misroute_suspected',
    'unreachable',
    'unsupported',
    'stale'
  ] as const)('the attention set (Ruling 27(a)) contains %s', (word) => {
    expect(LINK_BINDING_ATTENTION_HEALTH.has(word)).toBe(true)
  })

  it('the attention set has exactly ten members (Ruling 27(a) additions over standing Ruling 23(c))', () => {
    expect(LINK_BINDING_ATTENTION_HEALTH.size).toBe(10)
  })

  it('excluded/legacy_unattested/proven/pending/unpaired/sender_unverified/peer_duplicate/peer_no_environments/duplicate_environment/multi_grant are NOT in the attention set', () => {
    for (const word of [
      'excluded',
      'legacy_unattested',
      'proven',
      'pending',
      'unpaired',
      'sender_unverified',
      'peer_duplicate',
      'peer_no_environments',
      'duplicate_environment',
      'multi_grant'
    ] as const) {
      expect(LINK_BINDING_ATTENTION_HEALTH.has(word)).toBe(false)
    }
  })

  it('HEALTH is independent of ROUTES: this module computes no routability at all', () => {
    // R21.6 clause 1 / A4-07: ROUTES is getRoutableLinkBinding(link) != null and NOTHING else — it
    // is never derived from HEALTH. This module (the pure HEALTH half) has no DB dependency and no
    // notion of a "routable" boolean anywhere in its exports — asserted structurally so the two
    // columns cannot be accidentally coupled here.
    const exportNames = Object.keys(linkBindingHealth)
    expect(exportNames.some((name) => /rout/i.test(name))).toBe(false)
  })
})
