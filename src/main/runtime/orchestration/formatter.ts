import type { MessageRow } from './types'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'

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
  const senderName = msg.from_handle.toUpperCase()

  const header = `──── From: ${senderName} (${msg.from_handle})${priorityTag}${authorityTag} (${msg.type}) ────`

  const lines: string[] = [header]
  lines.push(`Subject: ${msg.subject}`)
  if (authority !== 'current') {
    appendLegacyGuidance(lines, authority, options.supportedActionHints ?? [])
  }

  if (msg.body) {
    lines.push(msg.body)
  }

  if (msg.payload) {
    lines.push(`[Payload: ${msg.payload}]`)
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
function truncatePointerSubject(subject: string): string {
  if (subject.length <= POINTER_SUBJECT_MAX) {
    return subject
  }
  return `${subject.slice(0, POINTER_SUBJECT_MAX - 1)}…`
}

function formatMessagePointerLine(msg: MessageRow): string {
  const thread = msg.thread_id ?? 'none'
  return `[from: ${msg.from_handle}] "${truncatePointerSubject(msg.subject)}" thread:${thread}`
}

// Why content-bearing but bounded (§6): an agent mid-flow reads a contentless
// pointer as a low-value interrupt and defers it. Sender/subject/thread let it
// triage without a round trip; only the first two are shown so a flood of
// queued mail can never widen what gets typed into the pane.
export function formatMessagePointer(messages: readonly MessageRow[]): string {
  if (messages.length === 0) {
    return ''
  }
  const shown = messages.slice(0, POINTER_MAX_SHOWN)
  const lines = shown.map(formatMessagePointerLine)
  const overflow = messages.length - shown.length
  lines.push(
    overflow > 0
      ? `— ${overflow} more; run orca orchestration check`
      : 'Run `orca orchestration check`.'
  )
  return `\n${lines.join('\n')}\n`
}
