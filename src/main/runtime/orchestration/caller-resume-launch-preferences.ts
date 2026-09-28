// Artifact 10z.5 R287/R289 (T13): the identity a session is attributed to on this host (shared by
// the caller-resume admission's audit row, R287 rule 6, and R290), and the host-scoped launch pins a
// caller resume of such a session inherits (R289). Never throws.
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import type { AgentRow } from './agent-directory-types'
import { launchPreferencesFromRow } from './agent-launch-sessions'
import { readManifestEntry } from './chair-succession-manifest-entry'
import type { OrchestrationDb } from './db'

function usableIdentity(row: AgentRow | undefined): AgentRow | undefined {
  return row && row.derived === 0 && row.tombstoned_at === null && row.quarantined === 0
    ? row
    : undefined
}

/** The newest host-scoped launch row for `sessionId` with a non-null `agent_id`, else the
 * session's current holder's registered row; non-derived, non-tombstoned, non-quarantined.
 * `excludePaneKey` drops that pane's launch rows and its holder claim. */
export function attributedIdentityForSession(
  db: OrchestrationDb,
  hostId: string,
  executionHostId: string,
  sessionId: string,
  excludePaneKey?: string
): AgentRow | undefined {
  try {
    const launch = db.newestHostScopedLaunchForSession(hostId, executionHostId, sessionId, {
      excludePaneKey,
      requireAgentId: true
    })
    const fromLaunch = launch?.agent_id
      ? usableIdentity(db.getAgentById(launch.agent_id))
      : undefined
    if (fromLaunch) {
      return fromLaunch
    }
    const holder = db.paneHoldingSession(hostId, sessionId)
    return holder !== undefined && holder !== excludePaneKey
      ? usableIdentity(db.getAgentByPaneKey(hostId, holder))
      : undefined
  } catch {
    return undefined
  }
}

export type CallerResumePinRequest = {
  agentArgs: string | undefined
  appendAgentArgs: string | undefined
  shell: AgentStartupShell
}

/** Which of `--model` / `--effort` the request's own args already carry; null when the args cannot
 * be modelled, in which case the caller's command is left alone entirely. */
function fieldsSetByRequestArgs(
  request: CallerResumePinRequest
): { model: boolean; effort: boolean } | null {
  const text = [request.agentArgs, request.appendAgentArgs].filter(Boolean).join(' ')
  if (!text) {
    return { model: false, effort: false }
  }
  const tokenized = tokenizeStartupCommand(text, request.shell)
  if (!tokenized.ok) {
    return null
  }
  const has = (flag: string): boolean =>
    tokenized.tokens.some((t) => t === flag || t.startsWith(`${flag}=`))
  return { model: has('--model'), effort: has('--effort') }
}

/** Launch pins for a caller `claude --resume X` of a session attributed to a registered identity:
 * per field, the session's newest host-scoped launch row, then the identity's host-scoped manifest
 * entry (DEC-9: an observed 'xhigh' never overrides a manifest 'ultracode'); fields the request's
 * own args already set are skipped. Unattributed sessions get undefined. */
export async function resolveCallerResumeLaunchPreferences(
  db: OrchestrationDb,
  hostId: string,
  executionHostId: string,
  sessionId: string,
  request: CallerResumePinRequest
): Promise<AgentLaunchPreferences | undefined> {
  try {
    const identity = attributedIdentityForSession(db, hostId, executionHostId, sessionId)
    const setByRequest = fieldsSetByRequestArgs(request)
    if (!identity || !setByRequest) {
      return undefined
    }
    const launch = db.newestHostScopedLaunchForSession(hostId, executionHostId, sessionId, {
      requireAgentId: true
    })
    const fromRow =
      launch && launch.agent_id === identity.id ? launchPreferencesFromRow(launch) : undefined
    const manifest = await readManifestEntry(undefined, identity.display_name).catch(
      () => undefined
    )
    let effort = fromRow?.effort ?? manifest?.effort
    if (
      manifest?.effort === 'ultracode' &&
      fromRow?.effort === 'xhigh' &&
      launch?.pref_source === 'observed'
    ) {
      effort = 'ultracode'
    }
    const model = setByRequest.model ? undefined : (fromRow?.model ?? manifest?.model)
    effort = setByRequest.effort ? undefined : effort
    return model || effort
      ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
      : undefined
  } catch {
    return undefined
  }
}
