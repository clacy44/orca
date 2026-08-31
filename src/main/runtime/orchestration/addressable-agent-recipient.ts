// Amendment B: reply must mirror send's `agent:` recipient guards (ruling 3's "reply is a
// second to_handle writer that can still carry an agent: address via a forged from"). Shared
// so both write paths enforce the identical rule, quarantine checked FIRST (the derived
// refusal's nextSteps name the pane's bare handle, and handing that address out for a
// quarantined row is a working bypass of the quarantine itself).
//
// Split out of orchestration.ts (S10-8 R3) so orchestration-federated-peer-ask.ts can reuse it
// without a circular import back into orchestration.ts — a relayed cross-host ask resolves its
// local recipient through the exact same quarantine/derived guards a local peer ask already
// enforces, never a second, drifting copy of this check.
import { OrchestrationError } from './orchestration-error'
import type { OrchestrationDb } from './db'

export function requireAddressableAgentRecipient(
  db: OrchestrationDb,
  agentId: string
): NonNullable<ReturnType<OrchestrationDb['getAgentById']>> {
  const agentRecipient = db.getAgentById(agentId)
  if (!agentRecipient) {
    // S10-7 F-B: tell "never existed" apart from "retired" — a tombstoned row still resolves
    // via the tombstone-inclusive raw read, so mail to it names the successor (a live row that
    // reclaimed its display_name) instead of the generic agent_unknown message.
    const retired = db.getAgentByIdIncludingTombstoned(agentId)
    if (retired?.tombstoned_at) {
      const successor = db.getAgentByName(retired.host_id, retired.display_name)
      throw new OrchestrationError(
        'agent_retired',
        `Agent ${retired.display_name} (${agentId}) has been retired and can no longer receive mail.`,
        {
          nextSteps: successor
            ? [`orca orchestration send --to agent:${successor.id} --subject "..."`]
            : ['orca agents find "<plain English description>"', 'orca agents list']
        }
      )
    }
    throw new OrchestrationError('agent_unknown', `Agent ${agentId} was not found.`, {
      nextSteps: ['orca agents find "<plain English description>"', 'orca agents list']
    })
  }
  if (agentRecipient.quarantined === 1) {
    throw new OrchestrationError(
      'agent_quarantined',
      `Agent ${agentRecipient.display_name} is quarantined and cannot receive mail.`,
      { nextSteps: [`orca agents show --id ${agentRecipient.id}`] }
    )
  }
  if (agentRecipient.derived === 1) {
    const bareHandle = agentRecipient.terminal_handle
    throw new OrchestrationError(
      'derived_agent_unaddressable',
      `Agent ${agentRecipient.display_name} is not registered — agent:${agentRecipient.id} has no reader.`,
      {
        nextSteps: [
          bareHandle
            ? `orca orchestration send --to ${bareHandle} --subject "..."`
            : 'orca agents list',
          'orca agents register --name <slug> --role "<your role>" (run on that pane to make it addressable)'
        ]
      }
    )
  }
  return agentRecipient
}
