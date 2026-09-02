// S10-16 R6/R7 (design v6, frozen): domain separation for the link-binding proof protocol — pure,
// no I/O. Every symbol here is on the wire or in a runbook verbatim (plan §4 FROZEN-INTERFACE
// LIST) and must not be renamed. THE REGISTER (link-binding-constants.ts) owns every numeric
// literal this module would otherwise need; this file owns only the pure functions and the three
// regexes/labels R7 defines beside them (APPENDIX A: these are declared here, not duplicated).
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  LINK_BINDING_HEX32_LENGTH,
  LINK_BINDING_HEX64_LENGTH,
  LINK_BINDING_B64URL_SHA256_LENGTH
} from './link-binding-constants'

export const LINK_BINDING_PROTOCOL = 'orca.link-binding.v1' as const
export const SELECTOR_LABEL = `${LINK_BINDING_PROTOCOL}/selector`
export const PROOF_LABEL = `${LINK_BINDING_PROTOCOL}/proof`
export const CONFIRM_LABEL = `${LINK_BINDING_PROTOCOL}/confirm`

// THE REGISTER (link-binding-constants.ts) owns every length; built via `new RegExp` so no
// quantifier is a bare source-text literal (test 77's scan).
export const LINK_BINDING_HEX32_RE = new RegExp(`^[0-9a-f]{${LINK_BINDING_HEX32_LENGTH}}$`)
export const LINK_BINDING_HEX64_RE = new RegExp(`^[0-9a-f]{${LINK_BINDING_HEX64_LENGTH}}$`)
// sha256 digest as unpadded base64url — used by fingerprintOrchestrationPeer's output shape, not
// validated by this module (dstKeyFp/observedChannelFp are transcript fields, not hex-guarded
// wire inputs), kept here beside its siblings per R7's declaration block. Underscore placed first
// in the character class so no digit is textually adjacent to it (cosmetic — regex semantics are
// unaffected either way).
export const LINK_BINDING_B64URL32_RE = new RegExp(
  `^[_A-Za-z0-9-]{${LINK_BINDING_B64URL_SHA256_LENGTH}}$`
)

/**
 * Unambiguous length-prefixed transcript: no separator can be forged across fields. Injective
 * under field-boundary shifting — `['ab','c']` and `['a','bc']` produce different byte strings
 * because each field carries its own UTF-8 byte length before it, not a delimiter a field's own
 * content could contain.
 */
export function linkBindingTranscript(label: string, fields: readonly string[]): string {
  return [label, ...fields].map((f) => `${Buffer.byteLength(f, 'utf8')}:${f}`).join('')
}

export function linkBindingMac(
  credential: string,
  label: string,
  fields: readonly string[]
): string {
  return createHmac('sha256', credential).update(linkBindingTranscript(label, fields)).digest('hex')
}

/**
 * BOTH sides must be exactly 64 lowercase hex BEFORE any decode. `Buffer.from('zz','hex')` and
 * `Buffer.from('qqqq','hex')` are both ZERO-LENGTH, so an unguarded `timingSafeEqual` over them
 * returns TRUE; `Buffer.from('abcz','hex')` silently truncates to `'ab'`. Never throws — the shape
 * guard runs first and unconditionally, so a malformed input on either side is `false`, not an
 * exception (plan §6 risk table: this is the exact defect a `git revert` would be needed for).
 */
export function linkBindingMacEquals(a: string, b: string): boolean {
  if (!LINK_BINDING_HEX64_RE.test(a) || !LINK_BINDING_HEX64_RE.test(b)) {
    return false
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
