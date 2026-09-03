// S10-19 W-2 (INV-P-013, chair rulings 20/22/24 + Ruling 24 addendum 2): T-4, T-4b, T-4c, T-4d,
// T-M1, NEG-19, NEG-19b, NEG-19c, W2-T1.
// Review B1/B3 (2026-09-02): closePeerOwnedPaneOnAgentExit now takes the terminal HANDLE (never
// a ptyId — that resolution is orca-runtime.ts's job, covered by its own integration test); the
// boot sweep and the runtime prune key liveness off the persisted process_incarnation column
// (inspectTerminalProcessIncarnationLiveness / resolveLivePeerPaneHandle), never a stale handle.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import {
  accessProfileOfAttachment,
  closePeerOwnedPaneOnAgentExit,
  peerOwnedPaneDisposition,
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
    processIncarnation: string | null
    agentExitedAt: string | null
  }> = {}
): string {
  const dispatchId = overrides.dispatchId ?? `disp_${Math.random().toString(36).slice(2)}`
  rawDb(db)
    .prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, process_incarnation, agent_exited_at)
       VALUES (?, 'task_x', ?, ?, ?, 'stage', ?, ?, ?)`
    )
    .run(
      dispatchId,
      overrides.homeFingerprint ?? 'fp_peer1',
      overrides.runtimeEpoch ?? 'epoch-current',
      overrides.state ?? 'ready',
      overrides.terminalHandle === undefined ? 'term_x' : overrides.terminalHandle,
      overrides.processIncarnation === undefined ? 'pty_x:inc_x' : overrides.processIncarnation,
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

describe('S10-19 W-2 review D1: peerOwnedPaneDisposition', () => {
  it('full stays full, positive peer stays peer, everything else (absent lookup or no matching device) is unresolved', () => {
    expect(peerOwnedPaneDisposition({ home_peer_fingerprint: 'fp' }, () => 'full')).toBe('full')
    expect(peerOwnedPaneDisposition({ home_peer_fingerprint: 'fp' }, () => 'peer')).toBe('peer')
    expect(peerOwnedPaneDisposition({ home_peer_fingerprint: 'fp' }, () => null)).toBe('unresolved')
    expect(peerOwnedPaneDisposition({ home_peer_fingerprint: 'fp' }, null)).toBe('unresolved')
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
        handle: 'term_peer',
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
      handle: 'term_peer',
      cause: 'command_finished'
    })
    const first = db.getRemoteDispatchAttachment(dispatchId)?.agent_exited_at
    await closePeerOwnedPaneOnAgentExit({
      db,
      runtime: runtime(),
      lookup: () => 'peer',
      handle: 'term_peer',
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
      handle: 'term_peer',
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
      handle: 'term_peer',
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
      handle: 'term_full',
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
      handle: 'term_peer',
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
        handle: 'term_unknown',
        cause: 'pty_exit'
      })
    ).resolves.toBeUndefined()
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})

describe('S10-19 W-2: runPeerAttachmentBootSweep (Ruling 24 addendum 2(o); review B3; attacker 2/3, ops BL-1/MO-2)', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('NEG-19: stamps a stale-epoch row whose PTY is provably gone (daemon table classifies it dead), for BOTH profiles equally — the sweep is profile-blind', async () => {
    db = new OrchestrationDb(':memory:')
    const peerRow = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_gone_peer',
      processIncarnation: 'pty_gone_peer:inc_1'
    })
    const fullRow = insertAttachment(db, {
      homeFingerprint: 'fp_full',
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_gone_full',
      processIncarnation: 'pty_gone_full:inc_1'
    })
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: async () => 'dead',
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(peerRow)?.agent_exited_at).not.toBeNull()
    expect(db.getRemoteDispatchAttachment(fullRow)?.agent_exited_at).not.toBeNull()
  })

  it('NEG-19c / (o): a row the daemon table classifies live is LEFT ALONE — no stamp, no close attempted (there is nothing to close here by construction: this function never calls closeTerminal)', async () => {
    db = new OrchestrationDb(':memory:')
    const liveRow = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_still_live',
      processIncarnation: 'pty_still_live:inc_1'
    })
    const inspect = vi.fn(
      async (processIncarnation: string) =>
        (processIncarnation === 'pty_still_live:inc_1' ? 'live' : 'dead') as 'live' | 'dead'
    )
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: inspect,
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(liveRow)?.agent_exited_at).toBeNull()
  })

  it('review B3: a row whose liveness the daemon table cannot determine (unknown) is left alone too — never stamped without proof', async () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_unknown_liveness',
      processIncarnation: 'pty_unknown:inc_1'
    })
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: async () => 'unknown',
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).toBeNull()
  })

  it('review B3: a row with a handle but no persisted process_incarnation cannot be proven gone and is left alone', async () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_no_incarnation',
      processIncarnation: null
    })
    const inspect = vi.fn().mockResolvedValue('dead')
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: inspect,
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(inspect).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).toBeNull()
  })

  it('NEG-19c (Ruling 24 addendum 2(q)): with setPeerGrantProfileLookup NEVER installed, the boot sweep still stamps every provably-gone stale-epoch row — it never reads a lookup at all', async () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: null,
      processIncarnation: null
    })
    // runPeerAttachmentBootSweepImpl's signature carries no lookup parameter whatsoever — this
    // test's own type-checking is the structural proof; the assertion below is the behavioral one.
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: async () => 'dead',
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).not.toBeNull()
  })

  it('a row with no terminal_handle at all is provably gone and is stamped, without consulting the daemon table', async () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: null,
      processIncarnation: null
    })
    const inspect = vi.fn().mockResolvedValue('live')
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: inspect,
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(inspect).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).not.toBeNull()
  })

  it('a row already stamped (agent_exited_at set) is not a stale-epoch candidate at all', async () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-old',
      terminalHandle: 'term_x',
      agentExitedAt: '2020-01-01 00:00:00'
    })
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: async () => 'dead',
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).toBe('2020-01-01 00:00:00')
  })

  it('a row whose epoch matches the current one is not stale and is left untouched', async () => {
    db = new OrchestrationDb(':memory:')
    const row = insertAttachment(db, {
      runtimeEpoch: 'epoch-current',
      terminalHandle: 'term_gone'
    })
    await runPeerAttachmentBootSweep({
      db,
      runtime: {
        inspectTerminalProcessIncarnationLiveness: async () => 'dead',
        getRuntimeId: () => 'epoch-current'
      }
    })
    expect(db.getRemoteDispatchAttachment(row)?.agent_exited_at).toBeNull()
  })
})

describe('S10-19 W2-T1 (Ruling 24 addendum 2(p)/(q); review B3): runPeerAttachmentRuntimePrune', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('a daemon-backed peer row whose process_incarnation still resolves to a live handle, and whose agent has exited, is closed, THEN stamped, THEN deleted, in that order', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      terminalHandle: 'term_daemon_peer_stale',
      processIncarnation: 'pty_daemon:inc_1',
      state: 'ready'
    })
    const order: string[] = []
    const closeTerminal = vi.fn().mockImplementation(async () => {
      order.push('close')
    })
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => 'term_daemon_peer_reconnected',
      inspectTerminalProcessIncarnationLiveness: async () => 'live',
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
    // Why the RECONNECTED handle, not the row's stale one: a term_<uuid> handle is re-minted
    // every process start (review B3) — closeTerminal must target whatever names the pty NOW.
    expect(closeTerminal).toHaveBeenCalledWith('term_daemon_peer_reconnected')
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeUndefined()
  })

  it('F5 / review B3: a row whose process_incarnation does not (yet) resolve to a live handle in this process, and whose liveness cannot be proven, is LEFT ALONE — no stamp, no audit', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      terminalHandle: 'term_not_reconnected',
      processIncarnation: 'pty_not_reconnected:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => null,
      inspectTerminalProcessIncarnationLiveness: async () => 'unknown',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).not.toHaveBeenCalled()
    const row = db.getRemoteDispatchAttachment(dispatchId)
    expect(row).toBeDefined()
    // F5: positively pin the untouched state — not just "not closed" (which a stamp-and-audit
    // outcome would also satisfy).
    expect(row?.agent_exited_at).toBeNull()
    expect(row?.state).toBe('ready')
    const audit = rawDb(db).prepare(`SELECT * FROM agent_audit WHERE verb = 'peerPaneClose'`).all()
    expect(audit).toHaveLength(0)
  })

  // Review D1 (2026-09-02) REPLACES the prior "finding 2 / 24(bb): a row whose grant is
  // REVOKED ... is treated as peer-owned — closed, stamped, then deleted" test above, which
  // pinned the destructive-regression inversion: "unresolved" (grant rotated/revoked/expired,
  // or registry load failure) is not a synonym for "was a peer" — it is equally what a FULL
  // grant looks like after rotation. Only a POSITIVE 'peer' resolution may ever close/delete.
  // (a) a full-profile pane whose grant was rotated away is NOT closed and gets the
  // owner_unresolved audit.
  it('D1 (a): a FULL-profile pane whose grant was rotated away (lookup now resolves null) is NOT closed, NOT deleted, and gets the owner_unresolved audit', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_full_rotated',
      terminalHandle: 'term_full_rotated',
      processIncarnation: 'pty_full_rotated:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => 'term_full_rotated_reconnected',
      inspectTerminalProcessIncarnationLiveness: async () => 'live',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    // Rotated/revoked/expired: the registry no longer has a matching device, so the lookup
    // resolves null — indistinguishable, by construction, from a rotated PEER grant.
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => null })
    expect(closeTerminal).not.toHaveBeenCalled()
    const row = db.getRemoteDispatchAttachment(dispatchId)
    expect(row).toBeDefined()
    expect(row?.agent_exited_at).not.toBeNull()
    const audit = rawDb(db)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all() as { outcome: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]?.outcome).toBe('owner_unresolved')
    void dispatchId
  })

  // (b) a positively-peer row is closed/stamped/deleted (unchanged behavior — kept from before,
  // restated against a POSITIVE resolution rather than a null one).
  it('D1 (b): a row that POSITIVELY resolves to peer is closed, stamped, then deleted', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer_positive',
      terminalHandle: 'term_peer_positive',
      processIncarnation: 'pty_peer_positive:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => 'term_peer_positive_reconnected',
      inspectTerminalProcessIncarnationLiveness: async () => 'live',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).toHaveBeenCalledWith('term_peer_positive_reconnected')
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeUndefined()
  })

  // (c) the exit hook and the prune produce identical outcomes for the same unresolved row —
  // proof the two paths share one helper (markOwnerUnresolved) and cannot diverge again.
  it('D1 (c): the exit hook and the runtime prune produce identical outcomes for the same unresolved row', async () => {
    const exitDb = new OrchestrationDb(':memory:')
    const exitDispatchId = insertAttachment(exitDb, {
      homeFingerprint: 'fp_unresolved',
      terminalHandle: 'term_unresolved',
      processIncarnation: 'pty_unresolved:inc_1',
      state: 'ready'
    })
    await closePeerOwnedPaneOnAgentExit({
      db: exitDb,
      runtime: { closeTerminal: vi.fn().mockResolvedValue({}) },
      lookup: () => null,
      handle: 'term_unresolved',
      cause: 'command_finished'
    })
    const exitRow = exitDb.getRemoteDispatchAttachment(exitDispatchId)
    const exitAudit = rawDb(exitDb)
      .prepare(`SELECT verb, outcome, reason_code FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all()
    exitDb.close()

    db = new OrchestrationDb(':memory:')
    const pruneDispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_unresolved',
      terminalHandle: 'term_unresolved_prune',
      processIncarnation: 'pty_unresolved_prune:inc_1',
      state: 'ready'
    })
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => 'term_unresolved_prune_reconnected',
      inspectTerminalProcessIncarnationLiveness: async () => 'live',
      closeTerminal: vi.fn().mockResolvedValue({}),
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => null })
    const pruneRow = db.getRemoteDispatchAttachment(pruneDispatchId)
    const pruneAudit = rawDb(db)
      .prepare(`SELECT verb, outcome, reason_code FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all()

    expect(pruneRow?.agent_exited_at).not.toBeNull()
    expect(exitRow?.agent_exited_at).not.toBeNull()
    expect(pruneRow?.state).toBe(exitRow?.state)
    expect(pruneRow?.stage).toBe(exitRow?.stage)
    expect(pruneAudit).toEqual(exitAudit)
  })

  // Ruling 31 Addendum 1 (d')/(f), restoring Ruling 24 Add.4(bb): a resolution failure
  // (resolveLivePeerPaneHandle === null) is NOT proof of death — it is also what "the pty graph
  // has not re-adopted the pty yet" looks like on the first pass after a restart. H1's "stamp on
  // any unresolvable" was a REGRESSION (F1/F4 of the H1 review) that permanently orphaned a live
  // peer pane. The row must be left untouched (no stamp, no audit) while liveness is 'unknown',
  // and RE-RUN on the next pass — once the handle resolves, it is closed normally.
  it("Ruling 31 Add.1(d') / Ruling 24 Add.4(bb): a row unresolvable on the first pass (liveness 'unknown') is left untouched, and closed on a later pass once the handle resolves", async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      terminalHandle: 'term_later',
      processIncarnation: 'pty_later:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    let resolved = false
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => (resolved ? 'term_later_reconnected' : null),
      inspectTerminalProcessIncarnationLiveness: async () => 'unknown',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).not.toHaveBeenCalled()
    const untouchedRow = db.getRemoteDispatchAttachment(dispatchId)
    expect(untouchedRow).toBeDefined()
    expect(untouchedRow?.agent_exited_at).toBeNull()
    expect(untouchedRow?.state).toBe('ready')
    const auditAfterFirstPass = rawDb(db)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all()
    expect(auditAfterFirstPass).toHaveLength(0)

    // Second pass: the pty graph has now re-adopted the handle — the row is retried, not
    // abandoned, and closes normally.
    resolved = true
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).toHaveBeenCalledWith('term_later_reconnected')
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeUndefined()
  })

  // F1/F4 sibling: the ONLY way an unresolvable incarnation may be stamped is POSITIVE proof of
  // death from the same oracle + profile-blind rule the boot sweep already uses.
  it("Ruling 31 Add.1(d'): a row unresolvable on this pass, whose incarnation the daemon table proves DEAD, is stamped with cause incarnation_dead and audited — profile-blind, never closed", async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_peer',
      terminalHandle: 'term_dead',
      processIncarnation: 'pty_dead:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => null,
      inspectTerminalProcessIncarnationLiveness: async () => 'dead',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).not.toHaveBeenCalled()
    const stampedRow = db.getRemoteDispatchAttachment(dispatchId)
    expect(stampedRow).toBeDefined()
    expect(stampedRow?.agent_exited_at).not.toBeNull()
    const audit = rawDb(db)
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'peerPaneClose'`)
      .all() as { outcome: string; reason_code: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]?.outcome).toBe('owner_unresolved')
    expect(audit[0]?.reason_code).toBe('incarnation_dead')
  })

  it('a full-profile row whose agent has exited is never inspected for closing or deletion', async () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = insertAttachment(db, {
      homeFingerprint: 'fp_full',
      terminalHandle: 'term_full',
      processIncarnation: 'pty_full:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => 'term_full_reconnected',
      inspectTerminalProcessIncarnationLiveness: async () => 'live',
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
      processIncarnation: 'pty_peer_live:inc_1',
      state: 'ready'
    })
    const closeTerminal = vi.fn().mockResolvedValue({})
    const runtime: PeerOwnedPaneRuntime = {
      resolveLivePeerPaneHandle: () => 'term_peer_live_reconnected',
      inspectTerminalProcessIncarnationLiveness: async () => 'live',
      closeTerminal,
      isTerminalRunningAgent: vi.fn().mockResolvedValue(true),
      getRuntimeId: () => 'epoch-current'
    }
    await runPeerAttachmentRuntimePrune({ db, runtime, lookup: () => 'peer' })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(dispatchId)).toBeDefined()
  })
})
