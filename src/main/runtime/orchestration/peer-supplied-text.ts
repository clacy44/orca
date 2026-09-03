// S10-16 C6, R19.4/R21.4, INV-P-012 clause (2)/(5): the ONLY renderer of peer-supplied text. A
// peer-chosen byte reaches the operator only as a labelled, control-stripped, length-clamped
// claim — never as free prose, never unlabelled.
//
// F10/Ruling 27(h) (C6a): C6 landed a `sanitizePeerSuppliedText` here that was exported and
// called NOWHERE — byte-for-byte `reply-outbox-pump-disposition.ts`'s write-time
// `sanitizeErrorDetail` (same control-char strip, same clamp shape, a different constant) but
// missing R19.4's whitespace-collapse and truncation-marker contract, and untested. Ruling
// 27(h)'s two options: complete it to R19.4 and make `sanitizeErrorDetail` delegate to it (one
// definition site, Ruling 23(i)), or delete it and point C7 at `sanitizeErrorDetail`.
// `sanitizeErrorDetail` lives in `reply-outbox-pump-disposition.ts`, which this slice's
// `reply-outbox-pump*.ts` no-edit constraint puts out of reach — delegating would require editing
// it — so this is the DELETE branch: C7's `link-status --outbox` should import
// `sanitizeErrorDetail` from `reply-outbox-pump-disposition.ts`, not a dead duplicate here.
import type { LinkBindingHealth } from '../../../shared/link-binding-health'

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
