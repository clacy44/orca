// S10-16 C3, R7.9's list: the frozen crypto primitives, tested for the exact adversarial shapes
// the plan's §6 risk table names as the commit's failure mode.
import { describe, expect, it, vi } from 'vitest'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type * as NodeCrypto from 'node:crypto'
import {
  LINK_BINDING_PROTOCOL,
  SELECTOR_LABEL,
  PROOF_LABEL,
  CONFIRM_LABEL,
  linkBindingTranscript,
  linkBindingMac,
  linkBindingMacEquals
} from './link-binding-proof'

describe('linkBindingTranscript', () => {
  it('is injective under field-boundary shifting', () => {
    expect(linkBindingTranscript('L', ['ab', 'c'])).not.toBe(
      linkBindingTranscript('L', ['a', 'bc'])
    )
  })

  it('length-prefixes every field including the label', () => {
    expect(linkBindingTranscript('lab', ['x', 'yz'])).toBe('3:lab1:x2:yz')
  })
})

describe('linkBindingMac', () => {
  it('matches the documented construction (createHmac sha256, hex digest)', () => {
    const expected = createHmac('sha256', 'cred')
      .update(linkBindingTranscript(SELECTOR_LABEL, ['a', 'b']))
      .digest('hex')
    expect(linkBindingMac('cred', SELECTOR_LABEL, ['a', 'b'])).toBe(expected)
  })

  it('a MAC under one label never verifies under another', () => {
    const fields = ['probeId', 'nonceH', '0', '1']
    const underSelector = linkBindingMac('secret', SELECTOR_LABEL, fields)
    const underProof = linkBindingMac('secret', PROOF_LABEL, fields)
    const underConfirm = linkBindingMac('secret', CONFIRM_LABEL, fields)
    expect(underSelector).not.toBe(underProof)
    expect(underProof).not.toBe(underConfirm)
    expect(underSelector).not.toBe(underConfirm)
  })

  it('per-slot nonces mean slot 0 proof never verifies as slot 1 proof', () => {
    const base = ['probeId', 'nonceH', '0', '1', 'chFp', 'keyFp']
    const nonceP0 = 'nonce-for-slot-0'
    const nonceP1 = 'nonce-for-slot-1'
    const slot0Fields = [...base.slice(0, 2), '0', ...base.slice(3), nonceP0]
    const slot1Fields = [...base.slice(0, 2), '1', ...base.slice(3), nonceP1]
    const proof0 = linkBindingMac('secret', PROOF_LABEL, slot0Fields)
    const proof1 = linkBindingMac('secret', PROOF_LABEL, slot1Fields)
    expect(proof0).not.toBe(proof1)
    expect(linkBindingMacEquals(proof0, linkBindingMac('secret', PROOF_LABEL, slot1Fields))).toBe(
      false
    )
  })

  it('exercises LINK_BINDING_PROTOCOL as the shared prefix', () => {
    expect(SELECTOR_LABEL.startsWith(LINK_BINDING_PROTOCOL)).toBe(true)
    expect(PROOF_LABEL.startsWith(LINK_BINDING_PROTOCOL)).toBe(true)
    expect(CONFIRM_LABEL.startsWith(LINK_BINDING_PROTOCOL)).toBe(true)
  })
})

describe('linkBindingMacEquals — hex64-guarded before any decode, never throws', () => {
  const valid = 'a'.repeat(64)

  it('rejects two malformed-but-Buffer.from-zero-length inputs (the exact defect the risk table names)', () => {
    expect(linkBindingMacEquals('zz', 'qqqq')).toBe(false)
  })

  it('rejects a value that would silently truncate under Buffer.from(hex)', () => {
    expect(linkBindingMacEquals('abcz', 'ab')).toBe(false)
  })

  it('rejects on case mismatch (never normalizes case before compare)', () => {
    const upper = valid.toUpperCase()
    expect(linkBindingMacEquals(upper, valid)).toBe(false)
  })

  it('rejects on length mismatch', () => {
    expect(linkBindingMacEquals(valid, valid.slice(0, 63))).toBe(false)
  })

  it('never throws on any of the malformed pairs above', () => {
    expect(() => linkBindingMacEquals('zz', 'qqqq')).not.toThrow()
    expect(() => linkBindingMacEquals('abcz', 'ab')).not.toThrow()
    expect(() => linkBindingMacEquals(valid.toUpperCase(), valid)).not.toThrow()
    expect(() => linkBindingMacEquals(valid, valid.slice(0, 63))).not.toThrow()
    expect(() => linkBindingMacEquals('', '')).not.toThrow()
  })

  it('never reaches timingSafeEqual for a malformed pair (spy) — the shape guard runs first', () => {
    // Spy on the node:crypto module object itself (not the source file's already-bound import
    // reference) so the assertion is about call COUNT, not merely the return value — a compare
    // that decoded first and got lucky by chance would also return `false` here.
    // CJS require (not the ES `import` binding, which vitest cannot make configurable for spying)
    // — the same object `linkBindingMacEquals`'s own module-level import resolves to at runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above
    const crypto = require('node:crypto') as typeof NodeCrypto
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    try {
      expect(linkBindingMacEquals('zz', 'qqqq')).toBe(false)
      expect(linkBindingMacEquals('abcz', 'ab')).toBe(false)
      expect(linkBindingMacEquals('', '')).toBe(false)
      expect(linkBindingMacEquals('a'.repeat(64).toUpperCase(), 'a'.repeat(64))).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('accepts two equal, well-formed 64-hex values', () => {
    expect(linkBindingMacEquals(valid, valid)).toBe(true)
  })

  it('rejects two well-formed but unequal 64-hex values', () => {
    const other = 'b'.repeat(64)
    expect(linkBindingMacEquals(valid, other)).toBe(false)
  })

  it('matches a direct timingSafeEqual over the same well-formed bytes', () => {
    const other = valid
    expect(linkBindingMacEquals(valid, other)).toBe(
      timingSafeEqual(Buffer.from(valid, 'hex'), Buffer.from(other, 'hex'))
    )
  })
})
