import { describe, expect, it } from 'vitest'
import {
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
