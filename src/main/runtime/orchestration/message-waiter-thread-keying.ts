// Why this module: orca-runtime.ts (ratcheted) delegates the composite-key math here.
// S10-3 pact spec A1 (rev 6) — waiters/reservations keyed by (type, threadId, payloadKind),
// not type alone, so a step waiter never consumes-and-discards ordinary thread traffic.

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
export function buildReservedTypeKeys(
  waiters: Iterable<ThreadScopedWaiter> | undefined
): Set<string> {
  const keys = new Set<string>()
  if (!waiters) {
    return keys
  }
  for (const waiter of waiters) {
    for (const type of waiter.typeFilter ?? []) {
      keys.add(reservationKey(type, waiter.threadId, waiter.payloadKind))
    }
  }
  return keys
}

// Why three keys, not one: a row is reserved when ANY waiter that would have produced a
// covering key is live — wildcard-thread (any thread, any kind), thread-any-kind (this thread,
// any kind), or thread-and-kind (this thread, this kind). A row never matches a reservation
// scoped to a *different* thread or a *different* kind on the same thread.
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
    reserved.has(reservationKey(type, threadId, payloadKind))
  )
}

// Why the same conjuncts as the notify predicate (A1): the live-waiter check and the consumer
// check must agree, or a row can be simultaneously "will be returned by a check" and "pushed
// into the pane" (or neither). A step waiter's payloadKind conjunct keeps it from claiming
// ordinary status rows on its own thread — those must still reach the no-consumer push path.
export function messageTypeHasLiveWaiter(
  waiters: Set<ThreadScopedWaiter> | undefined,
  messageType: string,
  threadId: string | null | undefined,
  payloadKind: string | null | undefined
): boolean {
  if (!waiters) {
    return false
  }
  for (const waiter of waiters) {
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

// Why field-scoped and defensive: payload.kind is host-written only by orchestration.threads.step
// (A5); every other row's payload, when present, is caller JSON with no kind field, and a
// malformed/non-object payload must read as "not a step" rather than throw mid-notify.
export function extractPayloadKind(payload: string | null | undefined): string | null {
  if (!payload) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed !== null && typeof parsed === 'object' && 'kind' in parsed) {
      const kind = (parsed as { kind?: unknown }).kind
      return typeof kind === 'string' ? kind : null
    }
  } catch {
    // Malformed payload JSON is never a pact_step row.
  }
  return null
}
