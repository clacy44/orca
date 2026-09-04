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
        //
        // Corroborated, not a single instantaneous bit: `terminalHandle !== null` alone is one
        // read of the connected-pty map, which can transiently miss a pane that is still
        // genuinely alive (a reload/reconnect blip). `observedLive`/`lastAgentStatus` come from
        // the last-known leaf record independently of whether a pty is connected *right now* —
        // classifyAgentLiveness (agent-directory.ts) already treats these as corroborating
        // signals for a row's own liveness; an identity handover gets at least the same bar.
        // Every extra condition here only ever makes a holder read MORE live (harder to take
        // over), never less — this cannot turn a genuinely-dead holder into a live one.
        // S10-11 verify + fix-round synthesis: the paneResolves signal plus the TRANSIENT
        // observedLive guard (a reconnect blip must not read as a dead pane and become a
        // takeover window). Deliberately NOT lastAgentStatus — that value is sticky and a
        // long-dead pane retaining one would block its own legitimate rebind, the exact
        // field failure this slice exists to fix.
        isPaneLive: (paneKey) => {
          const signals = runtime.getAgentDirectoryLivenessSignals(paneKey)
          return signals.terminalHandle !== null || signals.observedLive
        }
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
          : result.holderPaneDead
            ? " Its holder's pane is gone; retiring it frees the name."
            : ''
        throw new OrchestrationError(
          'name_taken',
          `The name "${params.name}" is already registered.${heldByNote}`,
          {
            nextSteps: [
              ...(result.holderPaneDead
                ? [`orca agents retire ${params.name} --force  (frees the name; operator's call)`]
                : []),
              `orca agents register --name ${result.alternative} --role "<your role>"`
            ]
          }
        )
      }

      // Auditability: `existingForPane` (computed above, before the upsert) already tells apart
      // the two ways a 'reminted' outcome happens — the SAME pane re-registering (its own row,
      // found by pane-suffix, no identity change of hands) vs. a DIFFERENT pane taking over a
      // name-holder row whose pane read dead (an actual identity handover). Both used to write
      // the same outcome with no reason — indistinguishable in the audit trail from each other,
      // and from any other 'reminted' row. Only the handover case gets the descriptive code.
      // F-19 (Ruling 33(a)): a reclaim is a 'reminted' row whose PANE-FOUND row (existingForPane)
      // was a derived placeholder distinct from the id register actually landed on — the
      // dead-pane-by-NAME takeover above (existingForPane null) is a different shape entirely.
      const isDerivedPlaceholderReclaim =
        result.outcome === 'reminted' &&
        existingForPane != null &&
        existingForPane.derived === 1 &&
        existingForPane.id !== result.agent.id
      const isDeadPaneIdentityTakeover = result.outcome === 'reminted' && !existingForPane
      db.writeAgentAudit({
        agentId: result.agent.id,
        actorPaneKey: authority.paneKey,
        actorHostId: hostId,
        verb: 'register',
        outcome: result.outcome,
        reasonCode: isDeadPaneIdentityTakeover
          ? `dead-pane identity takeover: name "${params.name}" reclaimed by a new pane after ` +
            'its previous holder pane stopped resolving live'
          : isDerivedPlaceholderReclaim
            ? `derived-placeholder reclaim: name "${params.name}" re-bound to this pane over a ` +
              'derived row minted by a directory listing'
            : null
      })

      // Ruling 32 Addendum 10 (A3/F-5b/F-18): both outcomes can now repoint stranded mail —
      // 'created' from a bare-name address (agent-mailbox-repoint.ts's name-bind repoint) and/or
      // a retired predecessor's `agent:<old id>` mailbox (F-18, agent-thread-succession.ts);
      // 'reminted' from a bare terminal handle and/or a bare-name address. Always the true total
      // moved into `result.agent.id`'s mailbox this call, never just one contributing surface.
      const repointedMessages = result.repointedMessages
      // F-19 B2 (Ruling 33(a)): any unread mail sitting on the landed id's mailbox — whether it
      // arrived via the repoint above or was already waiting (e.g. a reclaimed identity's own
      // prior mail) — must wake the pane, not just the subset this call itself just moved.
      const unreadWaiting = db.getUnreadMessages(`agent:${result.agent.id}`).length
      if (unreadWaiting > 0) {
        runtime.notifyMessageArrived(`agent:${result.agent.id}`, 'status', null, null)
      }

      return {
        agent: toPublicAgentView(result.agent, true),
        created: result.outcome === 'created',
        reMinted: result.outcome === 'reminted',
        repointedMessages,
        // F-19 B2 (Ruling 33(a)): unread mail waiting on the landed id's mailbox right now,
        // whether from this call's own repoint or already present — the CLI prints one line
        // when nonzero so a reclaimed pane knows to run `check` instead of sitting pull-only.
        unreadWaiting,
        // H4d (Ruling 32 Addendum 13): both outcomes carry pendingOnOldHandle now — a 'created'
        // row can leave a bare-name/succession backlog past the batch ceiling exactly like a
        // 'reminted' row can (agent-directory.ts's UpsertAgentByPaneSuffixResult carries the
        // field on both). Nonzero only past that per-call batch ceiling
        // (agent-mailbox-repoint.ts) — those rows are not reachable by any other path once this
        // call's transaction commits.
        pendingOnOldHandle: result.pendingOnOldHandle,
        // R2: a tombstoned predecessor under this same host+name whose thread membership this
        // fresh id just inherited. Always 0 on a 'reminted' row (its id, and so its membership,
        // was never orphaned in the first place).
        adoptedThreads: result.outcome === 'created' ? result.adoptedThreads : 0,
        // F-9 (Ruling 32(b)): true when a quarantined predecessor under this name blocked
        // adoption outright (by design). Lets the CLI say WHICH threads were not inherited and
        // why, instead of a bare 0 reading the same as "nothing to inherit".
        blockedByQuarantinedPredecessor:
          result.outcome === 'created' ? result.blockedByQuarantinedPredecessor : false,
        // F-9 (Ruling 32 Addendum 9): what a tombstoned predecessor's pending peer questions and
        // unread bare-handle mail left behind on register -- neither is repointed onto the fresh
        // successor id (deferred by ruling), so this counts what the CLI must say was NOT
        // inherited. Always 0 on a 'reminted' row (its id was never orphaned).
        pendingPeerQuestions: result.outcome === 'created' ? result.pendingPeerQuestions : 0,
        unreadMailOnRetiredId: result.outcome === 'created' ? result.unreadMailOnRetiredId : 0
      }
    }
  })
]
