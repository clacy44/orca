// S10-19 (chair rulings 20/22/24, Ruling 24 addendum 2(r)): the ONE register module for
// least-privilege-peer-access-profile constants with a ruled value. db.ts (W-2) is the first
// consumer and imports from here — it never defines these. W-3 extends this file with the
// remaining §D constants (PEER_ATTACH_PER_MINUTE, PEER_LIVE_ATTACHMENTS_PER_LINK,
// PEER_LONG_POLL_PER_DEVICE_CAP, PEER_MAILBOX_PER_MINUTE, PEER_ATTACH_TIMEOUT_MIN_MS/MAX_MS).
// No test or doc comment restates a value; every consumer references the symbol (§C.3).

// §14B: how long a settled/exited remote_dispatch_attachments row survives before
// pruneSettledRemoteAttachments() may delete it.
export const PEER_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// §14B: per home_peer_fingerprint, how many settled/exited rows pruneSettledRemoteAttachments()
// retains even inside the retention window (newest-first) before deleting the overflow.
export const PEER_ATTACHMENTS_RETAINED_PER_LINK = 256
