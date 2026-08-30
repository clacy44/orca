import { describe, expect, it } from 'vitest'
import {
  resolveMessageDeliveryState,
  resolveMessageRecipientPresence
} from './message-delivery-state'

describe('resolveMessageDeliveryState', () => {
  it('is queued when unread and never pointed', () => {
    expect(resolveMessageDeliveryState({ id: 'm1', read: 0 }, undefined)).toBe('queued')
    expect(resolveMessageDeliveryState({ id: 'm1', read: 0 }, new Set(['m2']))).toBe('queued')
  })

  it('is pointed when unread and in the pointed set', () => {
    expect(resolveMessageDeliveryState({ id: 'm1', read: 0 }, new Set(['m1']))).toBe('pointed')
  })

  it('is read regardless of the pointed set, once the read bit is set', () => {
    expect(resolveMessageDeliveryState({ id: 'm1', read: 1 }, new Set(['m1']))).toBe('read')
    expect(resolveMessageDeliveryState({ id: 'm1', read: 1 }, undefined)).toBe('read')
  })
})

describe('resolveMessageRecipientPresence', () => {
  it('is unresolved when the handle names no live terminal', () => {
    expect(resolveMessageRecipientPresence('term_ghost', () => null)).toEqual({
      state: 'unresolved',
      lastSeenAt: null
    })
  })

  it('reports connected/disconnected with the leaf’s lastOutputAt', () => {
    expect(
      resolveMessageRecipientPresence('term_a', () => ({ connected: true, lastOutputAt: 42 }))
    ).toEqual({ state: 'connected', lastSeenAt: 42 })
    expect(
      resolveMessageRecipientPresence('term_a', () => ({ connected: false, lastOutputAt: null }))
    ).toEqual({ state: 'disconnected', lastSeenAt: null })
  })
})
