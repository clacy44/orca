import type { OrchestrationMessageSummary } from '../shared/orchestration-check-output'

export type OrchestrationThreadResult = {
  messages: OrchestrationMessageSummary[]
  count: number
}

// Why the CLI resolves this and not the RPC handler: `orca` is the compatibility-aware binary
// name (orca-ide/orca-dev), which is a CLI concern, not something the wire result should carry.
export function formatOrchestrationThread(
  result: OrchestrationThreadResult,
  threadId: string,
  cliCommand: string
): string {
  if (result.count === 0) {
    return `No messages on thread ${threadId}.`
  }
  const rendered = result.messages
    .map(
      (message) =>
        `${message.id} [${message.type ?? 'status'}] ${message.from_handle} -> ${message.to_handle ?? '?'} "${message.subject ?? ''}"`
    )
    .join('\n')
  const latest = result.messages.at(-1)
  // Why populated and not a placeholder: the printed next command already carries the cursor a
  // caller polling this thread forward needs, ready to paste (S10-0a's next-command convention).
  // Why `sequence` and not `created_at` (S10-0 review minor): created_at's whole-second
  // resolution can't disambiguate two messages sent in the same second; sequence always can.
  const resumeHint =
    latest?.sequence !== undefined
      ? `\nNext step: ${cliCommand} orchestration thread --id ${threadId} --since ${latest.sequence} --json`
      : ''
  return `${rendered}${resumeHint}`
}
