// S10-21a C7b (design v3.2 §2.1; D-R110; Ruling 34 Addendum 22): the main-process restore sweep.
// The decision-table (rows 1-11, Ruling 34 Addendum 27, C7i) tests live in
// restore-registered-agent-panes-decision-table.test.ts — split out to stay under the max-lines
// ratchet. This file keeps the pre-existing, non-decision-table sweep-mechanics tests.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { captureSelfResumeWatermarkAtStartup } from './self-resume-watermark-capture'
import {
  runRestoreSweep,
  runRestoreSweepBody,
  restoreOneRegisteredPane
} from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps,
  defaultCollectIncumbentEvidence
} from './restore-sweep-test-fixtures'

describe('S10-21a C7b/C7i: runRestoreSweep', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('T1: Layer 1 preserve — same leaf, prior-generation row, mark written, no rebind audit row', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000001'
    insertAgent(db, { id: 'agent-1', display_name: 'chair-1', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-1',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-1',
        paneKey: predPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const summary = await runRestoreSweep(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        // [S10-21a C7k, Ruling 34 Addendum 28, item 5 — SCENARIO_CORRECTION, forced deviation]
        // A REAL 2-segment identity: item 5's companion-refresh guard now refuses to write an
        // empty/legacy one, so the default fixture's `() => null` no longer produces the
        // 'reminted' row this assertion (below) needs — the same fixture change T3b already
        // required for the same reason.
        getTerminalProcessIncarnation: () => 'pty-t1:inc-t1'
      })
    )
    expect(summary.layer1).toBe(1)
    expect(summary.layer2).toBe(0)
    expect(summary.layer3).toBe(0)
    // [D-R110 B1 fence] the mint call must carry the CURRENT generation, never the row's prior one.
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'explicit',
        providerSession: { key: 'session_id', id: 'sess-1' },
        placement: { tabId: 'tab1', leafId: '00000000-0000-4000-8000-000000000001' }
      }),
      {},
      expect.objectContaining({
        restoreProvenance: expect.objectContaining({ kind: 'host-restore' })
      })
    )
    expect(orchestrationDb!.getSweepRestoreMark(HOST_ID, predPaneKey)).toBe(true)
    const rebindRows = db
      .prepare(`SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'`)
      .all() as unknown[]
    // SCENARIO_CORRECTION (C7i, Ruling 34 Addendum 27, scope item 4 — "A same-pane restore
    // refreshes the agents row's process identity"): was `expect(rebindRows).toHaveLength(0)`
    // with the comment "Layer 1 (clause-3 noop) returns before rebindRestoredPane's transaction
    // ever opens — no 'reminted' audit row for the pane-preserved case." That was true only
    // because process_incarnation was never refreshed on the Layer-1 path before this commit —
    // exactly the gap the companion fix closes. `refreshAgentHandleAfterRespawn` now writes its
    // own 'reminted' row on this same noop path.
    expect(rebindRows).toHaveLength(1)
  })

  it("T21: a leaf occupied by something OTHER than the pane's own live session gets a FRESH pane, no placement, Layer 2 (row 9)", async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000002'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f00d'
    insertAgent(db, { id: 'agent-2', display_name: 'chair-2', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-2',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-2',
        paneKey: freshPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        // [design §2.1b, D-R110 (δ)] someone else's live pty sits on this leaf — a DIFFERENT
        // paneKey than the row's own.
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-2',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    // No placement offered — the request must carry NO placement field.
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ placement: undefined }),
      {},
      expect.anything()
    )
    // [C7i FORCED DEVIATION, see RETURN] kept byte-identical to the pre-C7i reason code.
    const skipAudit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_skip' AND reason_code = 'leaf_occupied_by_other'`
      )
      .all()
    expect(skipAudit).toHaveLength(1)
  })

  it('C10, drill criterion 8 (§6.4): a pact paused counterpart_gone resumes after its counterpart is rebound (Layer 2)', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000010'
    const freshPaneKey = 'tab2:00000000-0000-4000-8000-00000000f0f0'
    const peerPaneKey = 'tab3:00000000-0000-4000-8000-000000000011'
    insertAgent(db, { id: 'agent-10', display_name: 'chair-10', pane_key: predPaneKey })
    insertAgent(db, { id: 'agent-11', display_name: 'chair-11', pane_key: peerPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-10',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const { thread } = orchestrationDb!.createThread({
      subject: 's',
      createdByAgentId: 'agent-10',
      participants: [
        { participantKey: 'agent-10', agentId: 'agent-10' },
        { participantKey: 'agent-11', agentId: 'agent-11' }
      ]
    })
    orchestrationDb!.proposePact({
      callerAgentId: 'agent-10',
      callerPaneKey: predPaneKey,
      callerHostId: HOST_ID,
      threadId: thread.id,
      peerAgentId: 'agent-11',
      stepsTotal: null
    })
    orchestrationDb!.acceptPact({
      callerAgentId: 'agent-11',
      callerPaneKey: peerPaneKey,
      callerHostId: HOST_ID,
      threadId: thread.id
    })
    // The liveness auto-pause that fires when agent-10 goes live -> gone, BEFORE the restart's
    // rebind lands (§2.11's own opening sentence).
    orchestrationDb!.autoPausePactsForAgent('agent-10', 'counterpart_gone')
    expect(orchestrationDb!.getThread(thread.id)?.pact_paused_at).not.toBeNull()

    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-10',
        paneKey: freshPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        // Forces Layer 2 (a fresh pane), the same shape T21 uses.
        findConnectedLeafOccupant: () => ({ paneKey: 'tab9:other-leaf', ptyId: 'pty-other' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-10',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer2')
    expect(orchestrationDb!.getThread(thread.id)?.pact_state).toBe('engaged')
    expect(orchestrationDb!.getThread(thread.id)?.pact_paused_at).toBeNull()
    const resumeAudit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'pact_resumed_after_rebind' AND outcome = 'resumed'`
      )
      .all()
    expect(resumeAudit).toHaveLength(1)
  })

  it('[S10-21a C7l item 8, C10 gap] a pact paused counterpart_gone resumes after a LAYER-1 (same-pane) restore of its counterpart', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-000000000012'
    const peerPaneKey = 'tab3:00000000-0000-4000-8000-000000000013'
    insertAgent(db, { id: 'agent-12', display_name: 'chair-12', pane_key: predPaneKey })
    insertAgent(db, { id: 'agent-13', display_name: 'chair-13', pane_key: peerPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'sess-12',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const { thread } = orchestrationDb!.createThread({
      subject: 's',
      createdByAgentId: 'agent-12',
      participants: [
        { participantKey: 'agent-12', agentId: 'agent-12' },
        { participantKey: 'agent-13', agentId: 'agent-13' }
      ]
    })
    orchestrationDb!.proposePact({
      callerAgentId: 'agent-12',
      callerPaneKey: predPaneKey,
      callerHostId: HOST_ID,
      threadId: thread.id,
      peerAgentId: 'agent-13',
      stepsTotal: null
    })
    orchestrationDb!.acceptPact({
      callerAgentId: 'agent-13',
      callerPaneKey: peerPaneKey,
      callerHostId: HOST_ID,
      threadId: thread.id
    })
    orchestrationDb!.autoPausePactsForAgent('agent-12', 'counterpart_gone')
    expect(orchestrationDb!.getThread(thread.id)?.pact_paused_at).not.toBeNull()

    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-12',
        // SAME pane key as the predecessor — the noop (Layer-1) path.
        paneKey: predPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    // FAILS AT BASE: the noop path's own refresh discards pactsToUnpause entirely, so this
    // pact never resumes on a Layer-1 restore.
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty-12:inc-12'
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-12',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(orchestrationDb!.getThread(thread.id)?.pact_state).toBe('engaged')
    expect(orchestrationDb!.getThread(thread.id)?.pact_paused_at).toBeNull()
    const resumeAudit = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'pact_resumed_after_rebind' AND outcome = 'resumed'`
      )
      .all()
    expect(resumeAudit).toHaveLength(1)
  })

  it('Addendum 22(v): a pane whose newest admission audit (any generation) is UNRECORDED and newer than the row is Layer 3, never resumed', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000004'
    insertAgent(db, { id: 'agent-4', display_name: 'chair-4', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-4-old',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    // A later, unrecorded admission attempt for the SAME pane, newer than the row.
    db.prepare(
      `INSERT INTO agent_audit (agent_id, actor_pane_key, actor_host_id, verb, outcome, reason_code, at)
         VALUES (NULL, ?, ?, 'launch_unrecorded', 'unrecorded', 'pane_key_owned', datetime('now', '+1 second'))`
    ).run(paneKey, HOST_ID)
    const ensureAgentSession = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession }),
      orchestrationDb!,
      HOST_ID,
      'agent-4',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer3')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_layer3' AND reason_code LIKE 'unrecorded_launch:%'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('Layer 3: a registered pane with no launch row is deferred, audited sweep_no_launch_row, never throws', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000005'
    insertAgent(db, { id: 'agent-5', display_name: 'chair-5', pane_key: paneKey })
    const summary = await runRestoreSweep(baseDeps(orchestrationDb!))
    expect(summary.layer3).toBe(1)
    const rows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE agent_id = 'agent-5' AND verb = 'sweep_layer3'
           AND reason_code = 'sweep_no_launch_row'`
      )
      .all()
    expect(rows).toHaveLength(1)
  })

  it('T25: cold-opened store resumes using the persisted session id from the row', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000006'
    insertAgent(db, { id: 'agent-6', display_name: 'chair-6', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'persisted-session-id',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const readBack = orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)
    expect(readBack?.session_id).toBe('persisted-session-id')
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-6',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    await runRestoreSweep(baseDeps(orchestrationDb!, { ensureAgentSession }))
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSession: { key: 'session_id', id: 'persisted-session-id' }
      }),
      {},
      expect.anything()
    )
  })

  it('T3b: a second sweep pass in one generation is a no-op for an already-restored pane', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-000000000007'
    insertAgent(db, { id: 'agent-7', display_name: 'chair-7', pane_key: paneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-7',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-7',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const deps = baseDeps(orchestrationDb!, {
      ensureAgentSession,
      // [S10-21a C7k, Ruling 34 Addendum 28, item 9b Gate-1 restoration] A REAL 2-segment
      // identity — the companion refresh (item 5) now refuses to write an empty/legacy one, so
      // the strict assertion below needs a value that actually parses.
      getTerminalProcessIncarnation: () => 'pty-t3b:inc-t3b'
    })
    const first = await runRestoreSweepBody(deps)
    expect(first.layer1).toBe(1)
    const second = await runRestoreSweepBody(deps)
    // Second pass: the row's pane key already equals what the sweep would place into, and the
    // rebind predicate's own clause 3 (or the daemon_survived path once a real pty exists) makes
    // a repeat a structural no-op — no duplicate rebind 'reminted' row is written.
    expect(second.layer3 + second.errors).toBe(0)
    // [S10-21a C7k, Ruling 34 Addendum 28, item 9b] Gate-1 restoration, back to strict — quoting
    // the C7i commit body's own record of the assertion this replaces:
    //   expect(rebindRows.length).toBeLessThanOrEqual(1)
    // (later loosened to `toBeLessThanOrEqual(2)`). Each pass is a Layer-1 (clause-3 noop)
    // restore of the SAME pane; the companion fix refreshes process_incarnation (its own
    // 'reminted' row, reason `daemon respawn handle refresh: ...`) on every such pass — EXACTLY
    // two for two passes, never a duplicate FULL rebind.
    expect(second.layer1).toBe(1)
    const refreshRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted'
           AND reason_code LIKE 'daemon respawn handle refresh%'`
      )
      .all()
    expect(refreshRows).toHaveLength(2)
  })

  // [S10-21a C7k, Ruling 34 Addendum 28, item 9a Gate-1 restoration] Re-adds, in its strict
  // per-case form, the assertion the C7i commit body recorded as REMOVED: "evidence is collected
  // about the agent's own pty" (`expect(collectIncumbentEvidence).toHaveBeenCalledWith(paneKey,
  // '<identity ptyId>', ...)` when the row has an identity, and with the persisted leaf pty when
  // it has none).
  it('Gate-1 restoration 9a: evidence is collected about the AGENT identity ptyId when the row has one', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000c001'
    insertAgent(db, {
      id: 'agent-evidence-identity',
      display_name: 'chair-evidence-identity',
      pane_key: paneKey,
      process_incarnation: 'pty-evidence:inc-OLD'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-evidence-identity',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-evidence-identity',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const collectIncumbentEvidence = vi.fn(
      (
        pk: string,
        ptyId: string | undefined,
        now?: number,
        preFetchedInventory?: unknown
      ): ReturnType<typeof defaultCollectIncumbentEvidence> =>
        defaultCollectIncumbentEvidence(
          pk,
          ptyId,
          now,
          preFetchedInventory as Parameters<typeof defaultCollectIncumbentEvidence>[3]
        )
    )
    // The daemon relists 'pty-evidence' under a DIFFERENT incarnation -> dead, per agentAlive.
    const inventory = emptyInventory({
      allLivePtyIds: new Set(['pty-evidence']),
      terminalIdentityByPtyId: new Map([
        ['pty-evidence', { handle: 'term_evidence', incarnationId: 'inc-NEW' }]
      ])
    })
    await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, collectIncumbentEvidence }),
      orchestrationDb!,
      HOST_ID,
      'agent-evidence-identity',
      'pty-evidence:inc-OLD',
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      inventory
    )
    expect(collectIncumbentEvidence).toHaveBeenCalledWith(
      paneKey,
      'pty-evidence',
      undefined,
      inventory
    )
  })

  it('Gate-1 restoration 9a: evidence is collected about the PERSISTED LEAF pty when the row has no identity', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000c002'
    insertAgent(db, {
      id: 'agent-evidence-noidentity',
      display_name: 'chair-evidence-noidentity',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-evidence-noidentity',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-evidence-noidentity',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const collectIncumbentEvidence = vi.fn(
      (
        pk: string,
        ptyId: string | undefined,
        now?: number,
        preFetchedInventory?: unknown
      ): ReturnType<typeof defaultCollectIncumbentEvidence> =>
        defaultCollectIncumbentEvidence(
          pk,
          ptyId,
          now,
          preFetchedInventory as Parameters<typeof defaultCollectIncumbentEvidence>[3]
        )
    )
    // An occupant is ALSO present, on a different ptyId, to prove the persisted-leaf ptyId wins
    // priority over the occupant's, exactly as the evidence-pty priority order states.
    await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        collectIncumbentEvidence,
        getPersistedPtyIdForLeaf: () => 'pty-persisted-leaf',
        findConnectedLeafOccupant: () => ({ paneKey, ptyId: 'pty-occupant-not-evidence' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-evidence-noidentity',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(collectIncumbentEvidence).toHaveBeenCalledWith(
      paneKey,
      'pty-persisted-leaf',
      undefined,
      emptyInventory()
    )
  })

  // [S10-21a C7k, Ruling 34 Addendum 28, item 7 -> S10-21a C7l, Ruling 34 Addendum 29 item 7,
  // SCENARIO_CORRECTION] Was keyed on the exact reason code (`'sweep_deferred:
  // agent_pty_identity_ambiguous pty-ambiguous': 1`); C7l item 7/N6 re-keys `deferredByReason`
  // on the reason FAMILY (the text before the first ':' or space) — per-pane detail stays in
  // `agent_audit`, never fragmenting one family into many near-unique milestone keys.
  it('deferredByReason: the sweep summary counts each Layer-3 deferral by its reason FAMILY', async () => {
    const db = rawDb()
    const paneKeyNoRow = 'tab1:00000000-0000-4000-8000-00000000c010'
    insertAgent(db, {
      id: 'agent-no-launch-row',
      display_name: 'chair-no-launch-row',
      pane_key: paneKeyNoRow
    })
    const paneKeyAmbiguous = 'tab1:00000000-0000-4000-8000-00000000c011'
    insertAgent(db, {
      id: 'agent-ambiguous',
      display_name: 'chair-ambiguous',
      pane_key: paneKeyAmbiguous,
      process_incarnation: 'pty-ambiguous:inc-1'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: paneKeyAmbiguous,
      agentType: 'claude',
      sessionId: 'sess-ambiguous',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        takeControllerInventoryForSweep: async () =>
          emptyInventory({ allLivePtyIds: new Set(['pty-ambiguous']) })
      })
    )
    expect(summary.layer3).toBe(2)
    expect(summary.deferredByReason).toEqual({
      sweep_no_launch_row: 1,
      sweep_deferred: 1
    })
  })

  it('[S10-21a C7l item 7, N6] two panes deferred for the SAME reason family count as one key with value 2', async () => {
    const db = rawDb()
    const paneKeyA = 'tab1:00000000-0000-4000-8000-00000000c012'
    insertAgent(db, {
      id: 'agent-ambiguous-a',
      display_name: 'chair-ambiguous-a',
      pane_key: paneKeyA,
      process_incarnation: 'pty-ambiguous-a:inc-1'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: paneKeyA,
      agentType: 'claude',
      sessionId: 'sess-ambiguous-a',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const paneKeyB = 'tab1:00000000-0000-4000-8000-00000000c013'
    insertAgent(db, {
      id: 'agent-ambiguous-b',
      display_name: 'chair-ambiguous-b',
      pane_key: paneKeyB,
      process_incarnation: 'pty-ambiguous-b:inc-1'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: paneKeyB,
      agentType: 'claude',
      sessionId: 'sess-ambiguous-b',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        takeControllerInventoryForSweep: async () =>
          emptyInventory({ allLivePtyIds: new Set(['pty-ambiguous-a', 'pty-ambiguous-b']) })
      })
    )
    expect(summary.layer3).toBe(2)
    expect(summary.deferredByReason).toEqual({ sweep_deferred: 2 })
  })

  // [S10-21a C7k, Ruling 34 Addendum 28, item 8]
  it('a throwing notifyRebindDelivery is audited (delivery_notify_failed), the restore is still counted layer1/layer2, never an error', async () => {
    const db = rawDb()
    const paneKey = 'tab1:00000000-0000-4000-8000-00000000c020'
    insertAgent(db, {
      id: 'agent-notify-throws',
      display_name: 'chair-notify-throws',
      pane_key: paneKey
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: 'sess-notify-throws',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-notify-throws',
        paneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const notifyRebindDelivery = vi.fn(() => {
      throw new Error('mailbox unavailable')
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, { ensureAgentSession, notifyRebindDelivery }),
      orchestrationDb!,
      HOST_ID,
      'agent-notify-throws',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, paneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(notifyRebindDelivery).toHaveBeenCalledWith('agent-notify-throws')
    const noteRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE verb = 'sweep_note'
           AND reason_code = 'delivery_notify_failed: mailbox unavailable'`
      )
      .all()
    expect(noteRows).toHaveLength(1)
  })

  it('[S10-21a C7l item 2a] runRestoreSweep onLockAcquired: the serve path yields a non-null watermark when the store opens', async () => {
    rawDb()
    // A fresh DB's agent_audit is empty (newestAgentAuditSeq() null); seed one row so the
    // watermark has something real to read.
    orchestrationDb!.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: null,
      verb: 'sweep_note',
      outcome: 'proceeded',
      reasonCode: 'seed_for_watermark_test'
    })
    // Not the real getOrchestrationDb() (arms federation relay/dispatch-liveness bootstrapping
    // this isolated test never sets up) — same substitution pattern pty.test.ts uses.
    const runtime = new OrcaRuntimeService()
    runtime.getOrchestrationDb = () => orchestrationDb!
    expect(runtime.getSelfResumeWatermark()).toBeNull()
    await runRestoreSweep(baseDeps(orchestrationDb!), () =>
      captureSelfResumeWatermarkAtStartup(runtime)
    )
    expect(runtime.getSelfResumeWatermark()).not.toBeNull()
    expect(typeof runtime.getSelfResumeWatermark()).toBe('number')
  })
})
