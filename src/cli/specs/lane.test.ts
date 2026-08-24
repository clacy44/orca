import { describe, expect, it } from 'vitest'

import { LANE_COMMAND_SPECS } from './lane'
import { effectiveAllowedFlags } from '../args'
import { formatCommandHelp } from '../help'

describe('lane command specs', () => {
  it('renders --json and --help in every command Options block', () => {
    for (const entry of LANE_COMMAND_SPECS) {
      const help = formatCommandHelp(entry)
      expect(help).toContain('--json')
      expect(help).toContain('--help')
    }
  })

  it('does not accept or advertise browser page targeting', () => {
    for (const entry of LANE_COMMAND_SPECS) {
      expect(effectiveAllowedFlags(entry)).not.toContain('page')
      expect(formatCommandHelp(entry)).not.toContain('--page')
    }
  })

  it('documents --device selection by id, prefix, or label on bind', () => {
    const bind = LANE_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'lane bind')
    expect(bind).toBeDefined()
    const help = formatCommandHelp(bind!)
    expect(help).toContain('Device id, unique id prefix, or pairing label')
  })
})
