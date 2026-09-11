import type { OrchestrationSentResult } from '../shared/orchestration-delivery-state'

export function formatOrchestrationSent(
  result: OrchestrationSentResult,
  messageId: string,
  cliCommand: string
): string {
  const { delivery } = result
  // R106: a cross-host row (relay accepted by the peer, or still awaiting acceptance) has no
  // receipt from the far side at all — 'unresolved' recipient state for these two is a
  // hardcoded placeholder (never a live predicate; see diag-r106-r110-2026-09-08.md), so the
  // generic "recipient not currently resolvable" wording claims knowledge nobody has. Render it
  // honestly instead: what the sender host actually knows (relay accepted/pending, when) and an
  // explicit "delivery state unknown" rather than any resolvability claim.
  if (delivery.state === 'relayed' || delivery.state === 'relay_pending') {
    const environment = delivery.environment ?? 'unknown environment'
    // [S10-21d D-R162 M-3] deliveryConfirmed (reply-outbox 'delivered' branch) is a real receipt
    // from the far side — render "delivered", never the generic relay-acceptance wording below,
    // which explicitly disclaims knowing whether the far side received it.
    const headline =
      delivery.state === 'relayed' && delivery.deliveryConfirmed
        ? `${messageId}: delivered to ${environment}${
            delivery.relayedAt ? ` at ${delivery.relayedAt} UTC` : ''
          }.`
        : delivery.state === 'relayed'
          ? `${messageId}: relayed to ${environment}${
              delivery.relayedAt ? ` at ${delivery.relayedAt} UTC` : ''
            }; delivery state unknown.`
          : `${messageId}: relay pending to ${environment}; delivery state unknown.`
    return `${headline}\nNext step: ${cliCommand} orchestration sent --id ${messageId} --json — check again for a state change.`
  }
  const recipient =
    delivery.recipient.state === 'unresolved'
      ? 'recipient not currently resolvable'
      : `recipient ${delivery.recipient.state}`
  const state =
    delivery.state === 'queued_starved'
      ? `queued, delivery withheld for ${delivery.starvedMinutes ?? 0}m (${delivery.starvedAttempts ?? 0} attempts) — pane never reported idle`
      : delivery.state === 'queued_awaiting_pane'
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
