// Why this module exists (BUG 6): `run:`/`dispatch:` mailboxes fall back to a
// live handle through a persisted row (runs.coordinator_pane_key,
// dispatch_contexts.assignee_pane_key). A bare peer terminal handle has no
// such row — when a graph reload re-mints handles, the address a peer
// message was sent to goes stale and the ambient push silently gives up.
// The durable substitute is the pane key recorded on the message itself
// (messages.recipient_pane_key); this resolves that pane key back to
// whichever handle currently owns it.

/** True for a bare terminal handle — neither a `run:` nor `dispatch:` mailbox address. */
export function isBarePeerHandle(handle: string): boolean {
  return !handle.startsWith('run:') && !handle.startsWith('dispatch:')
}

export type StaleBareHandleLookup = {
  getRecipientPaneKeyForBareHandle(handle: string): string | null
}

export type StaleBareHandleResolver = {
  /** True if `handle` still names a live terminal — no fallback needed. */
  isLiveHandle(handle: string): boolean
  /** Resolve a durable pane key to whatever handle currently owns it, or null. */
  getTerminalHandleForPaneKey(paneKey: string): string | null
}

/**
 * Resolve a stale bare terminal handle (not `run:`/`dispatch:`-prefixed)
 * through the recipient pane key recorded on messages once addressed to it.
 * Returns a currently-live handle, or null when unresolvable.
 */
export function resolveStaleBarePeerHandle(
  handle: string,
  db: StaleBareHandleLookup,
  resolver: StaleBareHandleResolver
): string | null {
  if (!isBarePeerHandle(handle)) {
    return null
  }
  const paneKey = db.getRecipientPaneKeyForBareHandle(handle)
  if (!paneKey) {
    return null
  }
  const resolved = resolver.getTerminalHandleForPaneKey(paneKey)
  return resolved && resolver.isLiveHandle(resolved) ? resolved : null
}
