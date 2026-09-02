import type { MessageRow } from './types'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import { sanitizeDirectoryText } from './agent-name-sanitizer'
import { sanitizeMessageText } from '../../../shared/message-text'

// Why generous, not the write-side MESSAGE_BODY_MAX_LENGTH/SUBJECT_MAX_LENGTH
// (message-gate-writer.ts): these render-side sanitizer calls exist for defense-in-depth against
// a row that predates the write-side sanitizer, or a future write-side regression (ruling 4) —
// they must strip control/escape/newline structure without re-truncating a normal, already
// write-sanitized row a second time.
const RENDER_SANITIZE_MAX_LENGTH = 4000

const BANNER_WIDTH = 60
const SEPARATOR = '─'.repeat(BANNER_WIDTH)

export type MessageFormattingAuthority =
  | 'current'
  | 'legacy_compatibility'
  | 'legacy_recovery_replay'
  | 'legacy_read_only'

export type MessageFormattingOptions = {
  authority?: MessageFormattingAuthority
  supportedActionHints?: readonly string[]
}

function resolveAuthority(
  msg: MessageRow,
  authority: MessageFormattingAuthority | undefined
): MessageFormattingAuthority {
  if (authority) {
    return authority
  }
  return msg.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
    msg.delivery_contract === 'legacy_direct' ||
    msg.delivery_contract === 'audit_only'
    ? 'legacy_read_only'
    : 'current'
}

function appendLegacyGuidance(
  lines: string[],
  authority: MessageFormattingAuthority,
  supportedActionHints: readonly string[]
): void {
  if (authority === 'legacy_read_only') {
    lines.push('[Inspection only: reply and acknowledgment are unavailable.]')
    return
  }
  if (authority === 'legacy_compatibility') {
    lines.push('[Use only the supported legacy action shown below.]')
  } else if (authority === 'legacy_recovery_replay') {
    lines.push(
      '[This bounded recovery replay may already have been seen. Use only the action shown below.]'
    )
  }
  for (const hint of supportedActionHints) {
    lines.push(`[Supported action: ${hint}]`)
  }
}

export function formatMessageBanner(msg: MessageRow, options: MessageFormattingOptions): string
export function formatMessageBanner(msg: MessageRow): string
export function formatMessageBanner(
  msg: MessageRow,
  options: MessageFormattingOptions = {}
): string {
  const priorityTag =
    msg.priority === 'urgent' ? ' [URGENT]' : msg.priority === 'high' ? ' [HIGH]' : ''
  const authority = resolveAuthority(msg, options.authority)
  const authorityTag =
    authority === 'legacy_compatibility'
      ? ' [LEGACY COMPATIBILITY]'
      : authority === 'legacy_recovery_replay'
        ? ' [LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]'
        : authority === 'legacy_read_only'
          ? ' [LEGACY READ-ONLY]'
          : ''
  // Ruling 4 (S10-2 GATE §, generalized from S10-1 ruling A2): sanitize at write AND at every
  // render — a legacy row (predates the write-side sanitizer) or a federation-imported row must
  // never inject multiple lines or terminal escapes into a coordinator's transcript here either.
  const sanitizedFromHandle = sanitizeMessageText(msg.from_handle, RENDER_SANITIZE_MAX_LENGTH).value
  const senderName = sanitizedFromHandle.toUpperCase()

  const header = `──── From: ${senderName} (${sanitizedFromHandle})${priorityTag}${authorityTag} (${msg.type}) ────`

  const lines: string[] = [header]
  lines.push(`Subject: ${sanitizeMessageText(msg.subject, RENDER_SANITIZE_MAX_LENGTH).value}`)
  if (authority !== 'current') {
    appendLegacyGuidance(lines, authority, options.supportedActionHints ?? [])
  }

  if (msg.body) {
    lines.push(sanitizeMessageText(msg.body, RENDER_SANITIZE_MAX_LENGTH).value)
  }

  if (msg.payload) {
    lines.push(`[Payload: ${sanitizeMessageText(msg.payload, RENDER_SANITIZE_MAX_LENGTH).value}]`)
  }

  if (authority === 'current') {
    const explicitFrom =
      msg.to_handle.startsWith('run:') || msg.to_handle.startsWith('dispatch:')
        ? ''
        : ` --from ${msg.to_handle}`
    lines.push(`[Reply: orca orchestration reply --id ${msg.id}${explicitFrom} --body "..."]`)
  }
  lines.push(SEPARATOR)

  return lines.join('\n')
}

// Why: grouping multiple banners under a single wrapper line lets agents detect
// the message block boundary and parse each banner individually.
export function formatMessagesForInjection(messages: MessageRow[]): string {
  if (messages.length === 0) {
    return ''
  }

  const banners = messages.map(formatMessageBanner).join('\n\n')
  return `\n--- Orchestration Messages (${messages.length}) ---\n${banners}\n---\n`
}

const POINTER_MAX_SHOWN = 2
const POINTER_SUBJECT_MAX = 80

// Why: bounded per §6 poison containment — a subject can carry attacker-shaped
// text, but never enough of it to trip a reader; the body is never touched.
// Why sanitize-then-slice (S10-2 DELIVERY §, ruling 4) and not slice-then-sanitize (the bug this
// closes): slicing alone is not sanitizing — a subject under 80 raw chars can still carry a `\n`
// or a CSI sequence, which is exactly what breaks "never more than 3 lines" (T5). Sanitizing
// first collapses any embedded newline/escape structure into the one printable line the 80-char
// cut then bounds.
function truncatePointerSubject(subject: string): string {
  const sanitized = sanitizeMessageText(subject, RENDER_SANITIZE_MAX_LENGTH).value
  if (sanitized.length <= POINTER_SUBJECT_MAX) {
    return sanitized
  }
  return `${sanitized.slice(0, POINTER_SUBJECT_MAX - 1)}…`
}

// WAIT/ASK § mechanical difference #1: a peer ask is `type==='question'` — derivable from the
// row alone, no thread lookup needed.
function isPeerAskMessage(msg: MessageRow): boolean {
  return msg.type === 'question'
}

// Why a caller-injected resolver and not a column on MessageRow: sensitivity lives on `threads`,
// not `messages` — the same "identity/authority resolved by the caller, formatter stays pure"
// shape as `resolveSenderAgent` above. Absent (an old call site, or a message with no thread_id)
// reads as "not sensitive" — never fail OPEN the other way (never sensitive when it might be).
export type ResolveThreadSensitive = (threadId: string) => boolean

function threadIsSensitive(
  msg: MessageRow,
  resolveThreadSensitive?: ResolveThreadSensitive
): boolean {
  return msg.thread_id != null && (resolveThreadSensitive?.(msg.thread_id) ?? false)
}

/** Directory identity for the sender of one message (S10-1: pointer wires role). Both fields
 * are already sanitized at write (agent-name-sanitizer.ts), but §6 poison containment requires
 * the render side to re-sanitize independently — see POINTER_ROLE_MAX_LENGTH below — so a
 * future write-side regression (or a row read by any other path) cannot widen what gets typed
 * into a peer's PTY. A quarantined sender must never be resolved here (CONTAINMENT #7); callers
 * are responsible for excluding quarantined/tombstoned rows before returning an agent. */
export type MessagePointerSenderAgent = { displayName: string; role: string | null }

export type ResolveMessagePointerSenderAgent = (msg: MessageRow) => MessagePointerSenderAgent | null

// Why much shorter than the 120-char write-side bound: a pointer is an ambient interrupt read
// mid-flow, not a directory entry someone opted to look up — the shorter the render, the less
// of an injected sentence a reader ever sees before triaging away from it.
const POINTER_ROLE_MAX_LENGTH = 40
const POINTER_NAME_MAX_LENGTH = 32

// S10-20 (Ruling 22 scope 2): ids render at the host grammar's own length; a longer value is not a
// host id at all, so truncating it is the correct render.
const POINTER_ID_MAX_LENGTH = 16
// Ruling 22 fixes 64, NOT the 32 of POINTER_NAME_MAX_LENGTH: a federation from_handle is
// `remote:<link>:<agt_xxxxxxxxxxxx>` (federated-sender-identity.ts:236) or `dispatch:<id>`, which 32
// would cut mid-identifier and make the sender unidentifiable to the reader.
const POINTER_FROM_HANDLE_MAX_LENGTH = 64

function pointerId(value: string | null | undefined): string {
  return value == null ? 'none' : sanitizeDirectoryText(value, POINTER_ID_MAX_LENGTH).value
}

// SENSITIVE THREADS §: no subject at all — never the body, never even the truncated subject a
// non-sensitive pointer shows. `count` is how many queued messages share this sensitive thread
// (of the full unread set, not just what's shown) so the reader knows there is more than one.
function formatSensitiveThreadPointerLine(threadId: string, count: number): string {
  return `[sensitive thread ${threadId} — ${count} message${count === 1 ? '' : 's'}]`
}

function formatMessagePointerLine(
  msg: MessageRow,
  resolveSenderAgent?: ResolveMessagePointerSenderAgent,
  sensitiveThreadCount?: number
): string {
  const thread = pointerId(msg.thread_id)
  if (msg.thread_id != null && sensitiveThreadCount !== undefined) {
    return formatSensitiveThreadPointerLine(pointerId(msg.thread_id), sensitiveThreadCount)
  }
  const agent = resolveSenderAgent?.(msg) ?? null
  const sanitizedName = agent
    ? sanitizeDirectoryText(agent.displayName, POINTER_NAME_MAX_LENGTH).value
    : ''
  const sanitizedRole = agent?.role
    ? sanitizeDirectoryText(agent.role, POINTER_ROLE_MAX_LENGTH).value
    : ''
  const from =
    agent && sanitizedName.length > 0
      ? `${sanitizedName}${sanitizedRole ? ` (${sanitizedRole})` : ''}`
      : sanitizeDirectoryText(msg.from_handle, POINTER_FROM_HANDLE_MAX_LENGTH).value
  // DELIVERY § mechanical difference #2: a peer ask's pointer line is prefixed so a reader
  // triaging a flood of mail can see at a glance that someone is blocked on them.
  const askPrefix = isPeerAskMessage(msg) ? '[ASK — sender is blocked] ' : ''
  return `${askPrefix}[from: ${from}] "${truncatePointerSubject(msg.subject)}" thread:${thread}`
}

// Per-kind trailer (DELIVERY §): the footer line reflects the LAST shown message's kind — a
// peer ask's "Answer:" hint always wins the footer slot over the generic overflow count (ruling:
// "always shown even as the 3rd message, it displaces the overflow line, never widens past 3"),
// a sensitive thread's footer never repeats the subject, and a plain message's footer is the
// concrete resume command rather than the old, non-specific "Run `orca orchestration check`."
function buildPointerFooter(
  lastShown: MessageRow,
  overflow: number,
  resolveThreadSensitive?: ResolveThreadSensitive
): string {
  if (threadIsSensitive(lastShown, resolveThreadSensitive) && lastShown.thread_id != null) {
    return `orca agents thread --id ${pointerId(lastShown.thread_id)}`
  }
  if (isPeerAskMessage(lastShown)) {
    const threadId = pointerId(lastShown.thread_id ?? lastShown.id)
    return `Answer: orca agents reply --thread ${threadId} --body "..."`
  }
  if (overflow > 0) {
    return `— ${overflow} more; run orca orchestration check`
  }
  if (lastShown.thread_id != null) {
    return `Read: orca agents thread --id ${pointerId(lastShown.thread_id)} --since ${Number(lastShown.sequence) || 0}`
  }
  return 'Run `orca orchestration check`.'
}

// Why content-bearing but bounded (§6): an agent mid-flow reads a contentless
// pointer as a low-value interrupt and defers it. Sender/subject/thread let it
// triage without a round trip; only the first two are shown so a flood of
// queued mail can never widen what gets typed into the pane. Never more than 3 lines total
// (DELIVERY §), no matter how much mail is queued: at most POINTER_MAX_SHOWN message lines plus
// exactly one contextual footer line.
export function formatMessagePointer(
  messages: readonly MessageRow[],
  resolveSenderAgent?: ResolveMessagePointerSenderAgent,
  resolveThreadSensitive?: ResolveThreadSensitive
): string {
  if (messages.length === 0) {
    return ''
  }
  const shown = messages.slice(0, POINTER_MAX_SHOWN)
  const overflow = messages.length - shown.length
  const lines = shown.map((msg) => {
    const sensitive = threadIsSensitive(msg, resolveThreadSensitive)
    const sensitiveCount = sensitive
      ? messages.filter((m) => m.thread_id === msg.thread_id).length
      : undefined
    return formatMessagePointerLine(msg, resolveSenderAgent, sensitiveCount)
  })
  const lastShown = shown.at(-1) as MessageRow
  lines.push(buildPointerFooter(lastShown, overflow, resolveThreadSensitive))
  return `\n${lines.join('\n')}\n`
}
