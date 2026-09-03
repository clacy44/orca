// S10-16 C6, R19.4/R21.4, INV-P-012 clause (2)/(5): the ONLY renderer of peer-supplied text. A
// peer-chosen byte reaches the operator only as a labelled, control-stripped, length-clamped
// claim — never as free prose, never unlabelled.
import { LINK_BINDING_PEER_TEXT_CLAMP } from './link-binding-constants'
import type { LinkBindingHealth } from '../../../shared/link-binding-health'

// R19.4: strip control characters (Ruling 26 Addendum 1(v)'s set) and clamp
// to the write-time bound this text was already capped at, so a render-side bug can never emit
// more than the store itself would ever hold. Mirrors reply-outbox-pump-disposition.ts's
// write-time `sanitizeErrorDetail` — the render-side counterpart of the same rule.
export function sanitizePeerSuppliedText(raw: string): string {
  // eslint-disable-next-line no-control-regex -- Why: stripping raw peer-supplied control bytes is the point.
  const stripped = raw.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, ' ').trim()
  return stripped.slice(0, LINK_BINDING_PEER_TEXT_CLAMP)
}

// A4-03: health words sourced from a peer's own answer — rendered through R21.4's claim shape.
export const PEER_SOURCED_HEALTH_WORDS: ReadonlySet<LinkBindingHealth> = new Set([
  'peer_duplicate',
  'peer_reports_contest',
  'misroute_suspected',
  'peer_no_environments'
])

// R21.4: every claim renders in this ONE fixed shape — never a local verdict about the peer.
export function labelPeerSuppliedClaim(text: string): string {
  return `${text} (claim supplied by the remote host — not verified by this host)`
}
