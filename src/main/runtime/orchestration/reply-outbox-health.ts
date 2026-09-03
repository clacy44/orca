// S10-16 C5, R18.5/R19.1/R19.3 (Ruling 23(c): "the notice CLASSIFIER lives here"): the closed
// peer-refusal disposition map, the notice body assembler (local values only — R19.1) and the
// P2 edge-trigger rule for the one reply-relay notice a peer can provoke.
import {
  REPLY_RELAY_UNREACHABLE_NOTICE,
  REPLY_RELAY_RECOVERED_NOTICE,
  REPLY_RELAY_ABANDONED_NOTICE,
  REPLY_RELAY_REFUSED_NOTICE,
  REPLY_RELAY_ROUTE_MOVED_NOTICE,
  REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE,
  REPLY_RELAY_ID_CONFLICT_NOTICE,
  REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE,
  REPLY_RELAY_STALE_PAIRING_NOTICE,
  REPLY_RELAY_UNSUPPORTED_NOTICE,
  UNKNOWN_PEER_REFUSAL_CODE,
  LINK_BINDING_REVERIFY_MS,
  REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
} from './link-binding-constants'
import type { ReplyOutboxRow } from './reply-outbox-store'

export type ReplyRelayNoticeCode =
  | typeof REPLY_RELAY_UNREACHABLE_NOTICE
  | typeof REPLY_RELAY_RECOVERED_NOTICE
  | typeof REPLY_RELAY_ABANDONED_NOTICE
  | typeof REPLY_RELAY_REFUSED_NOTICE
  | typeof REPLY_RELAY_ROUTE_MOVED_NOTICE
  | typeof REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE
  | typeof REPLY_RELAY_ID_CONFLICT_NOTICE
  | typeof REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE
  | typeof REPLY_RELAY_STALE_PAIRING_NOTICE
  | typeof REPLY_RELAY_UNSUPPORTED_NOTICE

// R18.5's disposition column, keyed on the wire code — the ONE closed vocabulary (P17). A key
// outside this map renders/settles as `unknown_peer_refusal` (transport-shaped: retry).
export const PEER_REFUSAL_DISPOSITIONS: Readonly<Record<string, 'refused' | 'retry'>> = {
  agent_quarantined: 'refused',
  agent_unknown: 'refused',
  agent_retired: 'refused',
  derived_agent_unaddressable: 'refused',
  operation_unknown: 'refused',
  request_mismatch: 'refused',
  not_the_addressee: 'refused',
  body_gate_refused: 'refused',
  sensitive_thread_no_federation: 'refused',
  invalid_argument: 'refused',
  runtime_environment_changed: 'retry',
  stale_environment_pairing: 'retry',
  unauthorized: 'retry',
  orchestration_migration_required: 'retry',
  capability_unsupported: 'retry',
  rate_limited: 'retry',
  runtime_timeout: 'retry',
  runtime_rpc_queue_overloaded: 'retry'
}

// P17: rendered/settled peer code, through the closed map only — never a raw pass-through.
export function classifyPeerRefusalCode(code: string | null | undefined): string {
  if (code && Object.hasOwn(PEER_REFUSAL_DISPOSITIONS, code)) {
    return code
  }
  return UNKNOWN_PEER_REFUSAL_CODE
}

export type ReplyRelayNoticeContext = {
  environmentName: string
  linkDeviceId: string
  outboxId: string
  localMessageId: string
  queueDepth: number
  oldestAgeMs: number
  attempts: number
  peerRefusalCode: string | null
  incidentId: string | null
}

// R19.1: assembled ENTIRELY from local values — `ctx.peerRefusalCode` is already the
// closed-vocabulary output of `classifyPeerRefusalCode`, never raw peer text.
export function describeReplyRelayNotice(
  code: ReplyRelayNoticeCode,
  ctx: ReplyRelayNoticeContext
): { subject: string; body: string } {
  const who = `${ctx.environmentName} (link ${ctx.linkDeviceId})`
  switch (code) {
    case REPLY_RELAY_UNREACHABLE_NOTICE:
      return {
        subject: `Reply relay to ${ctx.environmentName} is unreachable`,
        body:
          `The reply relay to ${who} has failed ${ctx.attempts} consecutive attempts ` +
          `(queue depth ${ctx.queueDepth}, oldest ${ctx.oldestAgeMs}ms). This is the transport, ` +
          `not a verdict about the peer agent.`
      }
    case REPLY_RELAY_RECOVERED_NOTICE:
      return {
        subject: `Reply relay to ${ctx.environmentName} recovered`,
        body: `The reply relay to ${who} delivered again after being reported unreachable.`
      }
    case REPLY_RELAY_ABANDONED_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} was abandoned`,
        body:
          `Message ${ctx.localMessageId} to ${who} could not be delivered within the retry ` +
          `deadline after ${ctx.attempts} attempts. Last error: ${ctx.peerRefusalCode ?? 'none'}.`
      }
    case REPLY_RELAY_REFUSED_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} was refused`,
        body: `Message ${ctx.localMessageId} to ${who} was refused: ${ctx.peerRefusalCode ?? 'unknown_peer_refusal'}.`
      }
    case REPLY_RELAY_ROUTE_MOVED_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} could not find its route`,
        body: `Message ${ctx.localMessageId} to ${who} held past its retargeting window; the route moved.`
      }
    case REPLY_RELAY_PEER_RECEIPT_POISONED_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} hit a poisoned receipt`,
        body: `Message ${ctx.localMessageId} to ${who} was refused: the peer's receipt for this request id is permanently unusable.`
      }
    case REPLY_RELAY_ID_CONFLICT_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} conflicted`,
        body: `Message ${ctx.localMessageId} to ${who} was refused: request_mismatch.`
      }
    case REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} could not confirm its addressee`,
        body:
          `Message ${ctx.localMessageId} to ${who} was delivered, but the peer could not confirm ` +
          `it was answering its own message (incident ${ctx.incidentId ?? 'unknown'}). This is an ` +
          `advisory only; no link state changed.`
      }
    case REPLY_RELAY_STALE_PAIRING_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} needs a fresh pairing`,
        body:
          `Message ${ctx.localMessageId} to ${who} is held: the pairing is stale ` +
          `(${ctx.peerRefusalCode ?? 'stale_environment_pairing'}). Run ` +
          // Ruling 26 Addendum 1(s)/F6: only a verb that exists — plan §4.8's
          // `orca environment update` (`orca environment pair` is not a real command).
          `\`orca environment update --environment ${ctx.environmentName} --pairing-code '<url>'\` ` +
          `to re-pair.`
      }
    case REPLY_RELAY_UNSUPPORTED_NOTICE:
      return {
        subject: `A reply to ${ctx.environmentName} is waiting on a peer upgrade`,
        body:
          `Message ${ctx.localMessageId} to ${who} is held: the peer does not support this ` +
          `operation yet (${ctx.peerRefusalCode ?? 'capability_unsupported'}). Update Orca on ` +
          `that host.`
      }
  }
}

// Ruling 26 Addendum 3(aa): the per-link minimum-interval half, factored out so every
// disposition notice on the reply-relay path can be bounded to R19.3's rate, not only the one
// peer-triggered advisory this file originally gated.
export function replyRelayNoticeRateLimitOk(
  lastLinkNotifiedAt: number | null,
  now: number
): boolean {
  return now - (lastLinkNotifiedAt ?? 0) >= LINK_BINDING_REVERIFY_MS
}

// S10-16 C6, Ruling 26 Addendum 2(z)/3(gg): the outbox-row-to-health-word mapper. Health and the
// check attention line cover the reply-relay conditions (unreachable, stale pairing, unsupported,
// abandoned) derived DIRECTLY from `peer_reply_outbox` rows (state, consecutive_failures,
// last_error_code), never from the no-run notice's audit row. A4-01 is a closed twenty-member
// union with no `abandoned` member, so a terminal `abandoned` row is classified by the condition
// that caused the abandonment (its own `last_error_code`), defaulting to `unreachable` — declared
// deviation, C6 commit body.
export type ReplyRelayLinkHealthWord = 'unreachable' | 'unsupported' | 'stale'

const REPLY_RELAY_LINK_HEALTH_RANK: Record<ReplyRelayLinkHealthWord, number> = {
  unreachable: 0,
  unsupported: 1,
  stale: 2
}

export function describeReplyRelayLinkHealth(
  rows: readonly Pick<ReplyOutboxRow, 'state' | 'consecutiveFailures' | 'lastErrorCode'>[]
): ReplyRelayLinkHealthWord | null {
  let worst: ReplyRelayLinkHealthWord | null = null
  const consider = (word: ReplyRelayLinkHealthWord): void => {
    if (
      worst === null ||
      REPLY_RELAY_LINK_HEALTH_RANK[word] < REPLY_RELAY_LINK_HEALTH_RANK[worst]
    ) {
      worst = word
    }
  }
  for (const row of rows) {
    const live = row.state === 'queued' || row.state === 'sending'
    const terminal = row.state === 'abandoned'
    if (!live && !terminal) {
      continue
    }
    if (live && row.consecutiveFailures >= REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD) {
      consider('unreachable')
    } else if (row.lastErrorCode === 'stale_environment_pairing') {
      consider('stale')
    } else if (row.lastErrorCode === 'capability_unsupported') {
      consider('unsupported')
    } else if (terminal) {
      consider('unreachable')
    }
  }
  return worst
}

// R19.3/P2: the ONE peer-triggered reply-relay notice (`reply_relay_authorship_unconfirmed`).
// Fires iff this item has never fired one before (per-incident half, `notifiedAt`) AND the link
// has not fired one within LINK_BINDING_REVERIFY_MS (the interval half, `lastAdvisoryNotifiedAt`).
export function shouldFireReplyRelayNotice(
  item: { notifiedAt: number | null },
  lastAdvisoryNotifiedAt: number | null,
  now: number
): boolean {
  if (item.notifiedAt !== null) {
    return false
  }
  return replyRelayNoticeRateLimitOk(lastAdvisoryNotifiedAt, now)
}
