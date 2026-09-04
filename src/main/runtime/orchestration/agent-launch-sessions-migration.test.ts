// S10-21a C1 (§7): schema v41 migration. New tables land empty, no-op on a second run, every
// pre-existing table's row count is unchanged, and the three new tables are exempt from
// resetAll.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { upsertAgentByPaneSuffix } from './agent-directory'
import { getSweepRestoreMark, recordLaunch, setSweepRestoreMark } from './agent-launch-sessions'
import { OrchestrationDb } from './db'

const NEW_TABLES = ['agent_launch_sessions', 'current_sessions', 'agent_sweep_restore_marks']

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function hasTable(sqlite: Database.Database, table: string): boolean {
  return (
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  )
}

function rowCount(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

function preexistingTableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           AND name NOT IN ('agent_launch_sessions', 'current_sessions', 'agent_sweep_restore_marks')`
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
}

describe('S10-21a C1: schema v41 migration', () => {
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
    tempDir = mkdtempSync(join(tmpdir(), 'orca-launch-sessions-migration-'))
    return join(tempDir, 'orchestration.db')
  }

  it('a v40 store migrates to user_version 41 with the three new tables present and empty; every pre-existing row count is unchanged; a second run is a no-op', () => {
    const path = freshPath()

    // Build a real v40 store, record a few pre-existing rows, then downgrade it to a v40
    // fixture by dropping this slice's three tables and rewinding user_version. Uses
    // upsertAgentByPaneSuffix (schema-only, no legacy-run-adoption side effects) rather than
    // createTask, whose implicit-runId path triggers this repo's pre-existing legacy-adoption
    // migration pass on the next open — unrelated to this slice's v41 change.
    db = new OrchestrationDb(path)
    const sqliteBefore = rawDb(db)
    upsertAgentByPaneSuffix(sqliteBefore, {
      displayName: 'pre-existing-agent-a',
      role: 'pre-existing row A',
      hostId: 'local',
      paneKey: 'tab1:leaf-preexisting-a',
      terminalHandle: 'term_pre_a',
      processIncarnation: 'inc_pre_a',
      worktreeId: 'wt_pre_a',
      worktreePath: '/wt/pre-a',
      branch: 'pre-a',
      title: 'pre-existing a',
      agentLabel: 'Claude Code',
      originHandle: 'term_pre_a',
      originHostId: 'local'
    })
    upsertAgentByPaneSuffix(sqliteBefore, {
      displayName: 'pre-existing-agent-b',
      role: 'pre-existing row B',
      hostId: 'local',
      paneKey: 'tab1:leaf-preexisting-b',
      terminalHandle: 'term_pre_b',
      processIncarnation: 'inc_pre_b',
      worktreeId: 'wt_pre_b',
      worktreePath: '/wt/pre-b',
      branch: 'pre-b',
      title: 'pre-existing b',
      agentLabel: 'Claude Code',
      originHandle: 'term_pre_b',
      originHostId: 'local'
    })
    const preexisting = preexistingTableNames(sqliteBefore)
    const countsBefore = new Map(preexisting.map((t) => [t, rowCount(sqliteBefore, t)]))
    db.close()
    db = undefined

    const oldDb = new Database(path)
    for (const table of NEW_TABLES) {
      oldDb.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    oldDb.pragma('user_version = 40')
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(41)
    for (const table of NEW_TABLES) {
      expect(hasTable(sqlite, table)).toBe(true)
      expect(rowCount(sqlite, table)).toBe(0)
    }
    for (const table of preexisting) {
      expect(rowCount(sqlite, table)).toBe(countsBefore.get(table))
    }
    db.close()
    db = undefined

    // Second open (migrate() re-runs on every open; current is already 41) is a no-op.
    db = new OrchestrationDb(path)
    const sqliteAgain = rawDb(db)
    expect(sqliteAgain.pragma('user_version', { simple: true })).toBe(41)
    for (const table of NEW_TABLES) {
      expect(rowCount(sqliteAgain, table)).toBe(0)
    }
  })

  it('a v41-stamped DB with agent_launch_sessions entirely absent is re-created empty on open', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec(`DROP TABLE agent_launch_sessions`)
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(hasTable(sqlite, 'agent_launch_sessions')).toBe(true)
    expect(rowCount(sqlite, 'agent_launch_sessions')).toBe(0)
  })

  it('resetAll leaves the three new tables intact', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = rawDb(db)
    recordLaunch(sqlite, {
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      agentType: 'claude',
      sessionId: 'sess-a',
      launchGeneration: 'gen-1',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    setSweepRestoreMark(sqlite, 'local', 'tab1:leaf-a')

    db.resetAll()

    expect(rowCount(sqlite, 'agent_launch_sessions')).toBe(1)
    expect(rowCount(sqlite, 'current_sessions')).toBe(1)
    expect(getSweepRestoreMark(sqlite, 'local', 'tab1:leaf-a')).toBe(true)
  })
})
