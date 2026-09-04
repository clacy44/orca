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

  it("T47: pty:spawn naming a registered pane's key (no host-resume, no matching id) is UNRECORDED(pane_key_owned), no row, no delete", async () => {
    const db = freshDb()
    insertRegisteredAgent(db, 'tab1:leaf-a')
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(admitted.spawnOptions.command).toBe('claude') // no splice
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined() // no row
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('pane_key_owned')
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
    const contested: [string, string][] = []
    await admitAgentLaunch(
      () => db,
      opts({ command: 'claude --resume self-sess' }),
      CALLER,
      ctx({
        contestedLineage: (claimantPaneKey, registeredPaneKey) =>
          contested.push([claimantPaneKey, registeredPaneKey])
      })
    )
    expect(contested).toEqual([['tab1:leaf-a', 'tabOLD:leaf-a']])
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

  it('T-B1 (D-R104 B-1): a covered, remote launch naming a REGISTERED pane is UNRECORDED(pane_key_owned), no row, notice called', async () => {
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
    expect(admitted.spawnOptions.command).toBe('claude') // no splice
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined() // no row, HOST_ID (compat), not the ssh id
    const auditRow = rawDb(db)
      .prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`)
      .get() as { verb: string; reason_code: string; actor_host_id: string }
    expect(auditRow.verb).toBe('launch_unrecorded')
    expect(auditRow.reason_code).toBe('pane_key_owned')
    expect(auditRow.actor_host_id).toBe(HOST_ID) // the compatibility id, never the ssh execution id
    expect(notices).toEqual([
      { paneKey: 'tab1:leaf-a', verb: 'launch_unrecorded', reasonCode: 'pane_key_owned' }
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
