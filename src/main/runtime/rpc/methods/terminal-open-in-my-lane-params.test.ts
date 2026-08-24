/**
 * S9 §2g — `terminal.openInMyLane`'s wire boundary.
 *
 * The method is registered, and its params carry NO caller-identity field: the lane the new
 * terminal runs in is derived from the authenticated socket in the handler, never named by the
 * client — the same rule `terminal.list` keeps.
 */
import { describe, expect, it } from 'vitest'
import { TERMINAL_METHODS, TerminalOpenInMyLane } from './terminal'

describe('terminal.openInMyLane params', () => {
  it('is a registered terminal method', () => {
    expect(TERMINAL_METHODS.some((method) => method.name === 'terminal.openInMyLane')).toBe(true)
  })

  it('requires a source PTY id', () => {
    expect(TerminalOpenInMyLane.safeParse({}).success).toBe(false)
  })

  it('drops an injected caller-identity field, so it never reaches the handler', () => {
    const parsed = TerminalOpenInMyLane.parse({
      sourcePtyId: 'pty-1',
      seedPrompt: 'fix the bug',
      pairedDeviceId: 'device-of-another-person',
      principalId: 'lane-of-another-person'
    })
    expect(parsed).toEqual({ sourcePtyId: 'pty-1', seedPrompt: 'fix the bug' })
    expect(Object.hasOwn(parsed, 'pairedDeviceId')).toBe(false)
    expect(Object.hasOwn(parsed, 'principalId')).toBe(false)
  })
})
