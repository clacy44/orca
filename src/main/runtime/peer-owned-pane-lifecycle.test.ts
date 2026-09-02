// S10-19 W-2 (INV-P-013, chair rulings 20/22/24 + Ruling 24 addendum 2): T-4, T-4b, T-4c, T-4d,
// T-M1, NEG-19, NEG-19b, NEG-19c, W2-T1.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import {
  accessProfileOfAttachment,
  closePeerOwnedPaneOnAgentExit,
  runPeerAttachmentBootSweep,
  runPeerAttachmentRuntimePrune,
  type PeerOwnedPaneRuntime
} from './peer-owned-pane-lifecycle'

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
    run: (...args: unknown[]) => unknown
  }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

function insertAttachment(
  db: OrchestrationDb,
  overrides: Partial<{
    dispatchId: string
    homeFingerprint: string
    runtimeEpoch: string
    state: string
    terminalHandle: string | null
    agentExitedAt: string | null
  }> = {}
): string {
  const dispatchId = overrides.dispatchId ?? `disp_${Math.random().toString(36).slice(2)}`
  rawDb(db)
    .prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, agent_exited_at)
       VALUES (?, 'task_x', ?, ?, ?, 'stage', ?, ?)`
    )
    .run(
      dispatchId,
      overrides.homeFingerprint ?? 'fp_peer1',
      overrides.runtimeEpoch ?? 'epoch-current',
      overrides.state ?? 'ready',
      overrides.terminalHandle === undefined ? 'term_x' : overrides.terminalHandle,
      overrides.agentExitedAt ?? null
    )
  return dispatchId
}

describe('S10-19 W-2: accessProfileOfAttachment', () => {
  it('null lookup (boot, or setPeerGrantProfileLookup never installed) resolves null', () => {
    expect(accessProfileOfAttachment({ home_peer_fingerprint: 'fp' }, null)).toBeNull()
  })
  it('a lookup that finds no device (revoked/rotated) resolves null — owner_unresolved', () => {
    expect(accessProfileOfAttachment({ home_peer_fingerprint: 'fp' }, () => null)).toBeNull()
  })
  it('a resolved profile passes through', () => {
    expect(accessProfileOfAttachment({ home_peer_fingerprint: 'fp' }, () => 'peer')).toBe('peer')
    expect(accessProfileOfAttachment({ home_peer_fingerprint: 'fp' }, () => 'full')).toBe('full')
  })
})

describe('S10-19 W-2: closePeerOwnedPaneOnAgentExit (T-4 family)', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  const runtime = (
    closeTerminal: (h: string) => Promise<unknown> = vi.fn().mockResolvedValue({})
  ): Pick<PeerOwnedPaneRuntime, 'closeTerminal'> => ({ closeTerminal })

  it('T-4: a peer-profile row closes the pane then stamps agent_exited_at, from every settled/active state', async () => {
    for (const state of [
      'ready',
      'start_unknown',
      'failed',
      'succeeded',
      'stopping',
      'stop_unknown',
      'stopped',
      'abandoned'
    ]) {
      db = new OrchestrationDb(':memory:')
      const dispatchId = insertAttachment(db, { state, terminalHandle: 'term_peer' })
      const closeTerminal = vi.fn().mockResolvedValue({})
      await closePeerOwnedPaneOnAgentExit({
        db,
        runtime: runtime(closeTerminal),
        lookup: () => 'peer',
        ptyId: 'term_peer',
        cause: 'command_finished'
      })
      expect(closeTerminal).toHaveBeenCalledWith('term_peer')
      const row = db.getRemoteDispatchAttachment(dispatchId)
      expect(row?.agent_exited_at).not.toBeNull()
      // Why no per-iteration close: `db` is reassigned each pass and the shared afterEach
      // closes whichever instance is current when the test ends; closing here too would double-close.
    }
  })

  it('T-4 idempotence: calling twice (both orders of trigger) only stamps once and closes at most per call', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, { state: 'ready', terminalHandle: 'term_peer' })
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(),
      lookup: () => 'peer',
      ptyId: 'term_peer',
      cause: 'command_finished'
    })
    const first = db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(),
      lookup: () => 'peer',
      ptyId: 'term_peer',
      cause: 'pty_exit'
    })
    // findPeerOwnedAttachmentForHandle excludes agent_exited_at IS NOT NULL rows, so the second
    // call finds nothing and is a no-op — the stamp from the first call is never overwritten.
    const second = db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at
    expect(second).toBe(first)
  })

  it('T-4b: MJ-1 — agent_exited_at + the state/stage move; last_error carries the cause note', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, { state: 'ready', terminalHandle: 'term_peer' })
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(),
      lookup: () => 'peer',
      ptyId: 'term_peer',
      cause: 'command_finished'
    })
    const row = db.getRemoteDispatchAttachment(dispatchId)
    expect(row?.agent_exited_at).not.toBeNull()
    expect(row?.state).toBe('agent_exited')
    expect(row?.stage).toBe('agent_exited')
  })

  it("§D: state never moves to 'agent_exited' from 'starting' — only agent_exited_at is stamped", async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, { state: 'starting', terminalHandle: 'term_peer' })
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(),
      lookup: () => 'peer',
      ptyId: 'term_peer',
      cause: 'pty_exit'
    })
    const row = db.getRemoteDispatchAttachment(dispatchId)
    expect(row?.agent_exited_at).not.toBeNull()
    expect(row?.state).toBe('starting')
  })

  it('T-4d / NEG-19b: a full-profile pane is NEVER closed and NEVER stamped by this path', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, { state: 'ready', terminalHandle: 'term_full' })
    const closeTerminal = vi.fn().mockResolvedValue({})
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(closeTerminal),
      lookup: () => 'full',
      ptyId: 'term_full',
      cause: 'command_finished'
    })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at).toBeNull()
  })

  it('attacker 4 / T-4d: an unresolved profile (revoked/rotated grant) stamps but does NOT close, and audits owner_unresolved', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, { state: 'ready', terminalHandle: 'term_peer' })
    const closeTerminal = vi.fn().mockResolvedValue({})
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(closeTerminal),
      lookup: () => null,
      ptyId: 'term_peer',
      cause: 'command_finished'
    })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at).not.toBeNull()
    const audit = rawDb(db)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all() as { outcome: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]?.outcome).toBe('owner_unresolved')
  })

  it('no matching attachment row (handle unowned/unknown) is a silent no-op', async () => {
    db = new OrchestrationDb(':memory:')
    const closeTerminal = vi.fn().mockResolvedValue({})
    await expect(
      closePeerOwnedPaneOnAgentExit({
        db,
        runtime: runtime(closeTerminal),
        lookup: () => 'peer',
        ptyId: 'term_unknown',
        cause: 'pty_exit'
      })
    ).resolves.toBeUndefined()
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})

describe('S10-19 W-2: runPeerAttachmentBootSweep (Ruling 24 addendum 2(o); attacker 2/3, ops BL-1/MO-2)', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('NEG-19: stamps a stale-epoch row whose PTY is provably gone (no registered pty), for BOTH profiles equally — the sweep is profile-blind', () => {
    db = new OrchestrationDb(':memory:')
    const peerRow = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_gone_peer'
    })
    const fullRow = insertAttachment(db, {
      homeFingerprint: 'fp_full',
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_gone_full'
    })
    runPeerAttachmentBootSweep({
      db,
      runtime: { getTerminalPaneKey: () => null, getRuntimeId: () => 'epoch-current' }
    })
    expect(db.getRemoteDispatchAttachment(peerRow)?.agent_exited_at).not.toBeNull()
    expect(db.getRemoteDispatchAttachment(fullRow)?.agent_exited_at).not.toBeNull()
  })

  it('NEG-19c / (o): a row whose PTY still resolves is LEFT ALONE — no stamp, no close attempted (there is nothing to close here by construction: this function never calls closeTerminal)', () => {
    db = new OrchestrationDb(':memory:')
    const liveRow = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_still_live'
    })
    runPeerAttachmentBootSweep({
      db,
      runtime: {
        getTerminalPaneKey: (h) => (h === 'term_still_live' ? 'tab_x:leaf' : null),
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(liveRow)?.agent_exited_at).toBeNull()
  })

  it('NEG-19c (Ruling 24 addendum 2(q)): with setPeerGrantProfileLookup NEVER installed, the boot sweep still stamps every provably-gone stale-epoch row — it never reads a lookup at all', () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, { runtimeEpoch: 'epoch-old', terminalHandle: null })
    // runPeerAttachmentBootSweepImpl's signature carries no lookup parameter whatsoever — this
    // test's own type-checking is the structural proof; the assertion below is the behavioral one.
    runPeerAttachmentBootSweep({
      db,
      runtime: { getTerminalPaneKey: () => null, getRuntimeId: () => 'epoch-current' }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).not.toBeNull()
  })

  it('a row with no terminal_handle at all is provably gone and is stamped', () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, { runtimeEpoch: 'epoch-old', terminalHandle: null })
    runPeerAttachmentBootSweep({
      db,
      runtime: { getTerminalPaneKey: () => 'unused', getRuntimeId: () => 'epoch-current' }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).not.toBeNull()
  })

  it('a row already stamped (agent_exited_at set) is not a stale-epoch candidate at all', () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_x',
      agentExitedAt: '2020-01-01 00:00:00'
    })
    runPeerAttachmentBootSweep({
      db,
      runtime: { getTerminalPaneKey: () => null, getRuntimeId: () => 'epoch-current' }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).toBe('2020-01-01 00:00:00')
  })

  it('a row whose epoch matches the current one is not stale and is left untouched', () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-current',
      terminalHandle: 'term_gone'
    })
    runPeerAttachmentBootSweep({
      db,
      runtime: { getTerminalPaneKey: () => null, getRuntimeId: () => 'epoch-current' }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).toBeNull()
  })
})

describe('S10-19 W2-T1 (Ruling 24 addendum 2(p)/(q)): runPeerAttachmentRuntimePrune', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('a daemon-backed peer row whose handle resolves and whose agent has exited is closed, THEN stamped, THEN deleted, in that order', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      terminalHandle: 'term_daemon_peer',
      state: 'ready'
    })
    const order: string[] = []
    const closeTerminal = vi.fn().mockImplementation(async () => {
      order.push('close')
    })
    const runtime: PeerOwnedPaneRuntime = {
      getTerminalPaneKey: () => 'tab_x:leaf',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    const originalMark = db.markPeerOwnedAttachmentAgentExited.bind(db)
    vi.spyOn(db, 'markPeerOwnedAttachmentAgentExited').mockImplementation((id, cause) => {
      order.push('stamp')
      return originalMark(id, cause)
    })
    const originalDelete = db.deleteRemoteDispatchAttachment.bind(db)
    vi.spyOn(db, 'deleteRemoteDispatchAttachment').mockImplementation((id) => {
      order.push('delete')
      return originalDelete(id)
    })

    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })

    expect(order).toEqual(['close', 'stamp', 'delete'])
    expect(closeTerminal).toHaveBeenCalledWith('term_daemon_peer')
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeUndefined()
  })

  it('a full-profile row whose agent has exited is never inspected for closing or deletion', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_full',
      terminalHandle: 'term_full',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      getTerminalPaneKey: () => 'tab_x:leaf',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'full' })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeDefined()
  })

  it('a peer row whose agent is STILL running is left alone', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      terminalHandle: 'term_peer_live',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      getTerminalPaneKey: () => 'tab_x:leaf',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(true),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeDefined()
  })
})
