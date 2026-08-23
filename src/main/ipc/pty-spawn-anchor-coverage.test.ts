import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The wrapper is the anchor: a fourth `provider.spawn` added to ipc/pty.ts would start a process
// the lane computation never saw, and nothing else in the file would notice (S9 §2 preamble).
describe('spawn-anchor coverage of ipc/pty.ts', () => {
  const source = readFileSync(join(__dirname, 'pty.ts'), 'utf8')

  it('reaches a provider for a fresh process only through spawnWithLane', () => {
    expect(source.match(/spawnWithLane\(/g) ?? []).toHaveLength(2)
    expect(source.match(/provider\.spawn\(/g) ?? []).toHaveLength(1)
  })

  it('exempts exactly one call — the reattach, which proves it reattached', () => {
    const reattach = source.slice(source.indexOf('await provider.spawn({'))

    expect(reattach.slice(0, 400)).toContain('attachOnly: true')
    expect(source).toContain("throw new Error('terminal_pane_owner_changed')")
  })
})
