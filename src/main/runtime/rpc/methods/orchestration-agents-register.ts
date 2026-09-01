// S10-1b: orchestration.agents.register. Split out of orchestration-agents.ts to stay under the
// max-lines ratchet — see that file for the shared CONTAINMENT #1 identity note.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { NO_PANE_IDENTITY_NEXT_STEPS } from './orchestration-caller-identity'
import {
  sanitizeRole,
  sanitizeTitle,
  validateDisplayNameCandidate
} from '../../orchestration/agent-name-sanitizer'
import { deriveAgentLabelSlug } from '../../orchestration/agent-derivation'
import { findLiveTerminalByHandle } from './agent-directory-rpc-liveness'
import { hostIdFor, rateLimited, toPublicAgentView } from './agent-directory-rpc-view'

const HOUR_MS = 60 * 60 * 1000
const DIRECTORY_LIVE_CAP = 200

const RegisterParams = z.object({
  name: requiredString('Missing --name'),
  role: OptionalString
})

export const ORCHESTRATION_AGENTS_REGISTER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.register',
    params: RegisterParams,
    handler: async (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      if (!authority) {
        throw new OrchestrationError(
          'no_pane_identity',
          'This command must run inside a live, attested Orca terminal.',
          { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
        )
      }
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)

      const paneRate = db.checkAndBumpRate({
        subjectKey: authority.paneKey,
        verb: 'register',
        windowMs: HOUR_MS,
        limit: 10
      })
      if (!paneRate.allowed) {
        throw rateLimited(paneRate.retryAfterMs)
      }
      const hostRate = db.checkAndBumpRate({
        subjectKey: hostId,
        verb: 'register',
        windowMs: HOUR_MS,
        limit: 30
      })
      if (!hostRate.allowed) {
        throw rateLimited(hostRate.retryAfterMs)
      }

      const nameValidation = validateDisplayNameCandidate(params.name)
      if (!nameValidation.ok) {
        throw new OrchestrationError(
          'invalid_argument',
          `--name "${params.name}" is invalid (${nameValidation.reasonCode}). Use a lowercase ASCII slug, 3-32 chars, no leading/trailing/double hyphen, not a reserved word.`
        )
      }

      const existingForPane = db.getAgentByPaneKey(hostId, authority.paneKey)
      if (!existingForPane) {
        const liveCount = db.listAgents({
          hostId,
          includeDerived: false,
          includeQuarantined: true,
          limit: DIRECTORY_LIVE_CAP
        }).agents.length
        if (liveCount >= DIRECTORY_LIVE_CAP) {
          throw new OrchestrationError(
            'directory_full',
            `This host already has ${DIRECTORY_LIVE_CAP} registered agents.`,
            { nextSteps: ['orca agents list --state gone'] }
          )
        }
      }

      const liveTerminal = await findLiveTerminalByHandle(runtime, authority.terminalHandle)
      const sanitizedRole = sanitizeRole(params.role)
      const sanitizedTitle = sanitizeTitle(liveTerminal?.title ?? null)

      const result = db.upsertAgentByPaneSuffix({
        displayName: params.name,
        role: sanitizedRole?.value ?? null,
        hostId,
        paneKey: authority.paneKey,
        terminalHandle: authority.terminalHandle,
        processIncarnation: authority.processIncarnation,
        worktreeId: liveTerminal?.worktreeId ?? null,
        worktreePath: liveTerminal?.worktreePath ?? null,
        branch: liveTerminal?.branch ?? null,
        title: sanitizedTitle?.value ?? null,
        agentLabel: deriveAgentLabelSlug(liveTerminal?.title ?? null),
        originHandle: authority.terminalHandle,
        originHostId: hostId,
        // R1: same liveness read the periodic refresh uses (agent-directory-rpc-liveness.ts's
        // `paneResolves`) — a name held by a row whose pane no longer resolves to a live pty is
        // dead, never a reason to refuse this register or mint a second, anonymous identity.
        isPaneLive: (paneKey) =>
          runtime.getAgentDirectoryLivenessSignals(paneKey).terminalHandle !== null
      })

      if (result.outcome === 'name_taken') {
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: authority.paneKey,
          actorHostId: hostId,
          verb: 'register',
          outcome: 'name_taken',
          reasonCode: null
        })
        // R1: name the live pane so the caller can tell "someone else is genuinely using this
        // name right now" from a stale refusal, instead of one indistinguishable message either way.
        const heldByNote = result.liveTerminalHandle
          ? ` It is currently live on pane ${result.liveTerminalHandle}.`
          : ''
        throw new OrchestrationError(
          'name_taken',
          `The name "${params.name}" is already registered.${heldByNote}`,
          { nextSteps: [`orca agents register --name ${result.alternative} --role "<your role>"`] }
        )
      }

      db.writeAgentAudit({
        agentId: result.agent.id,
        actorPaneKey: authority.paneKey,
        actorHostId: hostId,
        verb: 'register',
        outcome: result.outcome,
        reasonCode: null
      })

      return {
        agent: toPublicAgentView(result.agent, true),
        created: result.outcome === 'created',
        reMinted: result.outcome === 'reminted',
        // S10-7 F-C: how many of the OLD terminal_handle's unread bare-handle messages this
        // re-mint just repointed into the row's durable agent:<id> mailbox. Always 0 on a fresh
        // 'created' row (no prior handle to repoint from).
        repointedMessages: result.outcome === 'reminted' ? result.repointedMessages : 0,
        // Nonzero only past the per-call batch ceiling (agent-mailbox-repoint.ts) — those rows
        // are not reachable by any other path once this re-mint's transaction commits.
        pendingOnOldHandle: result.outcome === 'reminted' ? result.pendingOnOldHandle : 0,
        // R2: a tombstoned predecessor under this same host+name whose thread membership this
        // fresh id just inherited. Always 0 on a 'reminted' row (its id, and so its membership,
        // was never orphaned in the first place).
        adoptedThreads: result.outcome === 'created' ? result.adoptedThreads : 0
      }
    }
  })
]
