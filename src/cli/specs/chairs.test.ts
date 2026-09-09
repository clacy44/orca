import { describe, expect, it } from 'vitest'
import { CHAIRS_COMMAND_SPECS } from './chairs'
import { effectiveAllowedFlags } from '../args'
import { formatCommandHelp } from '../help'

describe('chairs command specs', () => {
  it('renders --json and --help in every command Options block', () => {
    for (const entry of CHAIRS_COMMAND_SPECS) {
      const help = formatCommandHelp(entry)
      expect(help).toContain('--json')
      expect(help).toContain('--help')
    }
  })

  it('never accepts or advertises a --pane/--terminal flag (CONTAINMENT #1)', () => {
    for (const entry of CHAIRS_COMMAND_SPECS) {
      expect(effectiveAllowedFlags(entry)).not.toContain('pane')
      expect(effectiveAllowedFlags(entry)).not.toContain('terminal')
      const help = formatCommandHelp(entry)
      expect(help).not.toContain('--pane')
      expect(help).not.toContain('--terminal')
    }
  })

  it('covers restore, status, and export', () => {
    const paths = CHAIRS_COMMAND_SPECS.map((entry) => entry.path.join(' '))
    expect(paths).toEqual(['chairs restore', 'chairs status', 'chairs export'])
  })

  it('restore accepts --manifest, --only, and --dry-run', () => {
    const restore = CHAIRS_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'chairs restore')
    expect(restore).toBeDefined()
    const allowed = effectiveAllowedFlags(restore!)
    expect(allowed).toContain('manifest')
    expect(allowed).toContain('only')
    expect(allowed).toContain('dry-run')
  })
})
