// S10-21a C11 (design §4 row 16, §8 row C11): the CLI help text documents the one-time caveat
// (a session running before this build's install needs exactly one register on its first
// post-install restart) and what `sessionLaunchKnown` means.
import { describe, expect, it } from 'vitest'
import { AGENTS_COMMAND_SPECS } from './agents'

function specFor(...path: string[]) {
  const found = AGENTS_COMMAND_SPECS.find(
    (s) => s.path.length === path.length && s.path.every((p, i) => p === path[i])
  )
  if (!found) {
    throw new Error(`spec not found: ${path.join(' ')}`)
  }
  return found
}

describe('S10-21a C11: agents CLI help text', () => {
  it('agents register documents the one-time post-install caveat', () => {
    const notes = specFor('agents', 'register').notes ?? []
    expect(notes.some((n) => n.includes('one register') && n.includes('restart'))).toBe(true)
  })

  it('agents show documents sessionLaunchKnown and its own-row-only visibility', () => {
    const notes = specFor('agents', 'show').notes ?? []
    expect(notes.some((n) => n.includes('sessionLaunchKnown'))).toBe(true)
  })
})
