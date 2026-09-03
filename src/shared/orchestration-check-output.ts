import { ORCHESTRATION_LEGACY_RUN_ID } from './orchestration-rpc-contract'

export type OrchestrationMessageSummary = {
  id: string
  run_id?: string
  delivery_contract?: 'legacy_direct' | 'current_delivery' | 'audit_only'
  from_handle: string
  to_handle?: string
  subject?: string
  type?: string
  body?: string
  payload?: string | null
  priority?: string
  read?: number
  /** Additive: `orchestration thread` (BUG 4) is the first reader that needs it on the wire. */
  thread_id?: string | null
  created_at?: string
  /** Additive: the monotonic cursor `orchestration thread --since` resumes by (S10-0 minor). */
  sequence?: number
}

export type LegacyCompatibilityResult = {
  recovery?: boolean
  readOnly?: boolean
  ackMessageIds?: string[]
  answerAcknowledgement?: {
    questionId: string
    answerMessageId: string
  }
  currentDelivery?: {
    runId: string
    checkCommand: string
    ackCommand: string
  }
  resumeRequired?: boolean
  resumeCommand?: string
}

export type OrchestrationCheckOutput = {
  messages: OrchestrationMessageSummary[]
  count: number
  formatted?: string
  deliveryId?: string | null
  runId?: string
  // Why optional: an older host sends neither, and a replay that renders as fresh mail is the
  // starvation this pair exists to expose.
  replayed?: boolean
  pendingBehind?: number
  timedOut?: boolean
  cancelled?: boolean
  connectionLost?: boolean
  // Why optional: an acknowledged wait that gets fenced returns success-shaped, so this is the
  // only signal that the mailbox changed hands. An older host never sends it.
  waitInterrupted?: 'consumer_fenced' | 'outcome_unknown' | 'waiter_exists'
  legacyCompatibility?: LegacyCompatibilityResult
  // S10-16 C6, R19.5/Ruling 21 Protocol B2: the ONE additive line naming a link that needs
  // attention (contested/quarantined/parked/attestation-expiring or -expired/reply-relay
  // degraded). Local callers only (rpc/methods/orchestration.ts's wrap site) — absent for a
  // paired peer and for a healthy host. Printed after the message list on every return path.
  linkBindingAttention?: string
  // F-6c (Ruling 32(b); field-run-10i): one host-constant line, present only when the caller's
  // own row has a parked (withheld-and-not-since-retried) ambient delivery. Never per-count or
  // per-pane text — see orca-runtime.ts's hasParkedDelivery / orchestration.ts's PARKED_DELIVERY_NOTICE.
  parkedDeliveryNotice?: string
  // B3 (Ruling 32 Addendum 10/F-17): the mailbox handle this check actually read — every
  // bare-handle result carries it, so an empty check never leaves that ambiguous.
  mailbox?: string
  // B3: present only on an attestation/pane-key mismatch — the caller has a registered
  // agent:<id> mailbox this call did NOT read. Printed loudly rather than silently reading the
  // bare handle instead.
  mailboxMismatchNotice?: string
  // B1 (Ruling 32 Addendum 10/F-17): the same purged/quarantine-withheld omission counts
  // readMailboxDelivery/getOrCreateMailboxDelivery compute — carried through so a blocked
  // mailbox's zero-count text can say why, not just that a Delivery id exists.
  omitted?: { purged: number; withheld: number }
  // F1 (Ruling 32 Addendum 11): present only when this pane is ALSO a run's coordinator and
  // this check just read its own agent:<id> mailbox instead (F-17's "run-bound pane never sees
  // its directory mail" symptom) — names the run mailbox it stepped past and how much is
  // waiting there. Data-only, same treatment as `legacyPending` (no dedicated line in
  // formatOrchestrationCheckText — neither field renders into the plain-text check output;
  // both are additive JSON carried straight through by `--json`/programmatic callers).
  runMailbox?: string
  runPending?: number
}

export function formatMessageReadOnlyTag(
  message: OrchestrationMessageSummary,
  legacyCompatibilityActive = false
): string {
  return isLegacyReadOnlyMessage(message, legacyCompatibilityActive) ? ' [legacy, read-only]' : ''
}

export function isLegacyReadOnlyMessage(
  message: OrchestrationMessageSummary,
  legacyCompatibilityActive = false
): boolean {
  return (
    message.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
    (message.delivery_contract === 'legacy_direct' && !legacyCompatibilityActive) ||
    message.delivery_contract === 'audit_only'
  )
}

export function formatOrchestrationCheckText(
  result: OrchestrationCheckOutput,
  checkedTerminal: string
): string {
  const prepared = prepareOrchestrationCheckOutput(
    result,
    checkedTerminal,
    result.formatted !== undefined
  )
  const compatibilityActive = Boolean(
    prepared.legacyCompatibility && !prepared.legacyCompatibility.readOnly
  )
  const legacyHeader = prepared.legacyCompatibility
    ? prepared.legacyCompatibility.readOnly
      ? '[LEGACY READ-ONLY]\n'
      : prepared.legacyCompatibility.recovery
        ? '[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]\n'
        : '[LEGACY COMPATIBILITY]\n'
    : ''
  const deliveryNotice = formatCurrentDeliveryNotice(prepared.legacyCompatibility?.currentDelivery)
  const deliveryTag = prepared.deliveryId ? formatDeliveryBacklogTag(prepared) : ''
  // S10-16 C6, R19.5/R22.4/Ruling 21 Protocol B2: computed ONCE, appended as the last
  // interpolation of every return below — additive (byte-identical output when null) and
  // present on all eight paths, so the compensating control this line is accepted on can never
  // be silent on the one path that happens to fire.
  // F13/Ruling 27 (C6a): passed through the same control-character escaper message fields use —
  // its interpolated environment name is operator-chosen, not peer-chosen, but unescaped and
  // unclamped it is one newline away from breaking the one-line-per-signal discipline agents
  // parse (the length clamp itself lives where the name is composed, link-binding-attention.ts).
  const attentionSuffix = prepared.linkBindingAttention
    ? `\n${escapeTerminalControlCharacters(prepared.linkBindingAttention)}`
    : ''
  // F-6c: same additive, always-last-appended shape as attentionSuffix above — host-constant
  // text, so no escaping is needed (nothing peer/caller-chosen is interpolated into it).
  const parkedSuffix = prepared.parkedDeliveryNotice ? `\n${prepared.parkedDeliveryNotice}` : ''
  // B3 (Ruling 32 Addendum 10/F-17): host-constant shape, caller-chosen text only in the two
  // handle names it interpolates — same additive, always-last-appended pattern as parkedSuffix.
  const mailboxMismatchSuffix = prepared.mailboxMismatchNotice
    ? `\n${escapeTerminalControlCharacters(prepared.mailboxMismatchNotice)}`
    : ''
  if (prepared.formatted) {
    // Why prepended here too: --format and --inject return before the Delivery line is built, so
    // without this the injected banner is byte-identical on every replay and the starvation stays
    // invisible in the one mode that writes into a pane. An untagged batch renders as it did.
    const deliveryLine = deliveryTag ? `Delivery ${prepared.deliveryId}${deliveryTag}\n` : ''
    return `${legacyHeader}${deliveryLine}${prepared.formatted}${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
  }
  if (prepared.count === 0) {
    if (prepared.timedOut) {
      return `${legacyHeader}Wait timed out; no messages were consumed.${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
    }
    if (prepared.cancelled) {
      const cancelled = prepared.connectionLost
        ? 'Wait cancelled because the connection closed; no messages were consumed.'
        : 'Wait cancelled; no messages were consumed.'
      return `${legacyHeader}${cancelled}${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
    }
    // Why before the fallback: an interrupted acknowledged wait is success-shaped with count 0,
    // so without this it reads as an empty mailbox and the coordinator keeps looping on a Run
    // it no longer owns.
    if (prepared.waitInterrupted === 'consumer_fenced') {
      return `${legacyHeader}Wait ended: this mailbox consumer was replaced. Rebind with: orca orchestration run-use --id ${prepared.runId ?? '<runId>'}${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
    }
    if (prepared.waitInterrupted === 'waiter_exists') {
      return `${legacyHeader}Wait ended: another actionable waiter already owns this Run's mailbox; only one can block on it at a time.${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
    }
    // Why its own branch: this value is the stored receipt a retried request replays, so reading
    // it as an empty mailbox tells the coordinator nothing arrived on a call whose --ack already
    // consumed a batch.
    if (prepared.waitInterrupted === 'outcome_unknown') {
      return `${legacyHeader}Wait ended: this check acknowledged its Delivery but the wait's outcome is unknown. Re-run check to see the current mailbox.${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
    }
    // B1 (Ruling 32 Addendum 10/F-17): a blocked mailbox (an outstanding Delivery whose messages
    // are all currently unreadable, or one with mail queued behind it) used to render exactly
    // "No messages." — indistinguishable from a genuinely empty mailbox, so the `--ack` a caller
    // needs to unstick it was never named. Render the Delivery line and the omission counts
    // BEFORE the fallback text whenever either signal is present.
    if (prepared.deliveryId != null || (prepared.pendingBehind ?? 0) > 0) {
      const blockedDeliveryLine = prepared.deliveryId
        ? `Delivery ${prepared.deliveryId}${deliveryTag}\n`
        : ''
      const omittedLine = formatOmittedRowsLine(prepared.omitted)
      const omittedBlock = omittedLine ? `${omittedLine}\n` : ''
      return `${legacyHeader}${blockedDeliveryLine}${omittedBlock}No messages.${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
    }
    return `${legacyHeader}No messages.${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
  }
  const rendered = prepared.messages
    .map(
      (message) =>
        `${message.id}${formatMessageReadOnlyTag(
          message,
          compatibilityActive
        )} [${message.type ?? 'status'}] from=${message.from_handle} "${message.subject}"`
    )
    .join('\n')
  const output = prepared.deliveryId
    ? `Delivery ${prepared.deliveryId}${deliveryTag}\n${rendered}`
    : rendered
  return `${legacyHeader}${output}${deliveryNotice}${attentionSuffix}${parkedSuffix}${mailboxMismatchSuffix}`
}

export function prepareOrchestrationCheckOutput<T extends OrchestrationCheckOutput>(
  result: T,
  checkedTerminal: string,
  formattedRequested: boolean
): T {
  const compatibilityActive = Boolean(
    result.legacyCompatibility && !result.legacyCompatibility.readOnly
  )
  if (
    !formattedRequested ||
    !result.messages.some((message) => isLegacyReadOnlyMessage(message, compatibilityActive))
  ) {
    return result
  }
  return {
    ...result,
    formatted: formatLegacyAwareCheckMessages(result.messages, checkedTerminal, compatibilityActive)
  }
}

// Why: a replayed Delivery is byte-identical to fresh mail, so a coordinator that never acks
// re-reads the same batch forever while everything newer stays invisible behind it.
function formatDeliveryBacklogTag(result: OrchestrationCheckOutput): string {
  const acknowledge = `acknowledge with --ack ${result.deliveryId}`
  const pendingBehind = typeof result.pendingBehind === 'number' ? result.pendingBehind : 0
  if (result.replayed !== true) {
    // Why still tagged: a fresh batch is capped, so an overflowing mailbox strands the remainder
    // from the moment the Delivery is created. An older host sends no count and keeps today's line.
    return pendingBehind > 0
      ? ` [${pendingBehind} more queued behind this batch; ${acknowledge}]`
      : ''
  }
  return pendingBehind > 0
    ? ` [REPLAY — ${pendingBehind} newer messages are blocked behind it; ${acknowledge}]`
    : ` [REPLAY — ${acknowledge}]`
}

// B1: the same omission-line shape orchestration.ts's private formatOmittedMessagesLine renders
// for the --format/--inject banner path — this is the plain-text `check` path's own copy (no
// shared/ -> main/ import), used only in the count===0 blocked-delivery branch above.
function formatOmittedRowsLine(omitted?: { purged: number; withheld: number }): string {
  if (!omitted || (omitted.purged === 0 && omitted.withheld === 0)) {
    return ''
  }
  const parts: string[] = []
  if (omitted.purged > 0) {
    parts.push(`${omitted.purged} purged`)
  }
  if (omitted.withheld > 0) {
    parts.push(`${omitted.withheld} withheld (author quarantined)`)
  }
  return `[${parts.join(', ')} — omitted from this delivery]`
}

function formatMessagePriorityTag(message: OrchestrationMessageSummary): string {
  return message.priority === 'urgent' ? ' [URGENT]' : message.priority === 'high' ? ' [HIGH]' : ''
}

function escapeTerminalControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      if (character === '\n' || (code >= 0x20 && code < 0x7f) || code > 0x9f) {
        return character
      }
      return `\\x${code.toString(16).padStart(2, '0')}`
    })
    .join('')
}

function formatQuotedMessageField(label: string, value?: string): string {
  return `[${label}]\n${escapeTerminalControlCharacters(value ?? '')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}`
}

function formatLegacyAwareCheckMessages(
  messages: OrchestrationMessageSummary[],
  checkedTerminal: string,
  legacyCompatibilityActive = false
): string {
  return messages
    .map((message) => {
      const legacyReadOnly = isLegacyReadOnlyMessage(message, legacyCompatibilityActive)
      const lines = [
        `${message.id}${formatMessageReadOnlyTag(message, legacyCompatibilityActive)}${formatMessagePriorityTag(message)} [${message.type ?? 'status'}] from=${message.from_handle}`,
        formatQuotedMessageField('subject', message.subject)
      ]
      if (legacyReadOnly) {
        lines.push('[Inspection only: reply and acknowledgment are unavailable.]')
      }
      if (message.body) {
        lines.push(formatQuotedMessageField('body', message.body))
      }
      if (message.payload) {
        lines.push(formatQuotedMessageField('payload', message.payload))
      }
      if (!legacyReadOnly) {
        const replyTarget = message.to_handle ?? checkedTerminal
        const replyFrom =
          replyTarget.startsWith('run:') || replyTarget.startsWith('dispatch:')
            ? ''
            : ` --from ${replyTarget}`
        lines.push(`[Reply: orca orchestration reply --id ${message.id}${replyFrom} --body "..."]`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

function formatCurrentDeliveryNotice(
  delivery: LegacyCompatibilityResult['currentDelivery']
): string {
  if (!delivery) {
    return ''
  }
  return (
    `\n[CURRENT RUN MAIL WAITING]\n` +
    `Read: ${delivery.checkCommand}\n` +
    `Then acknowledge the delivery ID it prints: ${delivery.ackCommand}`
  )
}
