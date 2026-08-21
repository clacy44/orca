import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('host presence clock-domain boundary', () => {
  // Why source-level: the hazard is a presence stamp that ALSO writes lastInputAtByPty — harmless to
  // presence and invisible to every behavioural assertion, but it would pin the interactive-output
  // heuristic's performance.now() comparison to a Date.now() value and mis-batch every keystroke's
  // redraw. The same read proves the stamp precedes every guard, which no rejected write can show.
  const source = readFileSync(join(import.meta.dirname, 'pty.ts'), 'utf8')

  it.each(['writePtyInput', 'writePtyInputAccepted'])(
    'stamps presence before every guard in %s and leaves lastInputAtByPty alone',
    (fnName) => {
      const start = source.indexOf(`const ${fnName} = (args: PtyWritePayload)`)
      expect(start).toBeGreaterThan(-1)
      const body = source
        .slice(start, source.indexOf('\n  }\n', start))
        .replace(/^\s*\/\/.*$/gm, '')

      const stampIndex = body.indexOf('terminalPresenceRegistry.recordHostInteractiveInput')
      expect(stampIndex).toBeGreaterThan(-1)
      expect(stampIndex).toBeLessThan(body.indexOf('if ('))
      expect(body.slice(0, stampIndex)).not.toContain('return')
      expect(body.match(/lastInputAtByPty/g)).toHaveLength(1)
      expect(body.indexOf('lastInputAtByPty.set')).toBeGreaterThan(
        body.indexOf('const now = performance.now()')
      )
    }
  )
})
