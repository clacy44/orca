// Why this module: orca-runtime.ts (ratcheted) delegates the composite-key math here.
// S10-3 pact spec A1 (rev 7 binding) — waiters/reservations keyed by (type, threadId,
// payloadKind), not type alone, so a step waiter never consumes-and-discards ordinary thread
// traffic. S10-2b amendment D: payloadKind is now read from the dedicated messages.payload_kind
// COLUMN (v34, S10-2a) at every call site — never from caller JSON. The JSON payload.kind
// namespace stays reserved for runtime notification kinds (input_not_consumed / liveness_breach
// / relay_unreachable) and is refused at the write choke (message-gate-writer.ts
// payloadHasReservedKindField) and, defense-in-depth, at every send-shaped RPC entry
// (assertPayloadKindNotCallerSet, unchanged by this amendment).

import { OrchestrationError } from './orchestration-error'

/** Registered wait kind (S10-3 A4). Absent = a legacy message/reply wait (pre-S10-3 shape). */
export type MessageWaiterKind = 'message' | 'reply' | 'pact' | 'step'

export type MessageWaitResult =
  | 'notified'
  | 'timed_out'
  | 'cancelled'
  | 'waiter_exists'
  | 'resolved'

/** Carried by a 'resolved' wake (S10-3 A4) — the non-message outcome a pact/step waiter was parked for. */
export type PactWaitDetail = {
  outcome: string
  threadId: string | null
  nextSteps: string[]
}

type ThreadScopedWaiter = {
  typeFilter?: string[]
  threadId?: string
  payloadKind?: string
}

const RESERVATION_ANY = '*'
const RESERVATION_KEY_SEPARATOR = '\0'

// Why '*' for an absent threadId/payloadKind: a legacy waiter with neither still reserves its
// type wholesale (#12536) — every thread's row of that type, any kind, must find it.
export function reservationKey(
  type: string,
  threadId: string | null | undefined,
  payloadKind: string | null | undefined
): string {
  return [type, threadId ?? RESERVATION_ANY, payloadKind ?? RESERVATION_ANY].join(
    RESERVATION_KEY_SEPARATOR
  )
}

// Why: a for:'pact' waiter's typeFilter is [] (consumes nothing, rev 6) — its empty typeFilter
// contributes no keys here, same as an unfiltered (typeFilter undefined) waiter contributes none:
// an unfiltered waiter always consumes at notify time, so it's never present when this runs.
//
// Why notifiedThreadIdKnown (blocker fix): a synthetic notify (no threadId arg — several
// dispatch: pokes carry no specific row) cannot tell whether a thread-scoped waiter's OWN
// threadId describes the row(s) this push is about to read. Reserving on it anyway can
// withhold a real pending row on that thread from the push forever, while the waiter — never
// actually notified of that thread — never wakes either: unconsumed AND unpushed. Defaults to
// known (true) so every direct caller keeps today's exact reservation math; only the notify
// call site opts out when its own threadId is undefined.
export function buildReservedTypeKeys(
  waiters: Iterable<ThreadScopedWaiter> | undefined,
  options?: { notifiedThreadIdKnown?: boolean }
): Set<string> {
  const keys = new Set<string>()
  if (!waiters) {
    return keys
  }
  const threadIdKnown = options?.notifiedThreadIdKnown ?? true
  for (const waiter of waiters) {
    if (waiter.threadId && !threadIdKnown) {
      continue
    }
    for (const type of waiter.typeFilter ?? []) {
      keys.add(reservationKey(type, waiter.threadId, waiter.payloadKind))
    }
  }
  return keys
}

// Why four keys, not one: a row is reserved when ANY waiter that would have produced a
// covering key is live — wildcard (any thread, any kind), thread-any-kind (this thread, any
// kind), thread-and-kind (this thread, this kind), or kind-any-thread (any thread, this kind).
// A row never matches a reservation scoped to a *different* thread or a *different* kind.
// Why the fourth: buildReservedTypeKeys emits a key with the any-thread sentinel and a real
// kind for a waiter that carries a payloadKind but no threadId (waitForMessage defaults
// payloadKind off `for` alone, so a for:'step' park registered without a thread has exactly
// that shape). Leaving that key unprobed lets a row its waiter WILL return from a check also
// reach the pane — the #12536 double delivery the snapshot exists to prevent.
export function isTypeReserved(
  reserved: ReadonlySet<string> | undefined,
  type: string,
  threadId: string | null | undefined,
  payloadKind: string | null | undefined
): boolean {
  if (!reserved) {
    return false
  }
  return (
    reserved.has(reservationKey(type, undefined, undefined)) ||
    reserved.has(reservationKey(type, threadId, undefined)) ||
    reserved.has(reservationKey(type, threadId, payloadKind)) ||
    reserved.has(reservationKey(type, undefined, payloadKind))
  )
}

// Why the same conjuncts as the notify predicate (A1): the live-waiter check and the consumer
// check must agree, or a row can be simultaneously "will be returned by a check" and "pushed
// into the pane" (or neither). A step waiter's payloadKind conjunct keeps it from claiming
// ordinary status rows on its own thread — those must still reach the no-consumer push path.
//
// Why notifiedThreadIdKnown (message-loss blocker fix): threadId/payloadKind here are the
// pending row's real, DB-read values — always trustworthy. What is NOT trustworthy is treating
// a still-registered thread-scoped waiter as "will be woken for this row some other way" when
// the notify that surfaced this delivery pass carried no threadId at all (several dispatch:
// pokes are like this) — that waiter gets no such future wake, so deferring to it here strands
// the row: matched by neither the consumer check (mismatched threadId) nor the push. Defaults
// to known (true) so this call's only production site keeps today's math except when it says
// otherwise.
export function messageTypeHasLiveWaiter(
  waiters: Set<ThreadScopedWaiter> | undefined,
  messageType: string,
  threadId: string | null | undefined,
  payloadKind: string | null | undefined,
  options?: { notifiedThreadIdKnown?: boolean }
): boolean {
  if (!waiters) {
    return false
  }
  const threadIdKnown = options?.notifiedThreadIdKnown ?? true
  for (const waiter of waiters) {
    if (waiter.threadId && !threadIdKnown) {
      continue
    }
    if (waiterConsumesArrival(waiter, messageType, threadId, payloadKind)) {
      return true
    }
  }
  return false
}

// Why messageType/threadId/payloadKind are optional: notifyMessageArrived is called without a
// messageType from a couple of legacy sites, which must keep matching every waiter; an ordinary
// row's payload never carries a host-written kind, so its payloadKind is null.
export function waiterConsumesArrival(
  waiter: ThreadScopedWaiter,
  messageType: string | undefined,
  threadId: string | null | undefined,
  payloadKind: string | null | undefined
): boolean {
  return (
    (!messageType || !waiter.typeFilter || waiter.typeFilter.includes(messageType)) &&
    (!waiter.threadId || waiter.threadId === threadId) &&
    (!waiter.payloadKind || waiter.payloadKind === payloadKind)
  )
}

// Why a passthrough, not a parser (amendment D): the discriminator now lives in the dedicated
// messages.payload_kind COLUMN (v34), written only by insertGatedMessage's `hostPayloadKind`
// (message-gate-writer.ts) — never derived from caller-supplied payload JSON, which a caller
// could shape to spoof or shadow a step. Every call site passes `row.payload_kind`, not
// `row.payload`; this function only normalizes `undefined` (pre-v34 in-memory rows) to `null`.
export function extractPayloadKind(payloadKind: string | null | undefined): string | null {
  return payloadKind ?? null
}

// Why (K25, blocker fix): extractPayloadKind trusts whatever `kind` a caller's free-text
// payload carries — the discriminator a for:'step' waiter and the pane trailer key off. Until
// messages.payload_kind (v34, S10-2a) makes A5's write choke real, this is the entry-side
// mitigation: refuse a payload.kind a caller supplied explicitly, at every RPC that stores
// free-form payload text, so no thread member can mint the lock-step signal or withhold a row
// under a forged step reservation.
export function assertPayloadKindNotCallerSet(payload: string | null | undefined): void {
  if (!payload) {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return // Malformed payload JSON is caught by lifecycle validation, not here.
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'kind' in parsed) {
    throw new OrchestrationError(
      'payload_kind_reserved',
      'Refused: payload.kind is set by the host — a step is recorded with orca agents step, not by sending a message.'
    )
  }
}
