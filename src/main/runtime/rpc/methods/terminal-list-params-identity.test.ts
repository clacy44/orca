/**
 * S9 §2d — `terminal.list` derives the caller's lane from the authenticated socket only.
 *
 * The half that is falsifiable at ONE site: the params schema has no identity field for a client
 * to spoof. Adding `pairedDeviceId` to it is exactly what would let the handler read a caller's
 * claim instead of the socket's fact, so this is the schema's own negative control.
 */
import { describe, expect, it } from 'vitest'
import { TerminalListParams } from './terminal'

describe('TerminalListParams', () => {
  it('carries no caller-identity field, so an injected one never reaches the handler', () => {
    const parsed = TerminalListParams.parse({
      worktree: 'id:w-1',
      pairedDeviceId: 'device-of-another-person',
      principalId: 'lane-of-another-person'
    })

    expect(parsed).toEqual({ worktree: 'id:w-1' })
    expect(Object.hasOwn(parsed, 'pairedDeviceId')).toBe(false)
    expect(Object.hasOwn(parsed, 'principalId')).toBe(false)
  })

  // Negative control: the schema is not simply dropping everything — the real params survive.
  it('keeps the params the method does take', () => {
    expect(
      TerminalListParams.parse({ worktree: 'id:w-1', limit: 5, includePresence: true })
    ).toEqual({ worktree: 'id:w-1', limit: 5, includePresence: true })
  })
})
