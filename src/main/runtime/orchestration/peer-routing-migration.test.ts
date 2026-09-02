// S10-15 (chair ruling 7): v37 -> v38 migration — messages.peer_link_device_id/peer_agent_id/
// peer_thread_id/peer_relayed_at, plus the F7a stranded-row repair.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('v37 -> v38 peer routing migration + F7a stranded-row repair', () => {
  let dbPath: string
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('opening a v36-stamped fixture reaches v38 with all four peer_* columns present and null on old rows', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-peer-routing-migrate-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.pragma('user_version = 36')
    raw.exec(`ALTER TABLE remote_agents ADD COLUMN link_kind_unused TEXT`) // no-op sentinel, unused
    raw
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, body, type, priority, read)
         VALUES ('msg_old00000001', 'run_legacy_local', 'someone', 'someone-else', 'hi', 'hi', 'status', 'normal', 1)`
      )
      .run()
    raw.close()

    db = new OrchestrationDb(dbPath)
    const raw2 = new Database(dbPath)
    // S10-19: SCHEMA_VERSION is now 39 (v38 -> v39, peer attachment columns) — a v36-stamped
    // fixture migrates all the way to the CURRENT version, not a version this slice predates.
    expect(raw2.pragma('user_version', { simple: true })).toBe(40)
    for (const column of [
      'peer_link_device_id',
      'peer_agent_id',
      'peer_thread_id',
      'peer_relayed_at'
    ]) {
      const hasColumn = (
        raw2.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
      ).some((c) => c.name === column)
      expect(hasColumn).toBe(true)
    }
    const oldRow = db.getMessageById('msg_old00000001')
    expect(oldRow?.peer_link_device_id ?? null).toBeNull()
    expect(oldRow?.peer_agent_id ?? null).toBeNull()
    // V-3: question_threads.expires_at (the v38 ALTER at db.ts's current<38 block) must also
    // land when migrating up from a v36-stamped fixture — never asserted before.
    const hasExpiresAt = (
      raw2.prepare(`PRAGMA table_info(question_threads)`).all() as { name: string }[]
    ).some((c) => c.name === 'expires_at')
    expect(hasExpiresAt).toBe(true)
    raw2.close()
  })

  it('a v38-stamped fixture with the columns dropped (unshipped-copy case) repairs without throwing, INCLUDING the F7a data repair (m-3)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-peer-routing-repair-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    // S10-15 review m-3: an unshipped-v38 DB (stamped v38 by an earlier build of this branch,
    // never re-entering migrate()'s current<38 block) must ALSO get the F7a data repair, not
    // only the column restore.
    raw
      .prepare(
        `INSERT INTO agents (id, display_name, origin_kind, origin_host_id)
         VALUES ('agt_m3target01', 'carol', 'pane', 'local')`
      )
      .run()
    raw
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, body, type, priority, read, recipient_pane_key)
         VALUES ('msg_m3stranded1', 'run_legacy_local', 'someone', 'carol', 'hi', 'hi there', 'status', 'normal', 0, NULL)`
      )
      .run()
    raw.exec(`
      DROP INDEX IF EXISTS idx_messages_id;
      ALTER TABLE messages RENAME TO messages_old;
      CREATE TABLE messages (
        id TEXT NOT NULL, run_id TEXT NOT NULL, from_handle TEXT NOT NULL, to_handle TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'status',
        priority TEXT NOT NULL DEFAULT 'normal', thread_id TEXT, payload TEXT,
        read INTEGER NOT NULL DEFAULT 0, sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
        sender_pane_key TEXT, recipient_pane_key TEXT, sender_agent_id TEXT,
        purged_at TEXT, purge_reason TEXT, purged_by_agent_id TEXT, gate_flags TEXT,
        thread_sequence INTEGER, payload_kind TEXT
      );
      INSERT INTO messages (
        id, run_id, from_handle, to_handle, subject, body, type, priority, thread_id, payload,
        read, sequence, created_at, delivered_at, sender_pane_key, recipient_pane_key,
        sender_agent_id, purged_at, purge_reason, purged_by_agent_id, gate_flags,
        thread_sequence, payload_kind
      )
      SELECT
        id, run_id, from_handle, to_handle, subject, body, type, priority, thread_id, payload,
        read, sequence, created_at, delivered_at, sender_pane_key, recipient_pane_key,
        sender_agent_id, purged_at, purge_reason, purged_by_agent_id, gate_flags,
        thread_sequence, payload_kind
      FROM messages_old;
      DROP TABLE messages_old;
      CREATE UNIQUE INDEX idx_messages_id ON messages(id);
    `)
    expect(() => {
      raw.prepare(`SELECT peer_link_device_id FROM messages LIMIT 1`).get()
    }).toThrow()
    raw.close()

    expect(() => {
      db = new OrchestrationDb(dbPath)
    }).not.toThrow()
    const raw2 = new Database(dbPath)
    const hasColumn = (
      raw2.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
    ).some((c) => c.name === 'peer_link_device_id')
    expect(hasColumn).toBe(true)
    // V-3: the unshipped-v38-repair branch (db.ts ~1084) restores question_threads.expires_at
    // too, separately from the current<38 migration block — never asserted before.
    const hasExpiresAt = (
      raw2.prepare(`PRAGMA table_info(question_threads)`).all() as { name: string }[]
    ).some((c) => c.name === 'expires_at')
    expect(hasExpiresAt).toBe(true)
    raw2.close()

    const repaired = db!.getMessageById('msg_m3stranded1')
    expect(repaired?.to_handle).toBe('agent:agt_m3target01')
  })

  it('F7a: a stranded name-addressed row (recipient_pane_key NULL, unread) migrates to agent:<id> once that name registers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-f7a-repair-'))
    dbPath = join(tempDir, 'orca.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const raw = new Database(dbPath)
    raw.pragma('user_version = 37')
    raw
      .prepare(
        `INSERT INTO agents (id, display_name, origin_kind, origin_host_id)
         VALUES ('agt_f7atarget01', 'bob', 'pane', 'local')`
      )
      .run()
    // Stranded: to_handle is the bare display name, never re-minted to agent:<id> (F7a defect).
    raw
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, body, type, priority, read, recipient_pane_key)
         VALUES ('msg_stranded001', 'run_legacy_local', 'someone', 'bob', 'hi', 'hi there', 'status', 'normal', 0, NULL)`
      )
      .run()
    // A row that must NOT be touched: already read.
    raw
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, body, type, priority, read, recipient_pane_key)
         VALUES ('msg_readalready1', 'run_legacy_local', 'someone', 'bob', 'hi', 'already read', 'status', 'normal', 1, NULL)`
      )
      .run()
    raw.close()

    db = new OrchestrationDb(dbPath)
    const repaired = db.getMessageById('msg_stranded001')
    expect(repaired?.to_handle).toBe('agent:agt_f7atarget01')
    const untouched = db.getMessageById('msg_readalready1')
    expect(untouched?.to_handle).toBe('bob')
  })
})
