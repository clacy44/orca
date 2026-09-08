// S10-21a C7i (Ruling 34 Addendum 27): survival is the agent's OWN process identity, joined
// against one controller-inventory round the sweep takes once. Pure — no IO, no DB, no timers.
import { isSessionId } from '../../../shared/stable-pane-id'

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

/** `agents.process_incarnation` is `"<ptyId>:<incarnationId>"`, split at the LAST ':' — a
 * worktree ptyId is itself `${repoId}::${path}@@${short}` (pty-session-id.ts:23,
 * pty-session-id-format.ts:15), so the composite routinely carries 3+ colons and splitting at
 * the FIRST one (the pre-D-R159 behaviour) tore the ptyId in half and rejected every real local
 * identity. [D-R159 finding 1] Splitting at the last ':' alone is not enough to reject the
 * legacy 3-segment form ("<runtimeId>:<ptyId>:<gen>", agent-restore-rebind.ts:168's else-branch,
 * still written by `identity_unavailable: legacy_form`) — that form ALSO has its last colon
 * separate a non-empty prefix from a non-empty suffix, so an EXPLICIT shape check on the
 * suffix does the rejection instead: the incarnation id must be a UUID (every real minter uses
 * `randomUUID()` — orca-runtime.ts's `onPtySpawned`/pty.ts's `onSpawned`), and a legacy form's
 * trailing `<gen>` segment never is one. `ptyId` (the prefix) is checked only for
 * non-emptiness — it legitimately contains '::' and '@@' now. */
export function parseProcessIncarnation(value: string | null | undefined): ProcessIdentity | null {
  if (!value) {
    return null
  }
  const colonIndex = value.lastIndexOf(':')
  if (colonIndex === -1) {
    return null
  }
  const ptyId = value.slice(0, colonIndex)
  const incarnationId = value.slice(colonIndex + 1)
  if (!ptyId || !isSessionId(incarnationId)) {
    return null
  }
  return { ptyId, incarnationId }
}

/** [S10-21c B-final L6, D-R160 low 6] Distinguishes WHY a non-null `processIncarnation` failed
 * `parseProcessIncarnation` above, so a durable audit row never claims the wrong cause: the
 * legacy form (`runtime:<runtimeId>:<generation>`, orca-runtime.ts:15836) is always exactly 3
 * `:`-separated segments — a real worktree ptyId's own `::`/`@@` (this module's own header
 * comment) never produces exactly 3 — so segment count alone tells the legacy shape apart from
 * any OTHER value whose incarnation half simply isn't a UUID (e.g. one minted by a different
 * build). Call only on a value `parseProcessIncarnation` already rejected — undefined for one it
 * accepted, [chair decision, R94] `isPtyIncarnationId` (shared/pty-incarnation.ts) stays looser
 * for admission; aligning it is deferred to next train. */
export function classifyUnparseableProcessIncarnation(
  value: string
): 'legacy_form' | 'non_uuid_incarnation' {
  return value.split(':').length === 3 ? 'legacy_form' : 'non_uuid_incarnation'
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
