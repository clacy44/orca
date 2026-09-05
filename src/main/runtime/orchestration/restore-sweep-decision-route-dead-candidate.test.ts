// S10-21a C7l (Ruling 34 Addendum 29, items 5 (N4) and 6 (N5)): direct unit coverage of
// `routeDeadCandidate`'s row-11 identity-unknown reason and the row-'unknown' `round=` label —
// neither had a dedicated test file for `restore-sweep-decision.ts`'s pure functions before.
import { describe, expect, it } from 'vitest'
import { routeDeadCandidate } from './restore-sweep-decision'
import type { ControllerInventory } from './agent-process-identity'

describe('routeDeadCandidate (C7l items 5/6)', () => {
  const occupant = { paneKey: 'tab1:leaf-1', ptyId: 'pty-occ' }

  it('[item 5, N4] row 11 with identityStatus dead: "leaf_occupied_by_live_non_agent_pty <ptyId>" (never "identity_unknown")', () => {
    const routing = routeDeadCandidate(occupant, 'tab1:leaf-1', 'present', true, null, 'dead')
    expect(routing.audit).toEqual({
      verb: 'sweep_note',
      reasonCode: 'leaf_occupied_by_live_non_agent_pty pty-occ'
    })
  })

  it('[item 5, N4] row 11 with identityStatus unknown_no_identity: "leaf_occupied_by_live_pty_identity_unknown <ptyId>" (never "non_agent")', () => {
    const routing = routeDeadCandidate(
      occupant,
      'tab1:leaf-1',
      'present',
      true,
      null,
      'unknown_no_identity'
    )
    expect(routing.audit).toEqual({
      verb: 'sweep_note',
      reasonCode: 'leaf_occupied_by_live_pty_identity_unknown pty-occ'
    })
  })

  it('[item 6, N5] "unknown" liveness, round null: round=null', () => {
    const routing = routeDeadCandidate(occupant, 'tab1:leaf-1', 'unknown', true, null)
    expect(routing.audit).toEqual({
      verb: 'sweep_note',
      reasonCode: 'leaf_liveness_unknown: occupant pty-occ round=null'
    })
  })

  it('[item 6, N5] "unknown" liveness, round exists but does NOT list the ptyId: round=not_listed (never "present")', () => {
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map()
    }
    const routing = routeDeadCandidate(occupant, 'tab1:leaf-1', 'unknown', true, inventory)
    expect(routing.audit).toEqual({
      verb: 'sweep_note',
      reasonCode: 'leaf_liveness_unknown: occupant pty-occ round=not_listed'
    })
  })

  it('[item 6, N5] "unknown" liveness, round exists AND lists the ptyId: round=listed', () => {
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(['pty-occ']),
      terminalIdentityByPtyId: new Map()
    }
    const routing = routeDeadCandidate(occupant, 'tab1:leaf-1', 'unknown', true, inventory)
    expect(routing.audit).toEqual({
      verb: 'sweep_note',
      reasonCode: 'leaf_liveness_unknown: occupant pty-occ round=listed'
    })
  })
})
