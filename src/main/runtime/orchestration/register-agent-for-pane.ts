// S10-21d b3 (DEC-6, design-r105-r112 D5): registerAgentForPane, extracted from
// orchestration.agents.register's own handler body (orchestration-agents-register.ts) so an
// in-process caller — today `requestChairRestore` (orca-runtime.ts), the executor path in the
// next brief — can perform the SAME registration write the RPC method does, without a caller
// identity/pane-attestation round-trip (there is none to attest: the pane was just admitted by
// this same process). The RPC method keeps its own auth check
// (`verifyOrchestrationCompatibilityCaller`) and both rate limits, then calls this.
import type { AgentRow } from './types'
import type { OrchestrationDb } from './db'
import type { OrcaRuntimeService } from '../orca-runtime'
import { sanitizeRole, sanitizeTitle, validateDisplayNameCandidate } from './agent-name-sanitizer'
import { deriveAgentLabelSlug } from './agent-derivation'
import { findLiveTerminalByHandle } from '../rpc/methods/agent-directory-rpc-liveness'
import { DIRECTORY_LIVE_CAP, hostIdFor } from '../rpc/methods/agent-directory-rpc-view'

export type RegisterAgentForPaneParams = {
  paneKey: string
  terminalHandle: string | null
  processIncarnation: string | null
  displayName: string
  role: string | undefined
}

export type RegisterAgentForPaneOutcome =
  | {
      ok: true
      agent: AgentRow
      created: boolean
      reMinted: boolean
      repointedMessages: number
      pendingOnOldHandle: number
      unreadWaiting: number
      adoptedThreads: number
      blockedByQuarantinedPredecessor: boolean
      pendingPeerQuestions: number
      unreadMailOnRetiredId: number
    }
  | { ok: false; reason: 'invalid_name'; reasonCode: string }
  | { ok: false; reason: 'directory_full' }
  | {
      ok: false
      reason: 'name_taken'
      liveTerminalHandle: string | null
      holderPaneDead: boolean
      alternative: string
    }

/** [S10-1b, S10-21d b3 extraction] Everything orchestration.agents.register's handler does
 * BETWEEN its auth/rate-limit gates and its RPC-shaped response: name validation, the directory
 * cap, the live-terminal metadata lookup, the upsert-by-pane-suffix write, succession catch-up,
 * and the unread-mail wake. Byte-identical logic to the pre-extraction handler — no behaviour
 * change, only a caller that is not an RPC request. */
export async function registerAgentForPane(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  params: RegisterAgentForPaneParams
): Promise<RegisterAgentForPaneOutcome> {
  const hostId = hostIdFor(runtime)
  const nameValidation = validateDisplayNameCandidate(params.displayName)
  if (!nameValidation.ok) {
    return { ok: false, reason: 'invalid_name', reasonCode: nameValidation.reasonCode }
  }

  const existingForPane = db.getAgentByPaneKey(hostId, params.paneKey)
  if (!existingForPane) {
    const liveCount = db.listAgents({
      hostId,
      includeDerived: false,
      includeQuarantined: true,
      limit: DIRECTORY_LIVE_CAP
    }).agents.length
    if (liveCount >= DIRECTORY_LIVE_CAP) {
      return { ok: false, reason: 'directory_full' }
    }
  }

  const liveTerminal = await findLiveTerminalByHandle(runtime, params.terminalHandle)
  const sanitizedRole = sanitizeRole(params.role)
  const sanitizedTitle = sanitizeTitle(liveTerminal?.title ?? null)

  const result = db.upsertAgentByPaneSuffix({
    displayName: params.displayName,
    role: sanitizedRole?.value ?? null,
    hostId,
    paneKey: params.paneKey,
    terminalHandle: params.terminalHandle,
    processIncarnation: params.processIncarnation,
    worktreeId: liveTerminal?.worktreeId ?? null,
    worktreePath: liveTerminal?.worktreePath ?? null,
    branch: liveTerminal?.branch ?? null,
    title: sanitizedTitle?.value ?? null,
    agentLabel: deriveAgentLabelSlug(liveTerminal?.title ?? null),
    originHandle: params.terminalHandle,
    originHostId: hostId,
    isPaneLive: (paneKey) => {
      const signals = runtime.getAgentDirectoryLivenessSignals(paneKey)
      return signals.terminalHandle !== null || signals.observedLive
    }
  })

  if (result.outcome === 'name_taken') {
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: params.paneKey,
      actorHostId: hostId,
      verb: 'register',
      outcome: 'name_taken',
      reasonCode: null
    })
    return {
      ok: false,
      reason: 'name_taken',
      liveTerminalHandle: result.liveTerminalHandle,
      holderPaneDead: result.holderPaneDead,
      alternative: result.alternative
    }
  }

  const isDerivedPlaceholderReclaim =
    result.outcome === 'reminted' &&
    existingForPane != null &&
    existingForPane.derived === 1 &&
    existingForPane.id !== result.agent.id
  const isPromoteSuccession =
    result.outcome === 'reminted' &&
    existingForPane != null &&
    existingForPane.derived === 1 &&
    existingForPane.id === result.agent.id
  const isDeadPaneIdentityTakeover = result.outcome === 'reminted' && !existingForPane

  const catchUp = db.catchUpThreadSuccession(hostId, result.agent.display_name, result.agent.id)
  const totalAdoptedThreads = result.adoptedThreads + (catchUp?.adoptedThreads ?? 0)
  const totalPredecessorCount = catchUp ? catchUp.predecessorCount : result.predecessorCount

  db.writeAgentAudit({
    agentId: result.agent.id,
    actorPaneKey: params.paneKey,
    actorHostId: hostId,
    verb: 'register',
    outcome: result.outcome,
    reasonCode: isDeadPaneIdentityTakeover
      ? `dead-pane identity takeover: name "${params.displayName}" reclaimed by a new pane after ` +
        'its previous holder pane stopped resolving live'
      : isDerivedPlaceholderReclaim
        ? `derived-placeholder reclaim: name "${params.displayName}" re-bound to this pane over a ` +
          'derived row minted by a directory listing'
        : isPromoteSuccession
          ? `name succession: "${params.displayName}" acquired by an existing row; ` +
            `${totalAdoptedThreads} thread(s) from ${totalPredecessorCount} predecessor(s)`
          : null
  })

  const repointedMessages = result.repointedMessages + (catchUp?.repointedMessages ?? 0)
  const unreadWaiting = db.getUnreadMessages(`agent:${result.agent.id}`).length
  if (unreadWaiting > 0) {
    runtime.notifyMessageArrived(`agent:${result.agent.id}`, 'status', null, null)
  }

  return {
    ok: true,
    agent: result.agent,
    created: result.outcome === 'created',
    reMinted: result.outcome === 'reminted',
    repointedMessages,
    pendingOnOldHandle: result.pendingOnOldHandle,
    unreadWaiting,
    adoptedThreads: totalAdoptedThreads,
    blockedByQuarantinedPredecessor:
      result.blockedByQuarantinedPredecessor || (catchUp?.blockedByQuarantinedPredecessor ?? false),
    pendingPeerQuestions: catchUp ? catchUp.pendingPeerQuestions : result.pendingPeerQuestions,
    unreadMailOnRetiredId: catchUp ? catchUp.unreadMailOnRetiredId : result.unreadMailOnRetiredId
  }
}
