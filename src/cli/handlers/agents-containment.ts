// S10-2c: `orca agents purge|review` — the containment surface (orchestration.messages.purge,
// orchestration.agents.review). `orca agents quarantine` already exists (S10-1c, agents.ts) and
// is left as-is. Split out to stay under the max-lines ratchet.
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { resolveAgentByNameOrId } from './agents-shared'

type PurgeMessageResult = {
  outcome: 'purged' | 'already_purged'
  message: { id: string; thread_id: string | null }
  alreadyPurged: boolean
}
type PurgeThreadResult = { outcome: 'purged'; purgedCount: number }
type PurgeResult = PurgeMessageResult | PurgeThreadResult

type ReviewMessageRow = {
  id: string
  type: string
  to_handle: string
  subject: string
  purged_at?: string | null
}
type ReviewResult = {
  agent: { id: string; displayName: string }
  messages: ReviewMessageRow[]
}

function formatPurge(r: PurgeResult): string {
  if ('purgedCount' in r) {
    return `Purged ${r.purgedCount} message(s) from the thread. Federated copies already relayed are not reachable.`
  }
  return r.alreadyPurged
    ? `Message ${r.message.id} was already purged.`
    : `Purged message ${r.message.id}. Its body is gone from every reader, including anyone who joins the thread later.`
}

function formatReview(r: ReviewResult): string {
  if (r.messages.length === 0) {
    return `${r.agent.displayName} (${r.agent.id}) has no authored messages.`
  }
  const lines = r.messages.map(
    (m) => `${m.id} [${m.type}] -> ${m.to_handle}: "${m.subject}"${m.purged_at ? ' [purged]' : ''}`
  )
  return `${r.agent.displayName} (${r.agent.id}):\n${lines.join('\n')}`
}

export const AGENT_CONTAINMENT_HANDLERS: Record<string, CommandHandler> = {
  'agents purge': async ({ flags, client, json }) => {
    const messageId = getOptionalStringFlag(flags, 'message')
    const threadId = getOptionalStringFlag(flags, 'thread')
    if ((messageId ? 1 : 0) + (threadId ? 1 : 0) !== 1) {
      throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --message or --thread.')
    }
    const result = await client.call<PurgeResult>('orchestration.messages.purge', {
      messageId,
      threadId,
      reason: getRequiredStringFlag(flags, 'reason'),
      acknowledgeGate: flags.has('acknowledge-gate') ? true : undefined
    })
    printResult(result, json, formatPurge)
  },

  'agents review': async ({ flags, client, json }) => {
    const target = getOptionalStringFlag(flags, 'agent')
    if (!target) {
      throw new RuntimeClientError('invalid_argument', 'Pass an agent name or id.')
    }
    const agent = await resolveAgentByNameOrId(client, target)
    const result = await client.call<ReviewResult>('orchestration.agents.review', {
      agentId: agent.id,
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatReview)
  }
}
