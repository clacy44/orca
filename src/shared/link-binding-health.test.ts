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

  it('every member of the union yields a defined word that is itself a member of the precedence list', () => {
    for (const word of LINK_BINDING_HEALTH_PRECEDENCE) {
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

  it('the attention set (Ruling 23(c) amended) contains unavailable and revoked plus the original four', () => {
    expect(LINK_BINDING_ATTENTION_HEALTH.has('unavailable')).toBe(true)
    expect(LINK_BINDING_ATTENTION_HEALTH.has('revoked')).toBe(true)
    expect(LINK_BINDING_ATTENTION_HEALTH.has('contested')).toBe(true)
    expect(LINK_BINDING_ATTENTION_HEALTH.has('quarantined')).toBe(true)
    expect(LINK_BINDING_ATTENTION_HEALTH.has('parked')).toBe(true)
    expect(LINK_BINDING_ATTENTION_HEALTH.has('peer_reports_contest')).toBe(true)
    expect(LINK_BINDING_ATTENTION_HEALTH.size).toBe(6)
  })

  it('misroute_suspected is deliberately NOT in the attention set (its push surface is the notice)', () => {
    expect(LINK_BINDING_ATTENTION_HEALTH.has('misroute_suspected')).toBe(false)
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
