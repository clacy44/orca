import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { isPrincipalId } from '../claude-accounts/principal-credential-lane'
import type { PersistedPaneCredentialLane } from '../../shared/workspace-session-state-types'

/**
 * The lane a pane runs on — a property of the pane record, never of a launch request (S9 §2a).
 *
 * `shared` is the host's own `~/.claude`, written explicitly by the paths that mean it. A pane
 * with no row at all is *unknown* and is never attributed, which is a different thing.
 */
export type PaneCredentialLane = { kind: 'principal'; principalId: string } | { kind: 'shared' }

export type { PersistedPaneCredentialLane }

export type PaneCredentialLaneLookup =
  | { kind: 'bound'; lane: PaneCredentialLane }
  /** The host knows a pane under this key and it carries no lane — pre-S9 or a lane-less path. */
  | { kind: 'unbound' }
  /** No pane under this key: a create may mint one here. */
  | { kind: 'unknown' }

export function laneEquals(a: PaneCredentialLane, b: PaneCredentialLane): boolean {
  return a.kind === 'shared'
    ? b.kind === 'shared'
    : b.kind === 'principal' && a.principalId === b.principalId
}

export function serializePaneCredentialLane(
  worktreeId: string,
  lane: PaneCredentialLane
): PersistedPaneCredentialLane {
  return lane.kind === 'principal' ? { worktreeId, principalId: lane.principalId } : { worktreeId }
}

/** A row whose principal is not a validated principal id is unknown, never shared. */
export function parsePersistedPaneCredentialLane(
  row: PersistedPaneCredentialLane | undefined | null
): PaneCredentialLane | null {
  if (!row || typeof row.worktreeId !== 'string' || row.worktreeId.length === 0) {
    return null
  }
  if (row.principalId === undefined) {
    return { kind: 'shared' }
  }
  return isPrincipalId(row.principalId) ? { kind: 'principal', principalId: row.principalId } : null
}

/**
 * A separator neither component can contain. A worktreeId embeds a filesystem path
 * (`repo::C:\\Users\\Ana Smith\\repo`) and a client-supplied tabId only forbids ':', so both may
 * hold spaces — a space separator lets two distinct (worktreeId, paneKey) pairs alias onto one row.
 * Written as an escape, not as a literal NUL byte, so the key is visible to a reader and to grep.
 */
const LANE_KEY_SEPARATOR = '\u0000'

function laneKey(worktreeId: string, paneKey: string): string {
  return `${worktreeId}${LANE_KEY_SEPARATOR}${paneKey}`
}

/**
 * `(worktreeId, paneKey) → lane`, bound at the paneKey mint and read back at every spawn edge.
 *
 * Binding is write-once: a respawn into a bound paneKey runs on the *record's* lane, so the row is
 * never rewritten — least of all to `shared`, which would be the silent downgrade §2a exists to
 * close.
 */
export class PaneCredentialLaneRegistry {
  private readonly lanes = new Map<string, { worktreeId: string; lane: PaneCredentialLane }>()

  /** Returns the lane the pane now runs on: the existing row wins over the caller's value. */
  bind(worktreeId: string, paneKey: string, lane: PaneCredentialLane): PaneCredentialLane {
    const existing = this.lanes.get(laneKey(worktreeId, paneKey))
    if (existing) {
      return existing.lane
    }
    this.lanes.set(laneKey(worktreeId, paneKey), { worktreeId, lane })
    return lane
  }

  laneOf(worktreeId: string, paneKey: string): PaneCredentialLane | null {
    return this.lanes.get(laneKey(worktreeId, paneKey))?.lane ?? null
  }

  lookup(worktreeId: string, paneKey: string, paneExists: boolean): PaneCredentialLaneLookup {
    const lane = this.laneOf(worktreeId, paneKey)
    if (lane) {
      return { kind: 'bound', lane }
    }
    return paneExists ? { kind: 'unbound' } : { kind: 'unknown' }
  }

  /**
   * The statusline posts a paneKey and no worktree, so the join has to address by key alone.
   *
   * Ambiguity answers `null`, not a guess: two worktrees can hold the same client-supplied tabId,
   * and attributing to the wrong one is the cross-principal misattribution the key exists to fix.
   */
  laneOfPaneKeyAcrossWorktrees(paneKey: string): PaneCredentialLane | null {
    let found: PaneCredentialLane | null = null
    for (const [key, value] of this.lanes) {
      if (key.slice(value.worktreeId.length + LANE_KEY_SEPARATOR.length) !== paneKey) {
        continue
      }
      if (found && !laneEquals(found, value.lane)) {
        return null
      }
      found = value.lane
    }
    return found
  }

  forget(worktreeId: string, paneKey: string): void {
    this.lanes.delete(laneKey(worktreeId, paneKey))
  }

  /** Cold restore: rows read back off the persisted binding rows, unparseable ones dropped. */
  rehydrate(rows: Readonly<Record<string, PersistedPaneCredentialLane>> | undefined): void {
    for (const [paneKey, row] of Object.entries(rows ?? {})) {
      const lane = parsePersistedPaneCredentialLane(row)
      if (lane) {
        this.lanes.set(laneKey(row.worktreeId, paneKey), { worktreeId: row.worktreeId, lane })
      }
    }
  }

  entries(): { worktreeId: string; paneKey: string; lane: PaneCredentialLane }[] {
    return Array.from(this.lanes.entries()).map(([key, value]) => ({
      worktreeId: value.worktreeId,
      paneKey: key.slice(value.worktreeId.length + LANE_KEY_SEPARATOR.length),
      lane: value.lane
    }))
  }
}

/**
 * The adopt gate of §2a(ii), and it is caller-class *independent*: a lane-less `shared` caller may
 * not adopt a lane-bound pane either. Runs after the pane-identity hint validates and before
 * `adoptStablePane`, so a refusal costs no spawn.
 */
export function assertPaneAdoptableByCaller(
  lookup: PaneCredentialLaneLookup,
  caller: PaneCredentialLane
): void {
  if (lookup.kind === 'bound') {
    if (!laneEquals(lookup.lane, caller)) {
      throw new ClaudeLaneRefusal(
        'terminal.lane_not_owned',
        'That terminal pane belongs to another person’s Claude credential lane, so Orca will not reuse it for this request. Create a new terminal instead.'
      )
    }
    return
  }
  if (lookup.kind === 'unbound' && caller.kind === 'principal') {
    // Why: promoting it would adopt a renderer-minted identity into a lane; spawning it would put
    // a lane holder's pane on the shared credential. Both are refused, so the pane is re-created.
    throw new ClaudeLaneRefusal(
      'terminal.lane_pane_unbound',
      'That terminal pane was created before your Claude credential lane existed, so Orca cannot reopen it in your lane. Create a new terminal for this agent.'
    )
  }
}
