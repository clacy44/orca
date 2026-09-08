// S10-1b: orchestration.agents.register. Split out of orchestration-agents.ts to stay under the
// max-lines ratchet — see that file for the shared CONTAINMENT #1 identity note.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { NO_PANE_IDENTITY_NEXT_STEPS } from './orchestration-caller-identity'
import { hostIdFor, rateLimited, toPublicAgentView } from './agent-directory-rpc-view'
import { registerAgentForPane } from './register-agent-for-pane'

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

      // [S10-21d b3, DEC-6] The write itself — name validation, the directory cap, the
      // live-terminal lookup, the upsert-by-pane-suffix, succession catch-up, and the unread-mail
      // wake — is extracted to register-agent-for-pane.ts so an in-process caller (the launcher's
      // `requestChairRestore`) can perform the SAME registration without a wire round-trip. This
      // handler keeps only its auth check and rate limits (above), then maps the outcome onto the
      // RPC's own error/response shape.
      const outcome = await registerAgentForPane(db, runtime, {
        paneKey: authority.paneKey,
        terminalHandle: authority.terminalHandle,
        processIncarnation: authority.processIncarnation,
        displayName: params.name,
        role: params.role
      })

      if (!outcome.ok) {
        if (outcome.reason === 'invalid_name') {
          throw new OrchestrationError(
            'invalid_argument',
            `--name "${params.name}" is invalid (${outcome.reasonCode}). Use a lowercase ASCII slug, 3-32 chars, no leading/trailing/double hyphen, not a reserved word.`
          )
        }
        if (outcome.reason === 'directory_full') {
          throw new OrchestrationError(
            'directory_full',
            `This host already has ${DIRECTORY_LIVE_CAP} registered agents.`,
            { nextSteps: ['orca agents list --state gone'] }
          )
        }
        // R1: name the live pane so the caller can tell "someone else is genuinely using this
        // name right now" from a stale refusal, instead of one indistinguishable message either way.
        const heldByNote = outcome.liveTerminalHandle
          ? ` It is currently live on pane ${outcome.liveTerminalHandle}.`
          : outcome.holderPaneDead
            ? " Its holder's pane is gone; retiring it frees the name."
            : ''
        throw new OrchestrationError(
          'name_taken',
          `The name "${params.name}" is already registered.${heldByNote}`,
          {
            nextSteps: [
              ...(outcome.holderPaneDead
                ? [`orca agents retire ${params.name} --force  (frees the name; operator's call)`]
                : []),
              `orca agents register --name ${outcome.alternative} --role "<your role>"`
            ]
          }
        )
      }

      return {
        agent: toPublicAgentView(outcome.agent, true),
        created: outcome.created,
        reMinted: outcome.reMinted,
        repointedMessages: outcome.repointedMessages,
        unreadWaiting: outcome.unreadWaiting,
        pendingOnOldHandle: outcome.pendingOnOldHandle,
        adoptedThreads: outcome.adoptedThreads,
        blockedByQuarantinedPredecessor: outcome.blockedByQuarantinedPredecessor,
        pendingPeerQuestions: outcome.pendingPeerQuestions,
        unreadMailOnRetiredId: outcome.unreadMailOnRetiredId
      }
    }
  })
]
