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
      // the ways a 'reminted' outcome happens — the SAME pane re-registering (its own row,
      // found by pane-suffix, no identity change of hands) vs. a DIFFERENT pane taking over a
      // name-holder row whose pane read dead (an actual identity handover) vs. this pane's own
      // (possibly derived) row PROMOTING into a name it did not hold before (F-9b, Ruling 33
      // Addendum 1). Only the noteworthy shapes get a descriptive code.
      // F-19 (Ruling 33(a)): a reclaim is a 'reminted' row whose PANE-FOUND row (existingForPane)
      // was a derived placeholder distinct from the id register actually landed on — the
      // dead-pane-by-NAME takeover below (existingForPane null) is a different shape entirely.
      const isDerivedPlaceholderReclaim =
        result.outcome === 'reminted' &&
        existingForPane != null &&
        existingForPane.derived === 1 &&
        existingForPane.id !== result.agent.id
      // F-9b: the rename/promote shape — `existingForPane` IS `result.agent` (same id), was
      // derived before this call, and is not the reclaim above (that requires a DIFFERENT id).
      const isPromoteSuccession =
        result.outcome === 'reminted' &&
        existingForPane != null &&
        existingForPane.derived === 1 &&
        existingForPane.id === result.agent.id
      const isDeadPaneIdentityTakeover = result.outcome === 'reminted' && !existingForPane

      // F-9b catch-up (Ruling 33 Addendum 1): a successor that missed succession on an earlier
      // register (registered before this fix landed) catches up here, idempotently — a no-op
      // once a `thread_succession` audit row already marks this id (that row, inserted by
      // adoptPredecessorThreadMembership itself when it adopts anything, IS the marker — no
      // second audit row needed here). Runs on EVERY outcome (created or reminted), not just
      // the promote shape above, since the historical bug this repairs could have left ANY
      // successor's row un-adopted.
      // F-7 (attacker-lens review, Ruling 33(a) H6a): moved ABOVE the audit write below — the
      // isPromoteSuccession reason string must report the TOTAL adopted (this call's own
      // upsert plus any catch-up), never just the upsert's own share.
      const catchUp = db.catchUpThreadSuccession(hostId, result.agent.display_name, result.agent.id)
      const totalAdoptedThreads = result.adoptedThreads + (catchUp?.adoptedThreads ?? 0)
      // F-9 (BLOCKER, Ruling 33 Addendum 1): predecessorCount is NOT incremental like
      // adoptedThreads/repointedMessages above — both the inline upsert's own succession call
      // and the catch-up re-derive it over the SAME predecessor set (countUninheritedPredecessorMail
      // and adoptFromPredecessors's `predecessors.length`, agent-thread-succession.ts:170/177/198-202),
      // so summing double-counts every predecessor once the catch-up runs. When the catch-up ran
      // it is the authoritative post-repoint figure (computed after its own mailbox repoint); use
      // it alone. Otherwise (no catch-up needed) the inline figure is the only figure there is.
      // F-2 (D-R98, attacker-lens review): on the derived-reclaim arm the inline figure
      // (result.predecessorCount) already includes the displaced derived row's own id-keyed
      // predecessor (+1, adoptFromPredecessors by id) — a predecessor the catch-up's name-keyed
      // scan can never see, since that row never shared nameHolder's display_name. Accepted
      // here because predecessorCount is not returned over RPC, and the reclaim arm's
      // reasonCode string (isDerivedPlaceholderReclaim below) never interpolates
      // totalPredecessorCount at all — only the isPromoteSuccession arm does — so the
      // catch-up figure's narrower count is never surfaced as wrong on the reclaim arm.
      const totalPredecessorCount = catchUp ? catchUp.predecessorCount : result.predecessorCount

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
            : isPromoteSuccession
              ? `name succession: "${params.name}" acquired by an existing row; ` +
                `${totalAdoptedThreads} thread(s) from ${totalPredecessorCount} predecessor(s)`
              : null
      })

      // Ruling 32 Addendum 10 (A3/F-5b/F-18): both outcomes can now repoint stranded mail —
      // 'created' from a bare-name address (agent-mailbox-repoint.ts's name-bind repoint) and/or
      // a retired predecessor's `agent:<old id>` mailbox (F-18, agent-thread-succession.ts);
      // 'reminted' from a bare terminal handle and/or a bare-name address, and now (F-9b) from
      // succession/catch-up too. Always the true total moved into `result.agent.id`'s mailbox
      // this call, never just one contributing surface.
      const repointedMessages = result.repointedMessages + (catchUp?.repointedMessages ?? 0)
      // F-19 B2 (Ruling 33(a)): any unread mail sitting on the landed id's mailbox — whether it
      // arrived via a repoint above or was already waiting (e.g. a reclaimed identity's own
      // prior mail) — must wake the pane, not just the subset this call itself just moved.
      // Computed AFTER catch-up so a succession repoint it just performed is included.
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
        // (agent-mailbox-repoint.ts). F-3 (D-R98, attacker-lens review): this does NOT mean
        // those rows are unreachable by any other path — the caller's own bare-handle
        // contribution to that ceiling stays readable through `check`'s own handle union
        // (orchestration.ts's `address`/`handle` merge in both the peek/all branch, ~1861-1865,
        // and readMailboxDelivery's fetchCandidates, ~1896-1897) for as long as it stays
        // unread; this field only reports how much this register call itself did not move.
        pendingOnOldHandle: result.pendingOnOldHandle,
        // R2/F-9b: a tombstoned predecessor under this same host+name whose thread membership
        // this id just inherited — on 'created' (a fresh id), on 'reminted' (the rename/promote
        // shape, or H5's B1 reclaim adopting its displaced derived row), and now (F-9b
        // catch-up) on any outcome that had missed succession on an earlier register.
        adoptedThreads: totalAdoptedThreads,
        // F-9 (Ruling 32(b)): true when a quarantined predecessor under this name blocked
        // adoption outright (by design). Lets the CLI say WHICH threads were not inherited and
        // why, instead of a bare 0 reading the same as "nothing to inherit".
        blockedByQuarantinedPredecessor:
          result.blockedByQuarantinedPredecessor ||
          (catchUp?.blockedByQuarantinedPredecessor ?? false),
        // F-9 (Ruling 32 Addendum 9): what a tombstoned predecessor's pending peer questions and
        // unread bare-handle mail left behind on register -- neither is repointed onto the
        // successor id (deferred by ruling), so this counts what the CLI must say was NOT
        // inherited. Read on BOTH outcomes now (F-9b) — a 'reminted' row's own predecessors can
        // leave exactly the same uninherited backlog a 'created' row's can.
        // F-2 (attacker-lens review, Ruling 33(a) H6a): also summed with the catch-up's own
        // uninherited count — the register-RPC catch-up (agent-thread-succession.ts) is a
        // second place succession can run, and it left this same backlog unreported before.
        // F-9 (BLOCKER): same re-derived-total shape as totalPredecessorCount above — when the
        // catch-up ran, its own countUninheritedPredecessorMail scan (post-repoint) is the
        // authoritative figure; summing it with the inline result double-counts the same
        // predecessors' backlog. Use the catch-up's figure alone when it ran.
        pendingPeerQuestions: catchUp ? catchUp.pendingPeerQuestions : result.pendingPeerQuestions,
        unreadMailOnRetiredId: catchUp
          ? catchUp.unreadMailOnRetiredId
          : result.unreadMailOnRetiredId
      }
    }
  })
]
