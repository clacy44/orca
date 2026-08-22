import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('host presence clock-domain boundary', () => {
  // Why source-level: the hazard is a presence stamp that ALSO writes lastInputAtByPty — harmless to
  // presence and invisible to every behavioural assertion, but it would pin the interactive-output
  // heuristic's performance.now() comparison to a Date.now() value and mis-batch every keystroke's
  // redraw.
  const source = readFileSync(join(import.meta.dirname, 'pty.ts'), 'utf8')

  const bodyOf = (start: string, end: string): string => {
    const index = source.indexOf(start)
    expect(index).toBeGreaterThan(-1)
    return source.slice(index, source.indexOf(end, index)).replace(/^\s*\/\/.*$/gm, '')
  }

  it.each([
    ["ipcMain.on('pty:write', (event, args: unknown) => {", 'writePtyInput'],
    [
      "ipcMain.handle('pty:writeAccepted', (event, args: unknown): boolean | Promise<boolean> => {",
      'writePtyInputAccepted'
    ]
  ])('stamps presence above the claim tail in %s', (start, writer) => {
    const body = bodyOf(start, '\n  })\n')

    const stampIndex = body.indexOf('stampHostInput(args)')
    expect(stampIndex).toBeGreaterThan(-1)
    // Why above the tail and not merely above the writer: a lost claim never calls the writer at all,
    // so a stamp inside it goes silent exactly when a peer owns the width and the human reclaims it.
    expect(stampIndex).toBeLessThan(body.indexOf('hostViewportClaimTails.get'))
    expect(stampIndex).toBeLessThan(body.indexOf(writer))
    // Why the sender check stays first: it is the only thing separating the real renderer frame from
    // any other webContents, and a forged id must never reach the registry.
    expect(body.indexOf('isPtyWriteEventFromMainWindow')).toBeLessThan(stampIndex)
  })

  it.each(['writePtyInput', 'writePtyInputAccepted'])(
    'leaves lastInputAtByPty on its own clock in %s',
    (fnName) => {
      const body = bodyOf(`const ${fnName} = (args: PtyWritePayload)`, '\n  }\n')

      // Why: the writers must not stamp presence at all now — a second stamp there would double every
      // keystroke's change notification and re-hide the claim-tail hole above.
      expect(body).not.toContain('terminalPresenceRegistry')
      expect(body.match(/lastInputAtByPty/g)).toHaveLength(1)
      expect(body.indexOf('lastInputAtByPty.set')).toBeGreaterThan(
        body.indexOf('const now = performance.now()')
      )
    }
  )

  it('writes the presence stamp from exactly one place', () => {
    // Why comments are stripped: the pin is on CALL sites, and a WHY comment naming the mutator is how
    // the next reader learns why it is called there — it must not read as a second stamp.
    const code = source.replace(/^\s*\/\/.*$/gm, '')
    expect(code.match(/recordHostInteractiveInput/g)).toHaveLength(1)
  })
})
