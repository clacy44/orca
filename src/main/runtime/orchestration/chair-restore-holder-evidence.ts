// S10-21f b2b-10q M2 (MAX-LINES): the holder's incumbent-death + settle evidence assembly, split
// out of chair-restore.ts to keep that file's own effective-line ratchet (<=300) — the three
// early-row branches (skipped_daemon_survived / layer3 / proceed) resolve incumbent, d2Inventory,
// inventoryRoundNonNull and holderHasConnectedPty exactly as chair-restore.ts did inline, then one
// call to the runtime's holderSettledByAbsence (incumbent-death.ts's holderAbsenceSettledNotLive)
// proves the SAME-generation settle window from the AUTHORITATIVE D2 absence signal, never D3's
// leaf-based clock (always false on a headless `serve` process — no window ever publishes a leaf
// record there).
import type { OrcaRuntimeService } from '../orca-runtime'
import type { EarlyRowsDecision } from './restore-sweep-decision'
import { collectSweepEvidence } from './restore-sweep-evidence'
import { resolveIncumbentDeath, type IncumbentVerdict } from '../incumbent-death'
import type { ControllerInventory } from './agent-process-identity'

export type HolderIncumbentEvidence = {
  incumbent: IncumbentVerdict
  d2Inventory: 'present' | 'absent' | 'unknown'
  inventoryRoundNonNull: boolean
  holderHasConnectedPty: boolean
  holderSettledNotLive: boolean
}

export async function resolveHolderIncumbentEvidence(
  runtime: OrcaRuntimeService,
  early: EarlyRowsDecision,
  holderPaneKey: string,
  tabId: string,
  leafId: string,
  hostId: string,
  inventory: ControllerInventory | null
): Promise<HolderIncumbentEvidence> {
  let incumbent: IncumbentVerdict
  let d2Inventory: 'present' | 'absent' | 'unknown'
  let inventoryRoundNonNull: boolean
  let holderHasConnectedPty = runtime.findConnectedPtyForPane(holderPaneKey) !== undefined
  if (early.kind === 'skipped_daemon_survived') {
    incumbent = { dead: false, reason: 'live' }
    d2Inventory = 'present'
    inventoryRoundNonNull = true
  } else if (early.kind === 'layer3') {
    // [JUDGMENT CALL, see RETURN] 'layer3' covers a null round AND an ambiguous-pty identity
    // — collapsed to "insufficient evidence" either way: never wrongly grants, may over-refuse.
    incumbent = { dead: false, reason: 'inventory_unknown' }
    d2Inventory = 'unknown'
    inventoryRoundNonNull = false
  } else {
    const evidenceBundle = await collectSweepEvidence(
      runtime,
      holderPaneKey,
      tabId,
      leafId,
      hostId,
      inventory,
      early.identity,
      early.status
    )
    incumbent = resolveIncumbentDeath(evidenceBundle.incumbentEvidence)
    d2Inventory = evidenceBundle.incumbentEvidence.d2.inventory
    inventoryRoundNonNull = true
    holderHasConnectedPty = holderHasConnectedPty || evidenceBundle.occupantLiveness === 'present'
  }
  const holderSettledNotLive = runtime.holderSettledByAbsence(
    holderPaneKey,
    inventoryRoundNonNull,
    d2Inventory,
    holderHasConnectedPty
  )
  return {
    incumbent,
    d2Inventory,
    inventoryRoundNonNull,
    holderHasConnectedPty,
    holderSettledNotLive
  }
}
