// S10-21a C7l (Ruling 34 Addendum 29, item 4): N2 — `ptyConnectedNow` must not force 'present'
// for ANY connected pty record, including ones that predate the round. A record's own `seq`
// (assigned once, at creation) is compared against the round's `roundSeq`
// (`takeControllerInventoryForSweep`) — only a record created AFTER the round counts as
// "connected now" for the union; a record seeded BEFORE it is judged by the round alone.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { ControllerInventory } from './orchestration/agent-process-identity'

describe('OrcaRuntimeService#collectIncumbentEvidence ptyConnectedNow (C7l item 4)', () => {
  it('a record seeded BEFORE the round, absent from it, reads absent (never resurrected by connectedNow) — row 10', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.registerPty('pty-before-round', 'wt-1')
    // roundSeq captured strictly AFTER pty-before-round was created.
    const roundSeq = (runtime as unknown as { ptyRecordSeqCounter: number }).ptyRecordSeqCounter
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(), // the round does NOT list this ptyId — absent.
      terminalIdentityByPtyId: new Map(),
      roundSeq
    }
    const evidence = await runtime.collectIncumbentEvidence(
      'tab1:leaf-before',
      'pty-before-round',
      undefined,
      inventory
    )
    expect(evidence.ptyState?.('pty-before-round')).toBe('absent')
    // Still connected right now, but seeded before the round — connectedNow must NOT rescue it.
    expect(evidence.ptyConnectedNow?.('pty-before-round')).toBe(false)
  })

  it('a record created AFTER the round reads present via connectedNow — row 11', async () => {
    const runtime = new OrcaRuntimeService()
    // roundSeq captured BEFORE pty-after-round is created.
    const roundSeq = (runtime as unknown as { ptyRecordSeqCounter: number }).ptyRecordSeqCounter
    runtime.registerPty('pty-after-round', 'wt-1')
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(), // the round predates this pty entirely — it cannot list it.
      terminalIdentityByPtyId: new Map(),
      roundSeq
    }
    const evidence = await runtime.collectIncumbentEvidence(
      'tab1:leaf-after',
      'pty-after-round',
      undefined,
      inventory
    )
    expect(evidence.ptyState?.('pty-after-round')).toBe('absent')
    expect(evidence.ptyConnectedNow?.('pty-after-round')).toBe(true)
  })

  // [S10-21a C7m, Ruling 34 Addendum 30, item 3] `seq` means "recorded as live at" — a RETAINED
  // record (not freshly created) that transitions connected false->true must be re-sequenced, or
  // the round/connectedNow union can never see it as "recorded after the round" once it reconnects.
  it('a retained record reused (reconnected) after the round reads ptyConnectedNow true (fails at base)', async () => {
    const runtime = new OrcaRuntimeService()
    const recordPtyWorktree = (
      runtime as unknown as {
        recordPtyWorktree: (
          ptyId: string,
          worktreeId: string,
          state: { connected?: boolean; incarnationId?: string }
        ) => { seq: number; connected: boolean }
      }
    ).recordPtyWorktree.bind(runtime)
    // Create the record, then disconnect it — it now EXISTS (retained), not freshly created.
    recordPtyWorktree('pty-retained', 'wt-1', { connected: true })
    recordPtyWorktree('pty-retained', 'wt-1', { connected: false })
    // The round is taken while the record is retained but disconnected.
    const roundSeq = (runtime as unknown as { ptyRecordSeqCounter: number }).ptyRecordSeqCounter
    const inventory: ControllerInventory = {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map(),
      roundSeq
    }
    // The SAME retained record reconnects after the round.
    recordPtyWorktree('pty-retained', 'wt-1', { connected: true })

    const evidence = await runtime.collectIncumbentEvidence(
      'tab1:leaf-retained',
      'pty-retained',
      undefined,
      inventory
    )
    expect(evidence.ptyState?.('pty-retained')).toBe('absent')
    expect(evidence.ptyConnectedNow?.('pty-retained')).toBe(true)
  })
})
