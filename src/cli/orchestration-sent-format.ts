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
  if (delivery.state === 'read') {
    return headline
  }
  return `${headline}\nNext step: ${cliCommand} orchestration sent --id ${messageId} --json — check again for a state change.`
}
