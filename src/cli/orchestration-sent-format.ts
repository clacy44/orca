import type { OrchestrationSentResult } from '../shared/orchestration-delivery-state'

export function formatOrchestrationSent(
  result: OrchestrationSentResult,
  messageId: string,
  cliCommand: string
): string {
  const { delivery } = result
  const recipient =
    delivery.recipient.state === 'unresolved'
      ? 'recipient not currently resolvable'
      : `recipient ${delivery.recipient.state}`
  const state =
    delivery.state === 'queued_awaiting_pane'
      ? 'queued, delivery withheld (pane busy or unconfirmed idle)'
      : delivery.state
  const headline = `${messageId}: ${state} (${recipient}).`
  // V-6: `environment` is set only for a 'relayed'/'relay_pending' row (the saved-environment
  // id parsed out of its `remote:<environmentId>:<agentId>` to_handle) — print it on its own
  // line, same terse style as the rest of this formatter, whenever the snapshot carries it.
  const environmentLine = delivery.environment ? `\nenvironment: ${delivery.environment}` : ''
  if (delivery.state === 'read') {
    return `${headline}${environmentLine}`
  }
  return `${headline}${environmentLine}\nNext step: ${cliCommand} orchestration sent --id ${messageId} --json — check again for a state change.`
}
