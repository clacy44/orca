// S10-21d R118 (design (a), v43): SCHEMA v42 -> v43 migration. Additive only: three nullable
// TEXT columns (pref_model, pref_effort, pref_source) on agent_launch_sessions. No data rewrite,
// no index change, the launch ledger stays append-only (asserted via recordSelfReportRotation's
// in-place UPDATE below, which never targets pref_* — carrying them forward is a property of
// UPDATE not naming those columns, not a code path added by this slice).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  recordLaunch,
  recordSelfReportRotation,
  updateLaunchPrefsForPane,
  type AgentLaunchSessionRow
} from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const PREF_COLUMNS = ['pref_model', 'pref_effort', 'pref_source']

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).some(
    (c) => c.name === column
  )
}

function rowCount(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

function preexistingTableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name)
}

describe('S10-21d R118: schema v43 migration (per-pane model/effort prefs)', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    db = undefined
    tempDir = undefined
  })

  function freshPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-launch-prefs-migration-'))
    return join(tempDir, 'orchestration.db')
  }

  it('a v42 store migrates to user_version 43: pref_model/pref_effort/pref_source present and NULL on a pre-existing row, every pre-existing row count unchanged, a second open is a no-op', () => {
    const path = freshPath()

    db = new OrchestrationDb(path)
    const before = rawDb(db)
    recordLaunch(before, {
      hostId: 'local',
      paneKey: 'tab1:leaf-preexisting',
      agentType: 'claude',
      sessionId: 'sess-preexisting',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    const preexisting = preexistingTableNames(before)
    const countsBefore = new Map(preexisting.map((t) => [t, rowCount(before, t)]))
    db.close()
    db = undefined

    // Fabricate a genuine v42 fixture: drop the three v43 columns (SQLite ALTER TABLE ... DROP
    // COLUMN, same technique as pact-federated-schema-v42-migration.test.ts's downgradeToV41)
    // and rewind user_version.
    const oldDb = new Database(path)
    for (const column of PREF_COLUMNS) {
      oldDb.exec(`ALTER TABLE agent_launch_sessions DROP COLUMN ${column}`)
    }
    oldDb.pragma('user_version = 42')
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(43)
    for (const column of PREF_COLUMNS) {
      expect(hasColumn(sqlite, 'agent_launch_sessions', column)).toBe(true)
    }
    const row = sqlite
      .prepare(`SELECT * FROM agent_launch_sessions WHERE pane_key = 'tab1:leaf-preexisting'`)
      .get() as AgentLaunchSessionRow
    expect(row.pref_model).toBeNull()
    expect(row.pref_effort).toBeNull()
    expect(row.pref_source).toBeNull()

    for (const table of preexisting) {
      expect(rowCount(sqlite, table)).toBe(countsBefore.get(table))
    }
    db.close()
    db = undefined

    // Second open (migrate() re-runs on every open; current is already 43) is a no-op.
    db = new OrchestrationDb(path)
    const sqliteAgain = rawDb(db)
    expect(sqliteAgain.pragma('user_version', { simple: true })).toBe(43)
    expect(rowCount(sqliteAgain, 'agent_launch_sessions')).toBe(1)
  })

  it('repair tier idempotent: a store already stamped v43 by an in-review copy, missing the three columns, gets them added on open; re-opening again is a no-op', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    // Simulate "stamped v43 by an earlier in-review copy of this branch that never added the
    // columns" — the exact scenario repairUnshippedV43PerPanePrefs (modeled on
    // repairUnshippedV42FederatedPacts) exists to repair: migrate()'s `current < 43` block does
    // NOT re-run once user_version already reads 43.
    const oldDb = new Database(path)
    for (const column of PREF_COLUMNS) {
      oldDb.exec(`ALTER TABLE agent_launch_sessions DROP COLUMN ${column}`)
    }
    // user_version already 43 from the first open above — left as-is, not rewound.
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(43)
    for (const column of PREF_COLUMNS) {
      expect(hasColumn(sqlite, 'agent_launch_sessions', column)).toBe(true)
    }
    db.close()
    db = undefined

    // Idempotent: re-running finds nothing left to repair.
    db = new OrchestrationDb(path)
    const sqliteAgain = rawDb(db)
    for (const column of PREF_COLUMNS) {
      expect(hasColumn(sqliteAgain, 'agent_launch_sessions', column)).toBe(true)
    }
  })

  it('INSERT round-trip: recordLaunch with prefs writes pref_model/pref_effort/pref_source on the new row; NULL prefs on a plain launch leave all three NULL', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)

    const withPrefs = recordLaunch(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch',
      prefs: { model: 'claude-opus-4-8', effort: 'max', source: 'launch' }
    })
    expect(withPrefs.ok).toBe(true)
    expect(withPrefs.ok && withPrefs.row.pref_model).toBe('claude-opus-4-8')
    expect(withPrefs.ok && withPrefs.row.pref_effort).toBe('max')
    expect(withPrefs.ok && withPrefs.row.pref_source).toBe('launch')

    const withoutPrefs = recordLaunch(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-b',
      agentType: 'claude',
      sessionId: 'sess-b',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    expect(withoutPrefs.ok).toBe(true)
    expect(withoutPrefs.ok && withoutPrefs.row.pref_model).toBeNull()
    expect(withoutPrefs.ok && withoutPrefs.row.pref_effort).toBeNull()
    expect(withoutPrefs.ok && withoutPrefs.row.pref_source).toBeNull()
  })

  it('copy-forward on rotation: recordSelfReportRotation updates its target row in place (session_id/evidence only) and never targets pref_*, so a prior launch pref survives the rotation unchanged', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    const launched = recordLaunch(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-rot',
      agentType: 'claude',
      sessionId: 'sess-rot-1',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch',
      prefs: { model: 'claude-opus-4-8', effort: 'high', source: 'launch' }
    })
    expect(launched.ok).toBe(true)

    const rotated = recordSelfReportRotation(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-rot',
      previousSessionId: 'sess-rot-1',
      sessionId: 'sess-rot-2',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'self_report_rotation'
    })
    expect(rotated.ok).toBe(true)
    expect(rotated.ok && rotated.row.session_id).toBe('sess-rot-2')
    expect(rotated.ok && rotated.row.pref_model).toBe('claude-opus-4-8')
    expect(rotated.ok && rotated.row.pref_effort).toBe('high')
    expect(rotated.ok && rotated.row.pref_source).toBe('launch')
  })

  it('updateLaunchPrefsForPane: writes only pref_* on the newest row, no-op on a pane with no launch row, and DEC-9 preserves a launch-sourced "ultracode" against an observed "xhigh" echo (repeatable)', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)

    // No-op: no launch row exists for this pane yet.
    updateLaunchPrefsForPane(sqlite, 'local', 'tab1:leaf-none', {
      effort: 'high',
      source: 'observed'
    })
    expect(rowCount(sqlite, 'agent_launch_sessions')).toBe(0)

    recordLaunch(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-obs',
      agentType: 'claude',
      sessionId: 'sess-obs',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    updateLaunchPrefsForPane(sqlite, 'local', 'tab1:leaf-obs', {
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      source: 'observed'
    })
    let row = sqlite
      .prepare(`SELECT * FROM agent_launch_sessions WHERE pane_key = 'tab1:leaf-obs'`)
      .get() as AgentLaunchSessionRow
    expect(row.pref_model).toBe('claude-opus-4-8')
    expect(row.pref_effort).toBe('xhigh')
    expect(row.pref_source).toBe('observed')

    // DEC-9: a launch-sourced 'ultracode' is never downgraded by an observed 'xhigh' echo.
    recordLaunch(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-ultra',
      agentType: 'claude',
      sessionId: 'sess-ultra',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch',
      prefs: { effort: 'ultracode', source: 'launch' }
    })
    updateLaunchPrefsForPane(sqlite, 'local', 'tab1:leaf-ultra', {
      effort: 'xhigh',
      source: 'observed'
    })
    row = sqlite
      .prepare(`SELECT * FROM agent_launch_sessions WHERE pane_key = 'tab1:leaf-ultra'`)
      .get() as AgentLaunchSessionRow
    expect(row.pref_effort).toBe('ultracode')
    expect(row.pref_source).toBe('launch')

    // Repeatable: a second xhigh echo still doesn't disarm the guard (pref_source was left at
    // 'launch', not flipped to 'observed', by the first call above).
    updateLaunchPrefsForPane(sqlite, 'local', 'tab1:leaf-ultra', {
      effort: 'xhigh',
      source: 'observed'
    })
    row = sqlite
      .prepare(`SELECT * FROM agent_launch_sessions WHERE pane_key = 'tab1:leaf-ultra'`)
      .get() as AgentLaunchSessionRow
    expect(row.pref_effort).toBe('ultracode')
    expect(row.pref_source).toBe('launch')
  })
})
