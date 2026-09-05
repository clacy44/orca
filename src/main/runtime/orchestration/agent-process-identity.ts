// S10-21a C7i (Ruling 34 Addendum 27): survival is the agent's OWN process identity, joined
// against one controller-inventory round the sweep takes once. Pure — no IO, no DB, no timers.
export type ProcessIdentity = { ptyId: string; incarnationId: string }

/** One controller-inventory round, as the sweep needs it: which ptyIds the controller currently
 * lists (`allLivePtyIds`) and, for those it could positively identify, their handle+incarnation
 * (`terminalIdentityByPtyId`) — a ptyId can be in the first without the second (ambiguous). */
export type ControllerInventory = {
  allLivePtyIds: ReadonlySet<string>
  terminalIdentityByPtyId: ReadonlyMap<string, { handle: string; incarnationId: string }>
  /** [S10-21a C7l, Ruling 34 Addendum 29 item 4] The runtime's own pty-record seq counter value
   * at the moment this round was taken (`takeControllerInventoryForSweep`) — undefined for a
   * round fetched any other way. A pty record's own `seq` > this value means the record was
   * created/attached AFTER the round, so `ptyConnectedNow` never mistakes it for absent; a
   * record already sitting connected BEFORE the round is judged by the round itself, never by
   * this raw "connected now" flag alone (that was the N2 bug: a stale own-pane surface read
   * 'present' forever). */
  roundSeq?: number
}

/** `agents.process_incarnation` is `"<ptyId>:<incarnationId>"`, split at the FIRST ':' — a
 * 3-segment legacy form ("<runtimeId>:<ptyId>:<gen>") is NOT an identity and parses to null. */
export function parseProcessIncarnation(value: string | null | undefined): ProcessIdentity | null {
  if (!value) {
    return null
  }
  const colonIndex = value.indexOf(':')
  if (colonIndex === -1) {
    return null
  }
  const ptyId = value.slice(0, colonIndex)
  const rest = value.slice(colonIndex + 1)
  if (!ptyId || !rest || rest.includes(':')) {
    return null
  }
  return { ptyId, incarnationId: rest }
}

export type AgentAliveResult =
  | 'alive'
  | 'dead'
  | 'unknown_no_identity'
  | 'unknown_inventory'
  | 'unknown_ambiguous_pty'

/** D-R117 §1, exactly: no identity -> unknown_no_identity; no round -> unknown_inventory; the
 * identity map lists the ptyId with the SAME incarnationId -> alive; the round lists the ptyId
 * live but could not identify it -> unknown_ambiguous_pty; otherwise -> dead (including a
 * DIFFERENT incarnation under the same ptyId — that pty is provably not this agent). */
export function agentAlive(
  identity: ProcessIdentity | null,
  inventory: ControllerInventory | null
): AgentAliveResult {
  if (!identity) {
    return 'unknown_no_identity'
  }
  if (inventory === null) {
    return 'unknown_inventory'
  }
  const controllerIdentity = inventory.terminalIdentityByPtyId.get(identity.ptyId)
  if (controllerIdentity) {
    // The round positively identified this ptyId — same incarnation is the agent; a DIFFERENT
    // one is provably not (a respawn under the same OS-level ptyId), never merely ambiguous.
    return controllerIdentity.incarnationId === identity.incarnationId ? 'alive' : 'dead'
  }
  if (inventory.allLivePtyIds.has(identity.ptyId)) {
    return 'unknown_ambiguous_pty'
  }
  return 'dead'
}
