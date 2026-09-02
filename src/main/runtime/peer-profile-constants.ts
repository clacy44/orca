// S10-19 (chair rulings 20/22/24, Ruling 24 addendum 2(r)): the ONE register module for
// least-privilege-peer-access-profile constants with a ruled value. db.ts (W-2) is the first
// consumer; runtime-peer-rpc-allowlist.ts (W-3) extends this file. No test or doc comment
// restates a value; every consumer references the symbol (§C.3).

// §14B (W-2): how long a settled/exited remote_dispatch_attachments row survives before
// pruneSettledRemoteAttachments() may delete it.
export const PEER_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// §14B (W-2): per home_peer_fingerprint, how many settled/exited rows
// pruneSettledRemoteAttachments() retains even inside the retention window (newest-first) before
// deleting the overflow.
export const PEER_ATTACHMENTS_RETAINED_PER_LINK = 256

// §14B (W-3): the attach verb's own per-minute cap (enforced at the ingress, W-5) — distinct from
// PEER_MAILBOX_PER_MINUTE below, which meters every OTHER peer-link verb.
export const PEER_ATTACH_PER_MINUTE = 6

// §14B (W-3): per home_peer_fingerprint, the cap on simultaneously-live peer attachments
// (db.countLivePeerAttachments, W-2) — checked at the ingress before admitting a new attach.
export const PEER_LIVE_ATTACHMENTS_PER_LINK = 16

// Ruling 24 addendum (j) (W-3): one poll per live dispatch mailbox plus headroom; the global cap
// (longPollCap) stays the outer bound.
export const PEER_LONG_POLL_PER_DEVICE_CAP = 4

// Ruling 24 addendum (j) (W-3): matches the federation inbound rate F9 uses — the shared meter
// for every peer-link verb other than attach itself (meterPeerLink, runtime-peer-rpc-allowlist.ts).
export const PEER_MAILBOX_PER_MINUTE = 60

// §14B (W-3): an operator-supplied federationAttachStart timeoutMs is clamped into this range,
// never refused (G-5) — it can only be SHORTENED from a peer-chosen value.
export const PEER_ATTACH_TIMEOUT_MIN_MS = 10_000
export const PEER_ATTACH_TIMEOUT_MAX_MS = 180_000
