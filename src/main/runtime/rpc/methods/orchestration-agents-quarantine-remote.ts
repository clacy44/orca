// S10-21b B16b (design §4.7, §7 "orca agents quarantine <name>@<host>"): the RPC/CLI caller for
// `setLocalRemoteAgentQuarantine` — the REMOTE half of `orca agents quarantine`, split from
// orchestration-agents-quarantine.ts (local agents only, S10-1c). Never dials the peer:
// resolution is entirely against this host's OWN `remote_agents` mirror, so containment works
// even when the peer is unreachable, hostile, or itself the quarantine's own subject. Resolves
// the FULL identity set via B2's bounded supersession walk before calling
// `setLocalRemoteAgentQuarantine`'s `allLinks: true` overload for every id in the chain — a
// rebound peer's PRE-rebind pacts are withheld too. Quarantining (never lifting) also triggers
// exactly one coalesced pause relay per affected federated pact via B15's
// emitFederatedPactSideEffect(...,'pause','counterpart_quarantined'), reused through
// autoPausePactsForRemoteAgentChain (pact-lifecycle-autopause.ts) — never a second enqueue path.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { PACT_SUPERSESSION_CHAIN_MAX } from '../../orchestration/db'
import { wakePactThreadBoth } from './orchestration-pact-wake'

const QuarantineRemoteParams = z.object({
  name: OptionalString,
  id: OptionalString,
  host: OptionalString,
  lift: OptionalBoolean,
  reasonCode: OptionalString
})

export const ORCHESTRATION_AGENTS_QUARANTINE_REMOTE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.agents.quarantineRemote',
    params: QuarantineRemoteParams,
    handler: (
      params,
      { runtime, orchestrationCompatibilityEvidence, pairedDeviceId, clientKind }
    ) => {
      if (!params.host) {
        throw new OrchestrationError('invalid_argument', 'Missing host.')
      }
      if (!params.id && !params.name) {
        throw new OrchestrationError('invalid_argument', 'Pass a remote agent name or id.')
      }
      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      // Unlike the local verb, there is no self-quarantine exception here: the caller can never
      // itself BE the remote party being quarantined.
      const isFederatedCaller = pairedDeviceId != null || clientKind === 'mobile'
      if (isFederatedCaller) {
        throw new OrchestrationError(
          'forbidden',
          'Quarantine must be issued locally; a federated caller cannot quarantine a remote mirror.'
        )
      }
      const db = runtime.getOrchestrationDb()
      // Local resolution only (never `callOrchestrationWorkerServer`, which dials the peer) —
      // an unreachable/hostile peer must still be quarantinable.
      const server = runtime.resolveOrchestrationWorkerServer(params.host)
      const target = db.getRemoteAgentBySelector(server.environmentId, {
        name: params.name,
        id: params.id
      })
      if (!target) {
        throw new OrchestrationError(
          'not_found',
          `Remote agent ${params.id ?? params.name}@${params.host} was not found in this host's mirror.`,
          { nextSteps: [`orca agents pact --with <name> --on <thread> --host ${params.host}`] }
        )
      }
      const chain = db.walkRemoteAgentSupersessionChain(
        target.remote_agent_id,
        server.environmentId
      )
      // D-R138 F9: the walker now grows to MAX + 1 (db.ts), so a chain STRICTLY LONGER than the
      // bound is the only overflow signal — a complete chain of exactly MAX identities quarantines.
      if (chain.length > PACT_SUPERSESSION_CHAIN_MAX) {
        throw new OrchestrationError(
          'pact_supersession_chain_too_long',
          `Refused: ${target.display_name}'s supersession chain exceeds the ${PACT_SUPERSESSION_CHAIN_MAX}-link bound; the identity set cannot be proven complete.`
        )
      }
      const quarantined = !params.lift
      for (const remoteAgentId of chain) {
        db.setLocalRemoteAgentQuarantine({
          remoteAgentId,
          quarantined,
          reasonCode: quarantined ? (params.reasonCode ?? null) : null,
          allLinks: true
        })
      }
      db.writeAgentAudit({
        agentId: null,
        actorPaneKey: authority?.paneKey ?? null,
        actorHostId: server.environmentId,
        verb: params.lift ? 'remote_quarantine_lift' : 'remote_quarantine',
        outcome: 'ok',
        reasonCode: params.reasonCode ?? null
      })
      // Never on lift: only quarantining pauses (mirrors orchestration-agents-quarantine.ts's
      // own rule) — lifting is symmetric with the local verb and never itself resumes a pact;
      // `orca agents pact --release` is the only resume path, operator-issued.
      if (quarantined) {
        for (const outcome of db.autoPausePactsForRemoteAgentChain(
          chain,
          server.environmentId,
          'counterpart_quarantined',
          runtime
        )) {
          wakePactThreadBoth(
            runtime,
            outcome.threadId,
            [outcome.proposerAgentId, outcome.withAgentId],
            'paused',
            [`orca agents pact --release --on ${outcome.threadId}`]
          )
        }
      }
      return {
        remoteAgent: {
          id: target.remote_agent_id,
          displayName: target.display_name,
          host: params.host,
          quarantined
        },
        chainLength: chain.length
      }
    }
  })
]
