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
