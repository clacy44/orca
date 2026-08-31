// S10-2c: `orca agents ask|reply` — the peer ask/answer surface (orchestration.ask's `agent:`
// branch, orchestration.reply). Split out of agents.ts to stay under the max-lines ratchet.
//
// "One command to start" (s10-2-spec.md:140): `orca agents ask <name> "<question>"` needs no
// prior `agents thread --new` — a peer `to: agent:<id>` ask mints its own thread server-side
// (handlePeerAsk, orchestration.ts). Identity for the asker/answerer comes only from the
// runtime's attested caller (never a CLI-supplied handle) — this file never sends `--from`.
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { resolveOrchestrationAskClientTimeoutMs } from '../../shared/orchestration-ask-timeout'
import { requireNonQuarantined, resolveAgentByNameOrId } from './agents-shared'

type AskResult = {
  answer: string | null
  messageId: string | null
  answerMessageId?: string | null
  threadId: string
  timedOut: boolean
  cancelled?: boolean
  connectionLost?: boolean
  timeoutMs?: number
}

type ReplyResult = {
  message: { id: string; thread_id: string | null }
  duplicate?: boolean
}

function formatAsk(r: AskResult, waitedMs: number): string {
  if (r.cancelled) {
    return r.connectionLost
      ? `ask connection closed (question ${r.messageId ?? '?'}, thread ${r.threadId}).`
      : `ask cancelled (question ${r.messageId ?? '?'}, thread ${r.threadId}).`
  }
  if (r.timedOut) {
    return (
      `Still pending after ${Math.round(waitedMs / 1000)}s (thread ${r.threadId}).\n` +
      `Resume without re-asking: orca agents wait --thread ${r.threadId} --for reply`
    )
  }
  return (
    `${r.answer}\n` +
    `(thread ${r.threadId}, waited ${Math.round(waitedMs / 1000)}s)\n` +
    `Continue: orca agents reply --thread ${r.threadId} --body "..."`
  )
}

function formatReply(r: ReplyResult): string {
  const dup = r.duplicate ? ' (duplicate of a previous answer; not re-sent)' : ''
  const threadHint = r.message.thread_id ? ` --id ${r.message.thread_id}` : ''
  return `Replied ${r.message.id}${dup}.\nNext: orca agents thread${threadHint}`
}

export const AGENT_ASK_REPLY_HANDLERS: Record<string, CommandHandler> = {
  'agents ask': async ({ flags, client, json }) => {
    const name = getOptionalStringFlag(flags, 'name')
    const question = getOptionalStringFlag(flags, 'question')
    const resume = getOptionalStringFlag(flags, 'resume')
    if ((question ? 1 : 0) + (resume ? 1 : 0) !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass a question, or --resume <question-id>.'
      )
    }
    let to: string | undefined
    if (!resume) {
      if (!name) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Pass an agent name: orca agents ask <name> "<question>"'
        )
      }
      const agent = requireNonQuarantined(await resolveAgentByNameOrId(client, name))
      to = `agent:${agent.id}`
    }
    const timeoutMsNumber = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const startedAt = Date.now()
    const result = await client.call<AskResult>(
      'orchestration.ask',
      {
        to,
        question,
        resume,
        options: getOptionalStringFlag(flags, 'options'),
        timeoutMs: timeoutMsNumber,
        acknowledgeGate: flags.has('acknowledge-gate') ? true : undefined
      },
      { timeoutMs: resolveOrchestrationAskClientTimeoutMs(timeoutMsNumber) }
    )
    const waitedMs = result.result.timeoutMs ?? Date.now() - startedAt
    // Why bypass printResult's json branch here too (matches `orchestration ask`): --json emits
    // the bare RPC result so `jq -r .answer` keeps working, not an envelope.
    if (json) {
      console.log(JSON.stringify(result.result))
    } else {
      console.log(formatAsk(result.result, waitedMs))
    }
    // s10-2-spec.md WAIT/ASK §: "A timeout is exit 0... a re-ask is a second question the peer
    // must answer twice" — only a genuine cancellation (interrupted connection) is exit 1.
    if (result.result.cancelled) {
      process.exitCode = 1
    }
  },

  'agents reply': async ({ flags, client, json }) => {
    const threadFlag = getOptionalStringFlag(flags, 'thread')
    const idFlag = getOptionalStringFlag(flags, 'id')
    if ((threadFlag ? 1 : 0) + (idFlag ? 1 : 0) !== 1) {
      throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --thread or --id.')
    }
    const body = getRequiredStringFlag(flags, 'body')

    let id = idFlag
    if (!id) {
      const threadResult = await client.call<{ messages: { id: string }[] }>(
        'orchestration.threads.get',
        { id: threadFlag }
      )
      const last = threadResult.result.messages.at(-1)
      if (!last) {
        throw new RuntimeClientError(
          'invalid_argument',
          `Thread ${threadFlag} has no messages yet; nothing to reply to.`
        )
      }
      id = last.id
    }

    const result = await client.call<ReplyResult>('orchestration.reply', {
      id,
      body,
      acknowledgeGate: flags.has('acknowledge-gate') ? true : undefined
    })
    printResult(result, json, formatReply)
  }
}
