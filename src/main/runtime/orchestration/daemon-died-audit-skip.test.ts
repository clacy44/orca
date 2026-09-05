// S10-21a C7f (D-R114 fix 3): index.ts's daemon_died fanout skip predicate.
import { describe, expect, it } from 'vitest'
import { shouldSkipDaemonDiedAudit } from './daemon-died-audit-skip'

describe('S10-21a C7f: shouldSkipDaemonDiedAudit', () => {
  it('skips a plain shell — no launch row, no registered agent row', () => {
    expect(shouldSkipDaemonDiedAudit(false, undefined)).toBe(true)
  })

  it('skips a plain shell whose only row on the pane is derived, not registered', () => {
    expect(shouldSkipDaemonDiedAudit(false, { derived: 1 })).toBe(true)
  })

  it('does not skip when there is a launch row, even with no registered agent row', () => {
    expect(shouldSkipDaemonDiedAudit(true, undefined)).toBe(false)
  })

  it('does not skip when there is no launch row but a registered (derived=0) agent row exists', () => {
    expect(shouldSkipDaemonDiedAudit(false, { derived: 0 })).toBe(false)
  })

  it('does not skip when both a launch row and a registered row exist', () => {
    expect(shouldSkipDaemonDiedAudit(true, { derived: 0 })).toBe(false)
  })
})
