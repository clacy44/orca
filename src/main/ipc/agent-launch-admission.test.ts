// S10-21a C3-v2 (errata 5(p) v2.1 §C.1-§C.4, §C.6): the launch-admission point, exercised
// end-to-end against a real in-memory OrchestrationDb (same harness as
// agent-launch-sessions.test.ts). Every test here must fail at 1f84f30d2a by construction —
// admitAgentLaunch, LaunchAdmission and the (host,pane) lock do not exist there.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  admitAgentLaunch,
  LaunchAdmissionRefusedError,
  type LaunchAdmission
} from './agent-launch-admission'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import type * as NodeCrypto from 'node:crypto'

const MINTED_A = '11111111-1111-4111-8111-111111111111'
const MINTED_B = '22222222-2222-4222-8222-222222222222'
// [S10-21c B3b, D-R149 MEDIUM 2] caller_resume now requires a UUID-shaped selector before it is
// recorded — these two are valid shapes for the caller_resume tests below.
const REAL_CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const VICTIM_SESSION_ID = '44444444-4444-4444-8444-444444444444'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn(() => MINTED_A) }
})

import { randomUUID } from 'node:crypto'

const CALLER: LaunchAdmission = { kind: 'caller' }
const HOST_ID = 'local'

describe('S10-21a C3-v2, errata 5(p) v2.1: admitAgentLaunch', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    vi.mocked(randomUUID).mockReturnValue(MINTED_A)
    orchestrationDb?.close()
  })

  function freshDb(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }

  function rawDb(db: OrchestrationDb): Database.Database {
    return (db as unknown as { db: Database.Database }).db
  }

  function insertRegisteredAgent(db: OrchestrationDb, paneKey: string): void {
    rawDb(db)
      .prepare(
        `INSERT INTO agents (
           id, display_name, host_id, pane_key, origin_kind, origin_pane_key, origin_host_id
         ) VALUES (?, ?, ?, ?, 'pane', ?, ?)`
      )
      .run(`agt_${paneKey}`, `disp-${paneKey}`, HOST_ID, paneKey, paneKey, HOST_ID)
  }

  // [D-R104 F-3, forced deviation — pre-existing fixture] `notice`/`contestedLineage` are now
  // REQUIRED on AgentLaunchAdmissionContext; every test that doesn't care supplies a no-op spy
  // here so the type checks, exactly as `ctx({ notice: ... })` etc. already override below.
  function ctx(overrides: Partial<Parameters<typeof admitAgentLaunch>[3]> = {}) {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {},
      ...overrides
    }
  }

  function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', ...overrides }
  }

  it('T22: HOST_MINTED writes the row and splices --session-id onto the argv provider.spawn receives, before any spawn', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(admitted.spawnOptions.command).toBe(`claude --session-id '${MINTED_A}'`)
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe(MINTED_A)
    expect(row?.evidence).toBe('host_launch')
    // [S10-21a C7g, Ruling 34 Addendum 25] classification threads through for the C7f/C7g gate.
    expect(admitted.classification).toBe('host_minted')
  })

  it('T22: a record-write failure refuses, never yields a spawnable admission', async () => {
    const db = freshDb()
    // Pre-seed a DIFFERENT pane already holding MINTED_A's session id, so recordLaunch's
    // UNIQUE(host_id, session_id) collides with a genuinely foreign pane.
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-other',
      agentType: 'claude',
      sessionId: MINTED_A,
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    await expect(
      admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    ).rejects.toThrow(LaunchAdmissionRefusedError)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
  })

  it('T36: exactly one --session-id on the final argv and exactly one row for a HOST_MINTED launch', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --model opus' }),
      CALLER,
      ctx()
    )
    const occurrences = (admitted.spawnOptions.command?.match(/--session-id/g) ?? []).length
    expect(occurrences).toBe(1)
    const rows = rawDb(db)
      .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?')
      .get('tab1:leaf-a') as { n: number }
    expect(rows.n).toBe(1)
  })

  it('T37: HOST_RESUME records the resumed id, evidence sweep_record, and appends no --session-id', async () => {
    const db = freshDb()
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1'
    }
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume predecessor-sess' }),
      admission,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('claude --resume predecessor-sess')
    expect(admitted.spawnOptions.command).not.toContain('--session-id')
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe('predecessor-sess')
    expect(row?.evidence).toBe('sweep_record')
    // [S10-21a C7g, Ruling 34 Addendum 25] classification threads through for the C7f/C7g gate.
    expect(admitted.classification).toBe('host_resume')
  })

  it('S10-21c B2/S6: a host-resume admission whose command lost its selector refuses restore_selector_lost, never falls through to unrecorded', async () => {
    const db = freshDb()
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1'
    }
    await expect(
      admitAgentLaunch(() => db, opts({ command: 'claude --resume' }), admission, ctx())
    ).rejects.toThrow(LaunchAdmissionRefusedError)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.reason_code).toBe('restore_selector_lost')
  })

  it("S10-21c B2/S6: a NON-host-resume (caller) admission with an idless selector keeps today's unrecorded(resume_target_undeterminable) behavior unchanged", async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume' }),
      CALLER,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('claude --resume')
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('resume_target_undeterminable')
  })

  it("S10-21c B3b, D-R149 INFO 2: a NON-host-resume (caller) admission with an idless selector into an OWNED pane is STILL unrecorded(resume_target_undeterminable) — the `owned ? 'pane_key_owned' : ...` ternary is deleted, the audit tells the truth either way", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'first-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume' }),
      CALLER,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('claude --resume')
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('resume_target_undeterminable')
  })

  it('T40: an uncovered/unpaned launch never writes a row (pass-through)', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(
      () => db,
      { cols: 80, rows: 24, command: 'bash -lc zsh' },
      CALLER,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('bash -lc zsh')
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
  })

  it('T40: confirm() deletes the row and audits launch_surface_diverged when the spawn result names a different pane', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeDefined()
    const divergedResult: PtySpawnResult = {
      id: 'pty-1',
      agentSessionEnsure: {
        disposition: 'created',
        owner: {
          claim: {
            digestVersion: 1,
            keyId: 'k',
            identityDigest: 'd',
            worktreeScopeDigest: 'w',
            agent: 'claude'
          },
          generation: 'g',
          phase: 'live',
          ptyId: 'pty-1',
          surface: { worktreeId: 'wt', tabId: 'tab1', leafId: 'leaf-OTHER', terminalHandle: 'h' }
        }
      }
    }
    admitted.confirm(divergedResult)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string }
    expect(auditRow.verb).toBe('launch_surface_diverged')
  })

  it('T41 / C1a fence: a second HOST_MINTED launch into the same pane, same launchGeneration, after the first row was compensated, succeeds', async () => {
    const db = freshDb()
    vi.mocked(randomUUID).mockReturnValueOnce(MINTED_A)
    const first = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')?.session_id).toBe(MINTED_A)
    first.compensate() // simulates the provider spawn throwing
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()

    vi.mocked(randomUUID).mockReturnValueOnce(MINTED_B)
    // Under C1's dropped UNIQUE(host_id, pane_key, launch_generation), this second insert with
    // the SAME launch_generation for the SAME pane would have thrown; C1a's schema amendment is
    // what lets it succeed.
    await expect(
      admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    ).resolves.toBeDefined()
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')?.session_id).toBe(MINTED_B)
  })

  // [S10-21c B3, design §2 S2 — SCENARIO_CORRECTION of T47] T47 asserted the behaviour S2
  // DELETES. Its subject (a covered, selector-free launch naming a registered pane's key) is
  // unchanged; only the expected outcome moves, from UNRECORDED(pane_key_owned) to HOST_MINTED.
  // Nothing is weakened: every T47 assertion has a strictly stronger counterpart below (a row
  // IS written, the argv IS spliced, current_sessions DOES move, and no `launch_unrecorded`
  // audit is written at all). The takeover fence T47's name gestures at lives in
  // `createTerminal`'s E1/E2, not here — proven independently in
  // orca-runtime-pane-key-gate.test.ts (T27, T45, and the B3 fence-independence test).
  it("T47/S2: a covered, selector-free launch naming a pane with only a NON-DERIVED REGISTERED row is HOST_MINTED — row written, argv spliced (closes R2's second half)", async () => {
    const db = freshDb()
    insertRegisteredAgent(db, 'tab1:leaf-a')
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    // [S10-21c B3b, D-R149 MEDIUM 1] contested-lineage is now raised on this arm too — the
    // pane it writes to is a registered chair's pane.
    const contested: [string, string, string][] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude' }),
      CALLER,
      ctx({
        notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }),
        contestedLineage: (claimantPaneKey, registeredPaneKey, registeredAgentId) =>
          contested.push([claimantPaneKey, registeredPaneKey, registeredAgentId])
      })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --session-id '${MINTED_A}'`)
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe(MINTED_A)
    expect(row?.evidence).toBe('host_launch')
    expect(admitted.classification).toBe('host_minted')
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_host_minted', reasonCode: 'launch_host_minted' }
    ])
    expect(contested).toEqual([['tab1:leaf-a', 'tab1:leaf-a', 'agt_tab1:leaf-a']])
    const currentSession = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-a') as { session_id: string }
    expect(currentSession.session_id).toBe(MINTED_A)
    const unrecorded = rawDb(db)
      .prepare(`SELECT COUNT(*) as n FROM agent_audit WHERE verb = 'launch_unrecorded'`)
      .get() as { n: number }
    expect(unrecorded.n).toBe(0)
  })

  it('T49: launchAgent omitted, command carries claude + --session-id -> REFUSE (sniff reaches refusal)', async () => {
    const db = freshDb()
    await expect(
      admitAgentLaunch(
        () => db,
        opts({ launchAgent: undefined, command: 'claude --session-id evil' }),
        CALLER,
        ctx()
      )
    ).rejects.toThrow(LaunchAdmissionRefusedError)
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
  })

  it('T49: launchAgent omitted, bare claude -> UNRECORDED(sniffed_no_lineage), never HOST_MINTED, never a row', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ launchAgent: undefined, command: 'claude' }),
      CALLER,
      ctx()
    )
    expect(admitted.spawnOptions.command).toBe('claude') // never spliced
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
  })

  it('T51: two concurrent admissions for one pane key serialise — exactly one is newest, current_sessions holds it', async () => {
    const db = freshDb()
    vi.mocked(randomUUID).mockReturnValueOnce(MINTED_A).mockReturnValueOnce(MINTED_B)
    const [a, b] = await Promise.all([
      admitAgentLaunch(() => db, opts({ command: 'claude', worktreeId: 'wtA' }), CALLER, ctx()),
      admitAgentLaunch(() => db, opts({ command: 'claude', worktreeId: 'wtB' }), CALLER, ctx())
    ])
    expect([a, b].every((x) => x !== undefined)).toBe(true)
    const currentSession = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-a') as { session_id: string }
    const newest = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(currentSession.session_id).toBe(newest?.session_id)
  })

  it('T52: SELF_RESUME(caller) into a registered pane is admitted, writes no row, audits launch_self_resume(caller), and notices', async () => {
    const db = freshDb()
    // Seed the pane's own newest row directly (as if the host had launched it earlier).
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'self-sess',
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    insertRegisteredAgent(db, 'tab1:leaf-a')
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const contested: string[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume self-sess' }),
      CALLER,
      ctx({
        notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }),
        contestedLineage: (paneKey) => contested.push(paneKey)
      })
    )
    expect(admitted.spawnOptions.command).toBe('claude --resume self-sess')
    const rowCountAfter = rawDb(db)
      .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?')
      .get('tab1:leaf-a') as { n: number }
    expect(rowCountAfter.n).toBe(1) // unchanged from the seeded row
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_self_resume')
    expect(auditRow.reason_code).toBe('caller')
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_self_resume', reasonCode: 'caller' }
    ])
    expect(contested).toEqual(['tab1:leaf-a'])
    // [S10-21a C7g, Ruling 34 Addendum 25] classification threads through for the C7f/C7g gate.
    expect(admitted.classification).toBe('self_resume_caller')
  })

  it("S10-21a C7g: SELF_RESUME(host) — a host-resume admission whose target mismatches the pane's own newest row classifies self_resume_host", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'self-sess-host',
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'a-different-target',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1'
    }
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume self-sess-host' }),
      admission,
      ctx()
    )
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_self_resume')
    expect(auditRow.reason_code).toBe('host')
    expect(admitted.classification).toBe('self_resume_host')
  })

  it("S10-21a C6 SCOPE 3(b): contestedLineage receives BOTH panes when the registered row's own pane_key differs (pane-suffix match)", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'self-sess',
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    // Registered under a DIFFERENT tabId prefix, same leaf suffix — getAgentByPaneKey matches
    // by suffix (derived-agent-rows.ts), so this row is found even though its own pane_key
    // string differs from the SELF_RESUME's claimed paneKey.
    insertRegisteredAgent(db, 'tabOLD:leaf-a')
    // [S10-21a C6b, Ruling 34 Addendum 19] contestedLineage's signature widened to carry the
    // registered row's own id — the admission-side contest audit is attributed to it (verb
    // 'launch', outcome 'contested'), not left agentId: null.
    const contested: [string, string, string][] = []
    await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume self-sess' }),
      CALLER,
      ctx({
        contestedLineage: (claimantPaneKey, registeredPaneKey, registeredAgentId) =>
          contested.push([claimantPaneKey, registeredPaneKey, registeredAgentId])
      })
    )
    expect(contested).toEqual([['tab1:leaf-a', 'tabOLD:leaf-a', 'agt_tabOLD:leaf-a']])
  })

  it('SELF_RESUME(v2.1 V1): always audits, even into an UNregistered pane (no notice/contest)', async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'self-sess',
      launchGeneration: 'gen-1',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const notices: unknown[] = []
    await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume self-sess' }),
      CALLER,
      ctx({ notice: (...args) => notices.push(args) })
    )
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string }
    expect(auditRow.verb).toBe('launch_self_resume') // ALWAYS audited (v2.1 V1)
    expect(notices).toEqual([]) // no registered row -> no notice/contest
  })

  const REMOTE_EXECUTION_HOST_ID = 'ssh:conn-1'

  // [S10-21c B3, design §2 S2 — SCENARIO_CORRECTION of T-B1] D-R104 B-1's actual subject is the
  // HOST NAMESPACE (`ctx.hostId` must be the compatibility id, never the ssh execution id, or the
  // registered-pane lookup misses). That is asserted here unchanged and strengthened: the row is
  // now written, and it is written under HOST_ID with the ssh id in `execution_host_id`. Only the
  // outcome that S2 deletes (UNRECORDED(pane_key_owned)) moves to HOST_MINTED.
  it('T-B1 (D-R104 B-1)/S2: a covered, REMOTE launch naming a REGISTERED pane is HOST_MINTED and its row is keyed by the COMPATIBILITY host id, never the ssh one', async () => {
    const db = freshDb()
    insertRegisteredAgent(db, 'tab1:leaf-a')
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude', commandDelivery: 'provider' }),
      CALLER,
      ctx({
        executionHostId: REMOTE_EXECUTION_HOST_ID,
        notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode })
      })
    )
    expect(admitted.spawnOptions.command).toBe(`claude --session-id '${MINTED_A}'`)
    // Found under HOST_ID (compat), NOT the ssh id — the B-1 fence, unchanged.
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe(MINTED_A)
    expect(row?.execution_host_id).toBe(REMOTE_EXECUTION_HOST_ID)
    expect(db.newestLaunchForPane(REMOTE_EXECUTION_HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_host_minted', reasonCode: 'launch_host_minted' }
    ])
  })

  it('T-B2 (D-R104 B-2): a remote covered launch with NO commandDelivery is UNRECORDED(command_not_host_delivered), no splice, no row', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude' }), // no commandDelivery at all — the relay's own default is 'renderer'
      CALLER,
      ctx({ executionHostId: REMOTE_EXECUTION_HOST_ID })
    )
    expect(admitted.spawnOptions.command).toBe('claude')
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('command_not_host_delivered')
  })

  it('T-B2 (D-R104 B-2): a remote covered launch WITH commandDelivery: provider is HOST_MINTED (splices, writes a row)', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude', commandDelivery: 'provider' }),
      CALLER,
      ctx({ executionHostId: REMOTE_EXECUTION_HOST_ID })
    )
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row).toBeDefined()
    // Whichever UUID the (possibly-stubbed) minter returned, the SAME value must appear in
    // both the spliced argv and the row — not a hardcoded literal (T51 leaves a queued mock
    // return value from its own concurrent-serialization scenario; this asserts on
    // self-consistency instead of a specific minted id).
    expect(admitted.spawnOptions.command).toBe(`claude --session-id '${row?.session_id}'`)
    expect(row?.execution_host_id).toBe(REMOTE_EXECUTION_HOST_ID)
  })

  it('D-R104 F-4: a HOST_RESUME compensate() deletes its row and restores the predecessor pane current_sessions row', async () => {
    const db = freshDb()
    // Seed the predecessor pane's own launch history so it has something to restore to.
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-old',
      agentType: 'claude',
      sessionId: 'predecessor-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'predecessor-sess',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1'
    }
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume predecessor-sess' }),
      admission,
      ctx()
    )
    // supersedePaneKey already deleted the predecessor's current_sessions row.
    expect(
      rawDb(db)
        .prepare('SELECT 1 FROM current_sessions WHERE host_id = ? AND pane_key = ?')
        .get(HOST_ID, 'tab1:leaf-old')
    ).toBeUndefined()
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')?.session_id).toBe('predecessor-sess')

    admitted.compensate() // simulates provider.spawn throwing
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    const restored = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-old') as { session_id: string } | undefined
    expect(restored?.session_id).toBe('predecessor-sess')
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string }
    expect(auditRow.verb).toBe('launch_spawn_failed')
  })

  it('D-R104 F-5: compensate(true) still audits launch_ensure_failed_after_spawn AFTER confirm() already settled, and never deletes the row', async () => {
    const db = freshDb()
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    const matchingSurface: PtySpawnResult = {
      id: 'pty-1',
      agentSessionEnsure: {
        disposition: 'created',
        owner: {
          claim: {
            digestVersion: 1,
            keyId: 'k',
            identityDigest: 'd',
            worktreeScopeDigest: 'w',
            agent: 'claude'
          },
          generation: 'g',
          phase: 'live',
          ptyId: 'pty-1',
          surface: { worktreeId: 'wt', tabId: 'tab1', leafId: 'leaf-a', terminalHandle: 'h' }
        }
      }
    }
    admitted.confirm(matchingSurface) // surface matches -> settles cleanly, no delete
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeDefined()

    admitted.compensate(true) // the LATER agentSessionOwners.ensure post-callback throw
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeDefined() // never destroyed
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string }
    expect(auditRow.verb).toBe('launch_ensure_failed_after_spawn')

    // Idempotent: a second compensate(true) does not audit again.
    const countBefore = (
      rawDb(db).prepare('SELECT COUNT(*) as n FROM agent_audit').get() as { n: number }
    ).n
    admitted.compensate(true)
    const countAfter = (
      rawDb(db).prepare('SELECT COUNT(*) as n FROM agent_audit').get() as { n: number }
    ).n
    expect(countAfter).toBe(countBefore)
  })

  // ---------------------------------------------------------------------------------------
  // S10-21c B3 (design §2 S2 + its ADDENDUM): admission records the pane's own relaunch
  // instead of silently dropping it. Every test below is RED at eaefe28aab (B2b) — the
  // `owned` early return drops the selector-free case, the caller-selector arm returns
  // `unrecorded`, and no host-resume selector fence exists on either arm.
  // ---------------------------------------------------------------------------------------

  it('S2/R1: a covered, selector-free RELAUNCH into a pane that already has a launch row mints a NEW session and records it (the row no longer stays pinned to the first, often stub, id)', async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'stub-first-id',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    vi.mocked(randomUUID).mockReturnValue(MINTED_B)
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(admitted.spawnOptions.command).toBe(`claude --session-id '${MINTED_B}'`)
    expect(admitted.classification).toBe('host_minted')
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe(MINTED_B)
    expect(row?.evidence).toBe('host_launch')
    // Append-only ledger: the first row is still there, the new one is newest by seq.
    const rows = rawDb(db)
      .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?')
      .get('tab1:leaf-a') as { n: number }
    expect(rows.n).toBe(2)
    const currentSession = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-a') as { session_id: string }
    expect(currentSession.session_id).toBe(MINTED_B)
  })

  it("S2: a caller's `claude --resume X` into an owned pane is RECORDED with evidence 'caller_resume' — never spliced, never dropped", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'first-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx({ notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }) })
    )
    // The caller's own argv, byte-for-byte: no `--session-id` splice, no `--resume` rewrite.
    expect(admitted.spawnOptions.command).toBe(`claude --resume ${REAL_CONVERSATION_ID}`)
    const row = db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')
    expect(row?.session_id).toBe(REAL_CONVERSATION_ID)
    expect(row?.evidence).toBe('caller_resume')
    const currentSession = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-a') as { session_id: string }
    expect(currentSession.session_id).toBe(REAL_CONVERSATION_ID)
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_caller_resume', reasonCode: 'launch_caller_resume' }
    ])
    // No classification is claimed: see buildRecordedAdmission's own doc comment (every existing
    // value would be a lie and a new one is a renderer-facing wire enum change).
    expect(admitted.classification).toBeUndefined()
  })

  it("S10-21c B3b, D-R149 MEDIUM 1: a caller's `claude --resume X` into a REGISTERED pane's own relaunch raises contestedLineage", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'first-sess',
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    insertRegisteredAgent(db, 'tab1:leaf-a')
    const contested: [string, string, string][] = []
    await admitAgentLaunch(
      () => db,
      opts({ command: `claude --resume ${REAL_CONVERSATION_ID}` }),
      CALLER,
      ctx({
        contestedLineage: (claimantPaneKey, registeredPaneKey, registeredAgentId) =>
          contested.push([claimantPaneKey, registeredPaneKey, registeredAgentId])
      })
    )
    expect(contested).toEqual([['tab1:leaf-a', 'tab1:leaf-a', 'agt_tab1:leaf-a']])
  })

  it("S10-21c B3b, D-R149 MEDIUM 2: a caller's `claude --resume X` where X is NOT UUID-shaped is UNRECORDED (resume_target_unparseable) — no row, spawn still proceeds", async () => {
    const db = freshDb()
    const notices: { paneKey: string; verb: string; reasonCode: string }[] = []
    const admitted = await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume not-a-uuid' }),
      CALLER,
      ctx({ notice: (paneKey, verb, reasonCode) => notices.push({ paneKey, verb, reasonCode }) })
    )
    // Unrecorded still passes the spawn through untouched — never a splice, never a drop.
    expect(admitted.spawnOptions.command).toBe('claude --resume not-a-uuid')
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_unrecorded', reasonCode: 'resume_target_unparseable' }
    ])
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('resume_target_unparseable')
  })

  it("S2: a caller's `claude --resume X` naming ANOTHER pane's current session is REFUSED (resume_target_owned_by_another_pane) — no row, no supersede, the victim pane untouched", async () => {
    const db = freshDb()
    db.recordLaunch({
      hostId: HOST_ID,
      paneKey: 'tab1:leaf-victim',
      agentType: 'claude',
      sessionId: VICTIM_SESSION_ID,
      launchGeneration: 'gen-0',
      executionHostId: HOST_ID,
      evidence: 'host_launch'
    })
    await expect(
      admitAgentLaunch(
        () => db,
        opts({ command: `claude --resume ${VICTIM_SESSION_ID}` }),
        CALLER,
        ctx()
      )
    ).rejects.toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'resume_target_owned_by_another_pane'
    })
    // Nothing recorded for the claimant pane.
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    // The victim keeps both its launch row and its current_sessions row — the UNIQUE(host_id,
    // session_id) fence adjudicated, and `supersedePaneKey` was never set from this call site.
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-victim')?.session_id).toBe(VICTIM_SESSION_ID)
    const victimCurrent = rawDb(db)
      .prepare('SELECT session_id FROM current_sessions WHERE host_id = ? AND pane_key = ?')
      .get(HOST_ID, 'tab1:leaf-victim') as { session_id: string }
    expect(victimCurrent.session_id).toBe(VICTIM_SESSION_ID)
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.outcome).toBe('refused')
    expect(auditRow.reason_code).toBe('resume_target_owned_by_another_pane')
  })

  it('S2 ADDENDUM: a host-resume admission whose command names a DIFFERENT session id is REFUSED (restore_selector_mismatch) — no row, no spawnable admission', async () => {
    const db = freshDb()
    const admission: LaunchAdmission = {
      kind: 'host-resume',
      sessionId: 'the-ticket-session',
      predecessorPaneKey: 'tab1:leaf-old',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1'
    }
    await expect(
      admitAgentLaunch(
        () => db,
        opts({ command: 'claude --resume a-completely-different-session' }),
        admission,
        ctx()
      )
    ).rejects.toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'restore_selector_mismatch'
    })
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; outcome: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_refused')
    expect(auditRow.outcome).toBe('refused')
    expect(auditRow.reason_code).toBe('restore_selector_mismatch')
  })

  // The other half of the same fence, on the arm B3 itself opens: with the `owned` early return
  // deleted, a host-resume that reaches the SELECTOR-FREE arm would take HOST_MINTED and mint a
  // fresh id FOR A RESTORE — recording a brand-new empty conversation as the pane's newest and
  // destroying the pointer to the real one. Same reason code as B2's `undeterminable` arm: the
  // selector is gone either way. Asserted with AND without a registered row, because the
  // `owned`-true half is the one the deleted early return used to catch.
  it.each([
    ['an owned pane (a registered row)', true],
    ['an unowned pane', false]
  ])(
    'S2 ADDENDUM: a host-resume admission whose command lost its selector entirely into %s is REFUSED (restore_selector_lost) — never HOST_MINTED',
    async (_label, seedRegistered) => {
      const db = freshDb()
      if (seedRegistered) {
        insertRegisteredAgent(db, 'tab1:leaf-a')
      }
      const admission: LaunchAdmission = {
        kind: 'host-resume',
        sessionId: 'the-ticket-session',
        predecessorPaneKey: 'tab1:leaf-old',
        executionHostId: HOST_ID,
        launchGeneration: 'gen-1'
      }
      await expect(
        admitAgentLaunch(() => db, opts({ command: 'claude' }), admission, ctx())
      ).rejects.toMatchObject({
        name: 'LaunchAdmissionRefusedError',
        reasonCode: 'restore_selector_lost'
      })
      expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
      const auditRow = rawDb(db)
        .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
        .get() as { verb: string; reason_code: string }
      expect(auditRow.verb).toBe('launch_refused')
      expect(auditRow.reason_code).toBe('restore_selector_lost')
    }
  )

  // [S10-21c B3 regression guard — GREEN at base, must stay green] `scanRefusal` runs BEFORE the
  // pane lock and before any `owned` reasoning, so deleting the `owned` early return cannot make
  // either hard refusal reachable-around. Seeded with a registered row so the deleted branch
  // would have been the very next thing to run.
  it.each([
    ['--session-id', 'claude --session-id smuggled', 'launch_session_id_forbidden'],
    ['--fork-session', 'claude --resume real-sess --fork-session', 'launch_fork_forbidden']
  ])(
    'S10-21c B3 regression: %s into an OWNED pane still hard-refuses via scanRefusal, no row',
    async (_label, command, reasonCode) => {
      const db = freshDb()
      insertRegisteredAgent(db, 'tab1:leaf-a')
      await expect(
        admitAgentLaunch(() => db, opts({ command }), CALLER, ctx())
      ).rejects.toMatchObject({ name: 'LaunchAdmissionRefusedError', reasonCode })
      expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
    }
  )
})

describe("S10-21a C3-v2, errata 5(p) T50: no non-test writer of delivery: 'terminal-paste'", () => {
  it("no non-test source assigns the object-literal shape delivery: 'terminal-paste' (the type declaration delivery?: and the === comparison are excluded, neither is a writer)", () => {
    const root = join(__dirname, '..', '..', '..', 'src')
    // Matches an OBJECT-LITERAL property assignment: a bare key, a colon, then the literal. A
    // type declaration is `delivery?:` (the `?` breaks `\bdelivery\s*:`) and a read is
    // `=== 'terminal-paste'` (no colon at all) — neither matches this pattern.
    const assignmentPattern = /\bdelivery\s*:\s*'terminal-paste'/
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
          continue
        }
        const text = readFileSync(full, 'utf8')
        if (assignmentPattern.test(text)) {
          offenders.push(full)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
