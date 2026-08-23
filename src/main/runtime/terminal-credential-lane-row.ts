import { buildAgentNameRe } from '../../shared/agent-name-token-match'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type {
  RuntimeTerminalCredentialLane,
  RuntimeTerminalLaneState,
  RuntimeTerminalSummary
} from '../../shared/runtime-types'
import type { PaneCredentialLane } from './pane-credential-lane-registry'

const OPENCLAUDE_AGENT_TYPE_RE = buildAgentNameRe('openclaude')

export type TerminalCredentialLaneSource = {
  /** The PANE record's lane. `null` = no row at all, which is `unknown` and never attributed. */
  lane: PaneCredentialLane | null
  connectionId?: string | null
  wslDistro?: string | null
  /** Agent types the managed hooks observed in this pane, for the OpenClaude downgrade. */
  observedAgentTypes?: readonly (string | undefined)[]
  laneState?: RuntimeTerminalLaneState
}

export type TerminalCredentialLaneRow = {
  credentialLane: RuntimeTerminalCredentialLane
  laneState?: RuntimeTerminalLaneState
}

/**
 * How one terminal row states its Claude credential (S9 §2h).
 *
 * Order matters and each step is a fail-closed narrowing: an observed OpenClaude session in a lane
 * pane downgrades to `shared-runtime` rather than claiming an isolation the host cannot prove
 * (§2a consequence 3); a remote or WSL pane is labelled for where it runs, because neither can
 * carry a host lane; and a pane whose record has no lane row at all renders `unknown` rather than
 * `host`, so a pre-S9 restored pane is never attributed to a person.
 */
export function projectTerminalCredentialLane(
  source: TerminalCredentialLaneSource
): TerminalCredentialLaneRow {
  if (source.connectionId) {
    return { credentialLane: 'remote' }
  }
  if (source.lane === null) {
    return { credentialLane: 'unknown' }
  }
  if (source.lane.kind === 'shared') {
    return { credentialLane: source.wslDistro ? 'wsl' : 'host' }
  }
  if (hasObservedSharedRuntime(source.observedAgentTypes)) {
    // Why no laneState beside it: the pane is not running on the lane, so a residency claim about
    // that lane would say nothing true about this row's credential.
    return { credentialLane: 'shared-runtime' }
  }
  if (source.wslDistro) {
    return { credentialLane: 'wsl' }
  }
  return { credentialLane: 'grant', laneState: source.laneState ?? 'absent' }
}

function hasObservedSharedRuntime(
  agentTypes: readonly (string | undefined)[] | undefined
): boolean {
  return (agentTypes ?? []).some(
    (agentType) => agentType !== undefined && OPENCLAUDE_AGENT_TYPE_RE.test(agentType)
  )
}

export type TerminalCredentialLaneRowOptions = {
  laneOf(worktreeId: string, paneKey: string): PaneCredentialLane | null
  connectionIdOf?(ptyId: string): string | null | undefined
  wslDistroOf?(ptyId: string): string | null | undefined
  observedAgentTypesOf?(paneKey: string): readonly (string | undefined)[]
  laneStateOf?(principalId: string): RuntimeTerminalLaneState
  /**
   * The owner label's third hop: a presence participant id resolved to the PERSON behind it. The
   * participant map is keyed by connection with the grant as a field, and the lane is keyed by
   * principal, so neither map can answer this alone (§2h).
   */
  principalOfParticipant?(participantId: string): string | null
}

/**
 * A boundary pass over the finished array, for the same reason presence has one: `terminal.list` is
 * fed by the renderer-graph loop AND the PTY fallback loop, so only a pass over the result makes
 * the fields appear on every returned row.
 */
export function applyTerminalCredentialLaneRows(
  terminals: RuntimeTerminalSummary[],
  options: TerminalCredentialLaneRowOptions
): void {
  // Why memoized here and not in the caller: a lane's residency is a filesystem read, and one
  // response can carry many rows of the same two or three principals.
  const laneStates = new Map<string, RuntimeTerminalLaneState>()
  const laneStateOf = (principalId: string): RuntimeTerminalLaneState | undefined => {
    if (!options.laneStateOf) {
      return undefined
    }
    const known = laneStates.get(principalId)
    if (known) {
      return known
    }
    const state = options.laneStateOf(principalId)
    laneStates.set(principalId, state)
    return state
  }
  for (const terminal of terminals) {
    // Why tolerated rather than thrown on: the PTY-fallback builder can produce a row whose ids
    // name no addressable pane, and such a row has no lane to read — `unknown`, never `host`.
    const paneKey = laneLookupPaneKey(terminal)
    const lane = paneKey ? options.laneOf(terminal.worktreeId, paneKey) : null
    const row = projectTerminalCredentialLane({
      lane,
      connectionId: terminal.ptyId ? options.connectionIdOf?.(terminal.ptyId) : null,
      wslDistro: terminal.ptyId ? options.wslDistroOf?.(terminal.ptyId) : null,
      ...(paneKey ? { observedAgentTypes: options.observedAgentTypesOf?.(paneKey) } : {}),
      ...(lane?.kind === 'principal' ? { laneState: laneStateOf(lane.principalId) } : {})
    })
    terminal.credentialLane = row.credentialLane
    if (row.laneState) {
      terminal.laneState = row.laneState
    }
    markCredentialLaneOwners(terminal, lane, options)
  }
}

function laneLookupPaneKey(terminal: RuntimeTerminalSummary): string | null {
  return isValidTerminalTabId(terminal.tabId) && isTerminalLeafId(terminal.leafId)
    ? makePaneKey(terminal.tabId, terminal.leafId)
    : null
}

function markCredentialLaneOwners(
  terminal: RuntimeTerminalSummary,
  lane: PaneCredentialLane | null,
  options: TerminalCredentialLaneRowOptions
): void {
  if (lane?.kind !== 'principal' || !options.principalOfParticipant || !terminal.presence) {
    return
  }
  for (const participant of terminal.presence.participants) {
    if (options.principalOfParticipant(participant.participantId) === lane.principalId) {
      participant.credentialLaneOwner = true
    }
  }
}
