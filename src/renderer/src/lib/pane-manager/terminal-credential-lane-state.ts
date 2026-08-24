// Why beside terminal-presence-state and not merged into it: the lane fields ride `terminal.list`
// (RuntimeTerminalSummary — credentialLane/laneState/laneAccountLabel/laneUsage), a runtime-wide
// projection that arrives per refresh, while presence rides the pane's own per-keystroke stream.
// Two cadences, two authorities — so this is the same module-level-Map + listener-set shape the
// presence lane uses, but fed from the list boundary, never from a pane's stream.
//
// Keyed by ptyId exactly as the presence pane lane is (remote panes carry the environment-prefixed
// id, local panes the raw one), so a pane reads ONE lane regardless of which list produced it. A
// pane with no row here reads `unknown` — the same fail-closed value the host projects for a pane
// whose record has no lane at all — so an unattributed pane is never rendered as owned by a person.
import { useSyncExternalStore } from 'react'
import type {
  RuntimeTerminalCredentialLane,
  RuntimeTerminalLaneAccountLabel,
  RuntimeTerminalLaneState,
  RuntimeTerminalLaneUsage
} from '../../../../shared/runtime-types'

export type TerminalPaneCredentialLane = {
  credentialLane: RuntimeTerminalCredentialLane
  laneState?: RuntimeTerminalLaneState
  laneAccountLabel?: RuntimeTerminalLaneAccountLabel
  laneUsage?: RuntimeTerminalLaneUsage
  /** The viewer's own grant owns this lane — read off the row's self presence participant (§2h). */
  credentialLaneOwner?: true
}

// Why one frozen identity for every unattributed pane: the chip selector asks per pane on every
// list write, and the overwhelmingly common answer is "no lane". Returning a fresh object each time
// would defeat the reference equality useSyncExternalStore and memo selectors rely on.
export const UNATTRIBUTED_CREDENTIAL_LANE: TerminalPaneCredentialLane = Object.freeze({
  credentialLane: 'unknown'
})

const laneByPtyId = new Map<string, TerminalPaneCredentialLane>()

// Why scoped: `terminal.list` answers one environment at a time, so "which rows are gone" can only
// be reconciled against the ptyIds THAT list last carried — never against the whole map, which
// would clobber another environment's panes on every refresh.
const ptyIdsByScope = new Map<string, Set<string>>()

type CredentialLaneChangeEvent = { ptyId: string; lane: TerminalPaneCredentialLane }
const changeListeners = new Set<(event: CredentialLaneChangeEvent) => void>()

export function onCredentialLaneChange(
  listener: (event: CredentialLaneChangeEvent) => void
): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function notify(ptyId: string): void {
  const lane = getCredentialLaneForPty(ptyId)
  for (const listener of changeListeners) {
    listener({ ptyId, lane })
  }
}

function isUnattributed(lane: TerminalPaneCredentialLane): boolean {
  return (
    lane.credentialLane === 'unknown' &&
    lane.laneState === undefined &&
    lane.laneAccountLabel === undefined &&
    lane.laneUsage === undefined &&
    lane.credentialLaneOwner === undefined
  )
}

function writeLane(ptyId: string, lane: TerminalPaneCredentialLane): void {
  // Why an unknown lane is a delete, not a stored row: a pane with nothing to say must read the one
  // shared UNATTRIBUTED identity, so an equality check never sees two "unknown" objects disagree.
  if (isUnattributed(lane)) {
    if (!laneByPtyId.delete(ptyId)) {
      return
    }
  } else {
    laneByPtyId.set(ptyId, lane)
  }
  notify(ptyId)
}

export function setCredentialLaneForPty(ptyId: string, lane: TerminalPaneCredentialLane): void {
  writeLane(ptyId, lane)
}

export function clearCredentialLaneForPty(ptyId: string): void {
  writeLane(ptyId, UNATTRIBUTED_CREDENTIAL_LANE)
}

export function getCredentialLaneForPty(ptyId: string): TerminalPaneCredentialLane {
  return laneByPtyId.get(ptyId) ?? UNATTRIBUTED_CREDENTIAL_LANE
}

export type TerminalCredentialLaneRow = {
  ptyId: string
  lane: TerminalPaneCredentialLane
}

/**
 * Apply one `terminal.list` response's lane rows for a scope (an environment id, or the local
 * sentinel). Every ptyId the previous response for this scope carried but this one does not is
 * dropped, so a pane that left the list — closed, or moved off a lane — stops asserting a stale
 * owner rather than freezing on its last chip.
 */
export function applyTerminalCredentialLaneRows(
  scopeKey: string,
  rows: readonly TerminalCredentialLaneRow[]
): void {
  const previous = ptyIdsByScope.get(scopeKey)
  const next = new Set<string>()
  for (const row of rows) {
    next.add(row.ptyId)
    writeLane(row.ptyId, row.lane)
  }
  if (previous) {
    for (const ptyId of previous) {
      if (!next.has(ptyId)) {
        clearCredentialLaneForPty(ptyId)
      }
    }
  }
  if (next.size === 0) {
    ptyIdsByScope.delete(scopeKey)
  } else {
    ptyIdsByScope.set(scopeKey, next)
  }
}

/** Drops every lane a scope carried — the environment paired out, so its rows must not linger. */
export function clearCredentialLaneScope(scopeKey: string): void {
  const previous = ptyIdsByScope.get(scopeKey)
  if (!previous) {
    return
  }
  ptyIdsByScope.delete(scopeKey)
  for (const ptyId of previous) {
    clearCredentialLaneForPty(ptyId)
  }
}

function subscribeToPtyLane(ptyId: string, onChange: () => void): () => void {
  return onCredentialLaneChange((event) => {
    if (event.ptyId === ptyId) {
      onChange()
    }
  })
}

/** Per-pane selector: the lane this pane's `terminal.list` row asserts, or the unattributed default. */
export function useTerminalCredentialLane(ptyId: string): TerminalPaneCredentialLane {
  return useSyncExternalStore(
    (onChange) => subscribeToPtyLane(ptyId, onChange),
    () => getCredentialLaneForPty(ptyId),
    () => UNATTRIBUTED_CREDENTIAL_LANE
  )
}

/** Test-only: the map and the scope index are process-global, so a seeded case would otherwise leak. */
export function resetTerminalCredentialLaneStateForTest(): void {
  laneByPtyId.clear()
  ptyIdsByScope.clear()
}
