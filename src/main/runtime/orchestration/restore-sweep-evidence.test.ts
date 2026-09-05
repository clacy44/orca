// S10-21a C7m (Ruling 34 Addendum 30, item 1; D-R120 F1): rows 8-11's occupant read must fall
// back to the runtime's own pty records (`findConnectedPtyForPane`) when the renderer leaf graph
// (`findConnectedLeafOccupant`) has nothing yet — a surviving daemon pty on the persisted pane is
// an own-pane occupant with liveness read from the round/connected-now union, never row 8 with
// placement.
import { describe, expect, it } from 'vitest'
import { collectSweepEvidence, type CollectSweepEvidenceDeps } from './restore-sweep-evidence'
import { routeDeadCandidate } from './restore-sweep-decision'
import type { IncumbentEvidence } from '../incumbent-death'

describe('S10-21a C7m item 1: collectSweepEvidence occupant fallback', () => {
  it('serve-shaped: empty leaves, a round that lists the pane pty (record connected, paneKey = candidate) -> own-pane occupant, no placement, row 11', async () => {
    const paneKey = 'tab1:leaf-a'
    const ptyId = 'pty-runtime-record'
    const deps: CollectSweepEvidenceDeps = {
      // Empty leaves — the renderer graph has nothing.
      findConnectedLeafOccupant: () => undefined,
      // The runtime's OWN pty record: connected, on this exact pane.
      findConnectedPtyForPane: (candidatePaneKey) =>
        candidatePaneKey === paneKey ? { paneKey, ptyId } : undefined,
      getPersistedPtyIdForLeaf: () => undefined,
      collectIncumbentEvidence: async (): Promise<IncumbentEvidence> => ({
        paneKey,
        d1: { ptyKnownToRuntime: true, exitObservedThisGeneration: false },
        d2: { inventory: 'present' },
        d3: { liveNow: true, firstObservedNotLiveAt: null, now: 0 },
        ptyState: (id) => (id === ptyId ? 'present' : 'unknown'),
        ptyConnectedNow: (id) => id === ptyId
      })
    }

    const evidence = await collectSweepEvidence(
      deps,
      paneKey,
      'tab1',
      'leaf-a',
      'local',
      { allLivePtyIds: new Set([ptyId]), terminalIdentityByPtyId: new Map() },
      // dead/unknown identity — no agent identity to attach.
      null,
      'unknown_no_identity'
    )

    expect(evidence.occupant).toEqual({ paneKey, ptyId })
    expect(evidence.occupantLiveness).toBe('present')

    const routing = routeDeadCandidate(
      evidence.occupant,
      paneKey,
      evidence.occupantLiveness,
      true,
      { allLivePtyIds: new Set([ptyId]), terminalIdentityByPtyId: new Map() },
      'unknown_no_identity'
    )
    // Row 11: never yielded to, never spawned over.
    expect(routing.offerPlacement).toBe(false)
    expect(routing.audit).toEqual({
      verb: 'sweep_note',
      reasonCode: `leaf_occupied_by_live_pty_identity_unknown ${ptyId}`
    })
  })
})
