import { describe, expect, it, vi } from 'vitest'
import { isBarePeerHandle, resolveStaleBarePeerHandle } from './stale-handle-resolution'

describe('isBarePeerHandle', () => {
  it('is true for a plain terminal handle', () => {
    expect(isBarePeerHandle('term_abc123')).toBe(true)
  })

  it('is false for run: and dispatch: mailbox addresses', () => {
    expect(isBarePeerHandle('run:run_1')).toBe(false)
    expect(isBarePeerHandle('dispatch:ctx_1')).toBe(false)
  })
})

describe('resolveStaleBarePeerHandle', () => {
  function makeResolver(overrides: {
    isLiveHandle?: (handle: string) => boolean
    getTerminalHandleForPaneKey?: (paneKey: string) => string | null
  }) {
    return {
      isLiveHandle: overrides.isLiveHandle ?? (() => true),
      getTerminalHandleForPaneKey: overrides.getTerminalHandleForPaneKey ?? (() => null)
    }
  }

  it('refuses run:/dispatch: addresses — those have their own fallback', () => {
    const db = { getRecipientPaneKeyForBareHandle: vi.fn() }
    expect(resolveStaleBarePeerHandle('run:run_1', db, makeResolver({}))).toBeNull()
    expect(resolveStaleBarePeerHandle('dispatch:ctx_1', db, makeResolver({}))).toBeNull()
    expect(db.getRecipientPaneKeyForBareHandle).not.toHaveBeenCalled()
  })

  it('returns null when no pane key was ever recorded for the handle (negative control)', () => {
    const db = { getRecipientPaneKeyForBareHandle: () => null }
    expect(resolveStaleBarePeerHandle('term_stale', db, makeResolver({}))).toBeNull()
  })

  it('resolves the recorded pane key to the current live handle', () => {
    const db = { getRecipientPaneKeyForBareHandle: () => 'tab-1:pane-1' }
    const resolver = makeResolver({
      getTerminalHandleForPaneKey: (paneKey) =>
        paneKey === 'tab-1:pane-1' ? 'term_reminted' : null
    })
    expect(resolveStaleBarePeerHandle('term_stale', db, resolver)).toBe('term_reminted')
  })

  it('returns null when the pane key no longer resolves to a live handle', () => {
    const db = { getRecipientPaneKeyForBareHandle: () => 'tab-1:pane-1' }
    const resolver = makeResolver({
      getTerminalHandleForPaneKey: () => 'term_reminted',
      isLiveHandle: () => false
    })
    expect(resolveStaleBarePeerHandle('term_stale', db, resolver)).toBeNull()
  })

  // Mutation proof: short-circuiting resolveStaleBarePeerHandle to always
  // return null (the pre-fix behavior) turns this red.
  it('mutation proof: a resolvable pane key produces a non-null handle', () => {
    const db = { getRecipientPaneKeyForBareHandle: () => 'tab-1:pane-1' }
    const resolver = makeResolver({
      getTerminalHandleForPaneKey: () => 'term_reminted'
    })
    expect(resolveStaleBarePeerHandle('term_stale', db, resolver)).not.toBeNull()
  })
})
