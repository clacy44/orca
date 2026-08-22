// Why a sibling of session-tabs.ts and not part of it: that file is at its counted-line ceiling, and
// W9 is one projection, not a method — every session.tabs payload leaves through this one function so
// the agent-status projection and the device roster can never be applied to different subsets of it.
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeSessionTabDeviceSelection
} from '../../../../shared/runtime-types'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import {
  buildTerminalPresenceDeviceSelections,
  type TerminalPresenceGrantSelection
} from '../../terminal-presence-snapshot'
import type { RpcContext } from '../core'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'

export type SessionTabProjectionContext = Pick<
  RpcContext,
  'runtime' | 'clientKind' | 'clientCapabilities' | 'pairedDeviceId'
>

// Why resolved against the snapshot's own tabs: a stored selection can name a tab that has since been
// closed, and publishing that id would put a dead tab on somebody else's roster.
function toGrantSelections(
  snapshot: RuntimeMobileSessionTabsResult,
  ctx: SessionTabProjectionContext
): TerminalPresenceGrantSelection[] {
  const selections: TerminalPresenceGrantSelection[] = []
  for (const [pairedDeviceId, selection] of ctx.runtime.getClientSessionTabSelections(
    snapshot.worktree
  )) {
    const tab = snapshot.tabs.find((candidate) => candidate.id === selection.activeTabId)
    if (!tab) {
      continue
    }
    selections.push({ pairedDeviceId, activeTabId: tab.id, activeTabType: tab.type })
  }
  return selections
}

export function buildSessionTabDeviceSelections(
  snapshot: RuntimeMobileSessionTabsResult,
  ctx: SessionTabProjectionContext
): RuntimeSessionTabDeviceSelection[] {
  return buildTerminalPresenceDeviceSelections({
    registry: terminalPresenceRegistry,
    hasEstablishedSubscription: (connectionId) =>
      ctx.runtime.hasEstablishedSubscription(connectionId),
    selections: toGrantSelections(snapshot, ctx),
    selfPairedDeviceId: ctx.pairedDeviceId ?? null
  })
}

/** The single exit for every session.tabs payload: agent-status legacy shaping, then W9's device
 *  roster when — and only when — the caller asked for it. */
export function projectSessionTabsForClient<TPayload extends RuntimeMobileSessionTabsResult>(
  payload: TPayload,
  ctx: SessionTabProjectionContext,
  includeDeviceSelections: boolean
): TPayload {
  const projected = projectSessionTabAgentStatus(payload, ctx.clientKind, ctx.clientCapabilities)
  if (!includeDeviceSelections) {
    // Why the payload itself and not a copy: a pre-presence caller must get the byte-identical shape.
    return projected
  }
  // Why present-and-empty rather than omitted when nobody is here: an absent key means "this host
  // does not publish it", and collapsing that into "nobody is here" is the one distinction a client
  // cannot recover.
  return { ...projected, deviceSelections: buildSessionTabDeviceSelections(projected, ctx) }
}
