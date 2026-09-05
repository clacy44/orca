// S10-21a C7m (Ruling 34 Addendum 30, item 4; D-R120 F4): the deferral family key strips only
// the trailing per-pane suffix, keeping the colon namespace — never collapses to the bare
// namespace before the colon.
import { describe, expect, it } from 'vitest'
import { restoreSweepDeferralFamily } from './restore-sweep-deferral-family'

describe('S10-21a C7m item 4: restoreSweepDeferralFamily', () => {
  it('strips only the trailing ptyId token, keeping the colon namespace (fails at base — was "sweep_deferred")', () => {
    expect(restoreSweepDeferralFamily('sweep_deferred: agent_pty_identity_ambiguous <ptyId>')).toBe(
      'sweep_deferred: agent_pty_identity_ambiguous'
    )
  })

  it('an inventory-unavailable deferral keys separately from an ambiguous one (fails at base — both collapsed to "sweep_deferred")', () => {
    const ambiguous = restoreSweepDeferralFamily(
      'sweep_deferred: agent_pty_identity_ambiguous <ptyId>'
    )
    const unavailable = restoreSweepDeferralFamily(
      'sweep_deferred: controller_inventory_unavailable'
    )
    expect(ambiguous).not.toBe(unavailable)
    expect(unavailable).toBe('sweep_deferred: controller_inventory_unavailable')
  })

  it('no colon at all -> the whole code is the family', () => {
    expect(restoreSweepDeferralFamily('sweep_no_launch_row')).toBe('sweep_no_launch_row')
    expect(restoreSweepDeferralFamily('sweep_remote_pane_excluded')).toBe(
      'sweep_remote_pane_excluded'
    )
  })

  it('a single-word reason after the colon is left unchanged', () => {
    expect(restoreSweepDeferralFamily('unrecorded_launch: unparseable_pane_or_no_worktree')).toBe(
      'unrecorded_launch: unparseable_pane_or_no_worktree'
    )
  })

  it('two panes deferred for the same family count as one key with value 2', () => {
    const counts: Record<string, number> = {}
    for (const code of [
      'sweep_deferred: agent_pty_identity_ambiguous <pty-a>',
      'sweep_deferred: agent_pty_identity_ambiguous <pty-b>'
    ]) {
      const family = restoreSweepDeferralFamily(code)
      counts[family] = (counts[family] ?? 0) + 1
    }
    expect(counts).toEqual({ 'sweep_deferred: agent_pty_identity_ambiguous': 2 })
  })
})
