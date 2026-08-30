import { describe, expect, it } from 'vitest'
import {
  assertPayloadKindNotCallerSet,
  buildReservedTypeKeys,
  extractPayloadKind,
  isTypeReserved,
  messageTypeHasLiveWaiter,
  reservationKey,
  waiterConsumesArrival
} from './message-waiter-thread-keying'

describe('reservationKey', () => {
  it('uses the any-thread/any-kind sentinel for absent fields', () => {
    expect(reservationKey('status', undefined, undefined)).toBe('status\0*\0*')
    expect(reservationKey('status', null, null)).toBe('status\0*\0*')
  })

  it('embeds a concrete threadId and payloadKind', () => {
    expect(reservationKey('status', 'thr_1', 'pact_step')).toBe('status\0thr_1\0pact_step')
    expect(reservationKey('status', 'thr_1', undefined)).toBe('status\0thr_1\0*')
  })
})

describe('buildReservedTypeKeys', () => {
  it('keys each waiter type by its own thread and kind', () => {
    const keys = buildReservedTypeKeys(
      new Set([
        { typeFilter: ['status'], threadId: 'thr_1', payloadKind: 'pact_step' },
        { typeFilter: ['worker_done'] }
      ])
    )
    expect(keys).toEqual(new Set(['status\0thr_1\0pact_step', 'worker_done\0*\0*']))
  })

  it('is empty for undefined waiters, an unfiltered waiter, and a for:pact waiter (typeFilter [])', () => {
    expect(buildReservedTypeKeys(undefined)).toEqual(new Set())
    expect(buildReservedTypeKeys(new Set([{ threadId: 'thr_1' }]))).toEqual(new Set())
    expect(buildReservedTypeKeys(new Set([{ typeFilter: [], threadId: 'thr_1' }]))).toEqual(
      new Set()
    )
  })

  // Blocker fix: a notify with no threadId (several dispatch: pokes carry no specific row)
  // cannot trust a thread-scoped waiter's own threadId to describe the row(s) the push is
  // about to read — reserving on it anyway strands a real pending row unconsumed AND unpushed.
  describe('notifiedThreadIdKnown: false (message-loss blocker fix)', () => {
    it('drops every thread-scoped waiter — it contributes no key at all', () => {
      const keys = buildReservedTypeKeys(
        new Set([{ typeFilter: ['status'], threadId: 'thr_5', payloadKind: 'pact_step' }]),
        { notifiedThreadIdKnown: false }
      )
      expect(keys).toEqual(new Set())
    })

    it('still reserves a thread-unscoped waiter — legacy #12536 coverage is unaffected', () => {
      const keys = buildReservedTypeKeys(new Set([{ typeFilter: ['worker_done'] }]), {
        notifiedThreadIdKnown: false
      })
      expect(keys).toEqual(new Set(['worker_done\0*\0*']))
    })

    it("defaults to known (omitted option) — every existing call site keeps today's math", () => {
      const waiters = new Set([
        { typeFilter: ['status'], threadId: 'thr_1', payloadKind: 'pact_step' }
      ])
      expect(buildReservedTypeKeys(waiters)).toEqual(
        buildReservedTypeKeys(waiters, {
          notifiedThreadIdKnown: true
        })
      )
      expect(buildReservedTypeKeys(waiters)).toEqual(new Set(['status\0thr_1\0pact_step']))
    })
  })
})

describe('isTypeReserved', () => {
  it('matches a legacy any-thread/any-kind reservation regardless of the row', () => {
    const reserved = new Set(['status\0*\0*'])
    expect(isTypeReserved(reserved, 'status', 'thr_1', null)).toBe(true)
    expect(isTypeReserved(reserved, 'status', 'thr_1', 'pact_step')).toBe(true)
    expect(isTypeReserved(reserved, 'status', null, null)).toBe(true)
  })

  it("does not let a thread-scoped reservation hide a different thread's row (K21)", () => {
    const reserved = new Set(['status\0thr_2\0*'])
    expect(isTypeReserved(reserved, 'status', 'thr_1', null)).toBe(false)
    expect(isTypeReserved(reserved, 'status', 'thr_2', null)).toBe(true)
  })

  it('does not let a kind-scoped reservation hide an ordinary row on the same thread (rev 6)', () => {
    const reserved = new Set(['status\0thr_1\0pact_step'])
    expect(isTypeReserved(reserved, 'status', 'thr_1', null)).toBe(false)
    expect(isTypeReserved(reserved, 'status', 'thr_1', 'pact_step')).toBe(true)
  })

  it('is false with no reservation set', () => {
    expect(isTypeReserved(undefined, 'status', 'thr_1', null)).toBe(false)
  })
})

describe('messageTypeHasLiveWaiter', () => {
  it('requires the type filter to admit the type', () => {
    const waiters = new Set([{ typeFilter: ['worker_done'] }])
    expect(messageTypeHasLiveWaiter(waiters, 'status', null, null)).toBe(false)
    expect(messageTypeHasLiveWaiter(waiters, 'worker_done', null, null)).toBe(true)
  })

  it('a thread-scoped waiter only covers its own thread (K14)', () => {
    const waiters = new Set([{ typeFilter: ['status'], threadId: 'thr_2' }])
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_1', null)).toBe(false)
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_2', null)).toBe(true)
  })

  it('a step waiter (payloadKind pact_step) does not cover ordinary status traffic on its own thread', () => {
    const waiters = new Set([
      { typeFilter: ['status'], threadId: 'thr_1', payloadKind: 'pact_step' }
    ])
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_1', null)).toBe(false)
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_1', 'pact_step')).toBe(true)
  })

  it('an empty typeFilter (for:pact) never has a live waiter for any type', () => {
    const waiters = new Set([{ typeFilter: [], threadId: 'thr_1' }])
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_1', null)).toBe(false)
  })

  it('a legacy no-thread/no-kind waiter covers every thread and kind (#12536 stays closed)', () => {
    const waiters = new Set([{ typeFilter: ['status'] }])
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_1', null)).toBe(true)
    expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_2', 'pact_step')).toBe(true)
    expect(messageTypeHasLiveWaiter(waiters, 'status', null, null)).toBe(true)
  })

  // Message-loss blocker fix: a still-live thread-scoped waiter must not be treated as "will
  // cover this row" when the notify that surfaced this delivery pass never named a threadId —
  // it withholds the push without ever actually waking that waiter (unconsumed AND unpushed).
  describe('notifiedThreadIdKnown: false (message-loss blocker fix)', () => {
    it("a thread-scoped waiter no longer covers even its own thread's row", () => {
      const waiters = new Set([{ typeFilter: ['status'], threadId: 'thr_5' }])
      expect(
        messageTypeHasLiveWaiter(waiters, 'status', 'thr_5', null, { notifiedThreadIdKnown: false })
      ).toBe(false)
    })

    it('a legacy no-thread waiter still covers every thread — #12536 is unaffected', () => {
      const waiters = new Set([{ typeFilter: ['status'] }])
      expect(
        messageTypeHasLiveWaiter(waiters, 'status', 'thr_5', null, { notifiedThreadIdKnown: false })
      ).toBe(true)
    })

    it("defaults to known (omitted options) — the one production call site keeps today's math", () => {
      const waiters = new Set([{ typeFilter: ['status'], threadId: 'thr_5' }])
      expect(messageTypeHasLiveWaiter(waiters, 'status', 'thr_5', null)).toBe(true)
    })
  })
})

describe('waiterConsumesArrival', () => {
  it('is the same conjuncts as messageTypeHasLiveWaiter', () => {
    const waiter = { typeFilter: ['status'], threadId: 'thr_2' }
    expect(waiterConsumesArrival(waiter, 'status', 'thr_1', null)).toBe(false)
    expect(waiterConsumesArrival(waiter, 'status', 'thr_2', null)).toBe(true)
  })

  it('an unfiltered/no-messageType call still matches on thread and kind', () => {
    const waiter = { threadId: 'thr_2', payloadKind: 'pact_step' }
    expect(waiterConsumesArrival(waiter, undefined, 'thr_1', 'pact_step')).toBe(false)
    expect(waiterConsumesArrival(waiter, undefined, 'thr_2', null)).toBe(false)
    expect(waiterConsumesArrival(waiter, undefined, 'thr_2', 'pact_step')).toBe(true)
  })
})

// The reservation lookup must cover every key buildReservedTypeKeys can emit, or a row a live
// waiter WILL return from its check also reaches the pane (#12536).
describe('reservation key algebra is closed', () => {
  it('probes the kind-scoped, thread-unscoped key the builder can emit', () => {
    const waiters = new Set([{ typeFilter: ['status'], payloadKind: 'pact_step' }])
    const keys = buildReservedTypeKeys(waiters)
    expect(keys.has(reservationKey('status', undefined, 'pact_step'))).toBe(true)
    // The waiter consumes this row, so the snapshot must withhold it from the push.
    expect(waiterConsumesArrival([...waiters][0], 'status', 'thr_1', 'pact_step')).toBe(true)
    expect(isTypeReserved(keys, 'status', 'thr_1', 'pact_step')).toBe(true)
  })

  it('negative control: that reservation never withholds a row of a different kind', () => {
    const keys = buildReservedTypeKeys(
      new Set([{ typeFilter: ['status'], payloadKind: 'pact_step' }])
    )
    expect(isTypeReserved(keys, 'status', 'thr_1', null)).toBe(false)
    expect(isTypeReserved(keys, 'status', 'thr_1', 'other_kind')).toBe(false)
  })

  it('every key the builder emits is found by the lookup', () => {
    const shapes = [
      {},
      { threadId: 'thr_1' },
      { payloadKind: 'pact_step' },
      { threadId: 'thr_1', payloadKind: 'pact_step' }
    ]
    for (const shape of shapes) {
      const waiter = { typeFilter: ['status'], ...shape }
      expect(
        isTypeReserved(
          buildReservedTypeKeys(new Set([waiter])),
          'status',
          shape.threadId ?? 'thr_1',
          shape.payloadKind ?? null
        )
      ).toBe(true)
    }
  })
})

describe('extractPayloadKind', () => {
  it('reads a host-written kind out of the JSON payload', () => {
    expect(extractPayloadKind(JSON.stringify({ kind: 'pact_step', ordinal: 1 }))).toBe('pact_step')
  })

  it('is null for absent, non-object, or kind-less payloads', () => {
    expect(extractPayloadKind(null)).toBeNull()
    expect(extractPayloadKind(undefined)).toBeNull()
    expect(extractPayloadKind(JSON.stringify({ origin: 'runtime' }))).toBeNull()
    expect(extractPayloadKind('not json')).toBeNull()
    expect(extractPayloadKind(JSON.stringify('a string payload'))).toBeNull()
  })
})

describe('assertPayloadKindNotCallerSet (K25, blocker fix)', () => {
  it('refuses any payload carrying an explicit kind field', () => {
    expect(() => assertPayloadKindNotCallerSet(JSON.stringify({ kind: 'pact_step' }))).toThrow(
      expect.objectContaining({ code: 'payload_kind_reserved' })
    )
    // Not just the reserved pact_step value — the whole field is refused (rev 6 wording).
    expect(() => assertPayloadKindNotCallerSet(JSON.stringify({ kind: 'anything' }))).toThrow(
      expect.objectContaining({ code: 'payload_kind_reserved' })
    )
  })

  it('negative control: passes absent, kind-less, non-object, and malformed payloads through', () => {
    expect(() => assertPayloadKindNotCallerSet(null)).not.toThrow()
    expect(() => assertPayloadKindNotCallerSet(undefined)).not.toThrow()
    expect(() =>
      assertPayloadKindNotCallerSet(JSON.stringify({ dispatchId: 'ctx_1' }))
    ).not.toThrow()
    expect(() => assertPayloadKindNotCallerSet(JSON.stringify('a string payload'))).not.toThrow()
    expect(() => assertPayloadKindNotCallerSet('not json{')).not.toThrow()
  })
})
