// S10-2c/S10-3b: `orca agents threads|thread|wait` — the durable-thread read/write/blocking-wait
// surface (orchestration.threads.create/.get/.list/.leave, orchestration.wait, now completed with
// `--for step` per ruling 5). Split out of agents.ts to stay under the repo's max-lines ratchet
// (config/scripts/check-max-lines-ratchet.mjs). Pact verbs (`--for pact`, `orca agents
// pact|step`) live in agents-pact.ts; `orca agents invite` lives in agents-invite.ts — both
// separate CommandHandler groups per the max-lines ratchet, not missing surface.
//
// Deviation, documented rather than silently dropped: the spec's `--close`/`--pause` thread
// mutation flags and `--since`'s full omitted:{...,sensitive} shape have no RPC method in this
// tree yet (`db.setThreadState` is wired to no RPC at all) — those flags are not implemented
// here; `db.getThread`/`.list`/`.leave`/`.get`/`orchestration.wait` are. Read receipts (ruling 8)
// need no CLI surface of their own — a full participant read already moves `last_read_sequence`
// server-side on every `.get` (orchestration-thread.ts).
import type { CommandHandler } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { sanitizeMessageText } from '../../shared/message-text'
import { resolveOrchestrationAskClientTimeoutMs } from '../../shared/orchestration-ask-timeout'
import { resolveAgentByNameOrId } from './agents-shared'

type ThreadPact = { state: 'proposed' | 'engaged' | 'released'; turnAgentId: string | null } | null

type ThreadListItem = {
  id: string
  subject: string
  state: string
  sensitive: boolean
  lastMessageAt: string | null
  messageCount: number
  pact: ThreadPact
}
type ThreadsListResult = { threads: ThreadListItem[]; nextSteps: string[] }

type ThreadRow = {
  id: string
  subject: string
  state: string
  sensitive: number
  last_message_sequence: number
  message_count: number
  pact_state: string | null
}
type ThreadParticipantRow = {
  thread_id: string
  participant_key: string
  agent_id: string | null
  handle: string | null
  role: string
  left_at: string | null
}
type ThreadMessageRow = {
  id: string
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: string
  sequence: number
  created_at: string
  thread_id: string | null
}
type ThreadOmitted = { purged: number; withheld: number }
type ThreadCreateResult = {
  thread: ThreadRow
  participants: ThreadParticipantRow[]
  nextSteps: string[]
}
type ThreadGetResult = {
  thread?: ThreadRow
  participants?: ThreadParticipantRow[]
  messages: ThreadMessageRow[]
  count: number
  degraded: boolean
  omitted?: ThreadOmitted
}
// S10-3: `for:'step'` (ruling 5) plus the non-message pact outcomes a `--for pact|step|reply`
// park can be woken with (resolvePactWaiters / K24's host-wide turn guard) — `threadId` is set
// only on those detail-driven wakes (null for a turn_arrived wake per A4; absent otherwise).
type WaitResult = {
  outcome:
    | 'reply'
    | 'message'
    | 'step'
    | 'timeout'
    | 'cancelled'
    | 'your_turn'
    | 'accepted'
    | 'declined'
    | 'paused'
    | 'released'
    | 'turn_arrived'
  threadId?: string | null
  messages: ThreadMessageRow[]
  resumeToken: string | null
  waitedMs: number
  nextSteps: string[]
}

// Why local and not a shared cross-host "last seen" helper: `lastMessageAt` is one host's own
// DB clock read back by the same host (no network skew to guard against), unlike
// terminal-presence-last-seen.ts's cross-machine roster reading.
function formatAgeShort(iso: string | null): string {
  if (!iso) {
    return 'never'
  }
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) {
    return iso
  }
  if (ms < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}

function formatThreadsList(result: ThreadsListResult): string {
  if (result.threads.length === 0) {
    return 'No threads.\nNext: orca agents ask <name> "<question>" to start one.'
  }
  const lines = result.threads.map((t) => {
    const tags = [t.sensitive ? '[sensitive]' : null, t.pact ? `[pact: ${t.pact.state}]` : null]
      .filter(Boolean)
      .join(' ')
    return (
      `${t.id}  "${t.subject}"  [${t.state}]  last ${formatAgeShort(t.lastMessageAt)}  ` +
      `${t.messageCount} msg(s) ${tags}`
    ).trimEnd()
  })
  return `${lines.join('\n')}\nRead one: orca agents thread --id <id>`
}

function formatThreadCreate(result: ThreadCreateResult): string {
  const others = result.participants.length - 1
  return (
    `Started thread ${result.thread.id} ("${result.thread.subject}") with ${others} other ` +
    `participant(s).\nNext: orca agents thread --id ${result.thread.id}`
  )
}

// Why re-sanitized here too (not just formatter.ts's pane push): ruling 4's "sanitize at write
// AND render" applies to every message-text render surface, and this is a second one — a legacy
// row (or a future write-side regression) must not reach a terminal via this path unsanitized.
function formatThreadMessageLine(m: ThreadMessageRow): string {
  const time = m.created_at.slice(11, 16)
  const text = m.body && m.body.length > 0 ? m.body : m.subject
  const sanitized = sanitizeMessageText(text, 4000).value
  return `#${m.sequence} ${time} ${m.from_handle}: ${sanitized}`
}

function formatOmissionLine(omitted: ThreadOmitted | undefined, id: string): string {
  if (!omitted) {
    return ''
  }
  const parts: string[] = []
  if (omitted.withheld > 0) {
    parts.push(`${omitted.withheld} message(s) withheld (quarantined author)`)
  }
  if (omitted.purged > 0) {
    parts.push(`${omitted.purged} message(s) purged`)
  }
  if (parts.length === 0) {
    return ''
  }
  return `\n${parts.join(' · ')} — run orca agents thread --id ${id}`
}

function formatThreadRead(result: ThreadGetResult, id: string): string {
  const omissionLine = formatOmissionLine(result.omitted, id)
  const degradedNote = result.degraded
    ? '\n(showing only messages addressed to you — you are not a full participant of this thread)'
    : ''
  if (result.messages.length === 0) {
    return `No messages on thread ${id}.${degradedNote}${omissionLine}`
  }
  const lines = result.messages.map(formatThreadMessageLine).join('\n')
  const lastSequence = result.messages.at(-1)?.sequence
  const resumeHint =
    lastSequence !== undefined
      ? `\nContinue: orca agents thread --id ${id} --since ${lastSequence}`
      : ''
  return `${lines}${omissionLine}${degradedNote}${resumeHint}`
}

// Fix, not just an addition: the pre-existing timeout/message hints hardcoded `--for reply`
// even for a `--for message`/`--for pact` wait — every branch below instead echoes the RPC's
// own nextSteps (already `--for <the actual param>`) or, absent one, `result.outcome`, which
// equals `params.for` on every message/reply/step outcome (orchestration-wait.ts).
function formatWait(result: WaitResult, threadId: string, forParam: string): string {
  if (result.outcome === 'cancelled') {
    return `wait cancelled on thread ${threadId}.`
  }
  if (result.outcome === 'timeout') {
    const hint =
      result.nextSteps[0] ??
      `orca agents wait --thread ${threadId} --for ${forParam} --resume ${result.resumeToken}`
    return `Still pending on thread ${threadId} (waited ${result.waitedMs}ms).\nResume without re-asking: ${hint}`
  }
  if (result.messages.length > 0) {
    const lines = result.messages.map(formatThreadMessageLine).join('\n')
    return `${lines}\nContinue: orca agents wait --thread ${threadId} --for ${result.outcome} --resume ${result.resumeToken}`
  }
  // Non-message pact outcomes (your_turn / accepted / declined / paused / released /
  // turn_arrived) carry nothing to replay — only the RPC's own nextSteps say what's next.
  const target = result.threadId ?? threadId
  const steps = result.nextSteps.map((s) => `Next: ${s}`).join('\n')
  const headline = `pact ${result.outcome}${result.threadId !== undefined ? ` on thread ${target}` : ''}.`
  return steps ? `${headline}\n${steps}` : headline
}

async function resolveWithParam(client: RuntimeClient, raw: string): Promise<string> {
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (names.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--with must name at least one agent.')
  }
  const resolved = await Promise.all(names.map((n) => resolveAgentByNameOrId(client, n)))
  return resolved.map((a) => `agent:${a.id}`).join(',')
}

export const AGENT_THREAD_HANDLERS: Record<string, CommandHandler> = {
  'agents threads': async ({ flags, client, json }) => {
    const limitFlag = getOptionalStringFlag(flags, 'limit')
    const result = await client.call<ThreadsListResult>('orchestration.threads.list', {
      state: getOptionalStringFlag(flags, 'state'),
      limit: limitFlag ? Number(limitFlag) : undefined
    })
    printResult(result, json, formatThreadsList)
  },

  'agents thread': async ({ flags, client, json }) => {
    const id = getOptionalStringFlag(flags, 'id')

    if (flags.has('new')) {
      if (id) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--new mints its own thread id; do not pass --id with it.'
        )
      }
      const withParam = await resolveWithParam(client, getRequiredStringFlag(flags, 'with'))
      const result = await client.call<ThreadCreateResult>('orchestration.threads.create', {
        subject: getOptionalStringFlag(flags, 'subject'),
        with: withParam,
        sensitive: flags.has('sensitive') ? true : undefined
      })
      printResult(result, json, formatThreadCreate)
      return
    }

    if (!id) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass --id <thread>, or --new --with <name> to start one.'
      )
    }

    if (flags.has('leave')) {
      const result = await client.call<{ left: boolean }>('orchestration.threads.leave', { id })
      printResult(result, json, () => `Left thread ${id}.`)
      return
    }

    const result = await client.call<ThreadGetResult>('orchestration.threads.get', {
      id,
      since: getOptionalStringFlag(flags, 'since')
    })
    printResult(result, json, (r) => formatThreadRead(r, id))
  },

  'agents wait': async ({ flags, client, json }) => {
    const threadId = getRequiredStringFlag(flags, 'thread')
    const forParam = getOptionalStringFlag(flags, 'for') ?? 'message'
    if (!['reply', 'message', 'pact', 'step'].includes(forParam)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--for must be one of reply|message|pact|step'
      )
    }
    const parsedTimeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const result = await client.call<WaitResult>(
      'orchestration.wait',
      {
        threadId,
        for: forParam,
        timeoutMs: parsedTimeoutMs,
        resumeToken: getOptionalStringFlag(flags, 'resume')
      },
      { timeoutMs: resolveOrchestrationAskClientTimeoutMs(parsedTimeoutMs) }
    )
    printResult(result, json, (r) => formatWait(r, threadId, forParam))
    if (result.result.outcome === 'cancelled') {
      process.exitCode = 1
    }
  }
}
