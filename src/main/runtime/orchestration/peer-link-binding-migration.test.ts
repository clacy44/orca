import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

const SIX_TABLES = [
  'peer_link_bindings',
  'peer_link_attempts',
  'peer_link_scan_facts',
  'peer_link_confirm_observations',
  'peer_link_containment',
  'peer_reply_outbox'
]

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function hasTable(sqlite: Database.Database, table: string): boolean {
  return (
    sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  )
}

describe('S10-16 C2: schema v40 migration and repair', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined
  let dbPath: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  function freshPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-link-binding-migration-'))
    dbPath = join(tempDir, 'orchestration.db')
    return dbPath
  }

  it('a v38-stamped fixture opens to user_version 40 with all six tables (and S10-19 v39 tables)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    const oldDb = new Database(path)
    for (const table of SIX_TABLES) {
      oldDb.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    oldDb.exec(`DROP TABLE IF EXISTS peer_run_grants`)
    oldDb.pragma('user_version = 38')
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(40)
    for (const table of SIX_TABLES) {
      expect(hasTable(sqlite, table)).toBe(true)
    }
    expect(hasTable(sqlite, 'peer_run_grants')).toBe(true)
  })

  it('a v39-stamped fixture opens to 40', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    const oldDb = new Database(path)
    for (const table of SIX_TABLES) {
      oldDb.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    oldDb.pragma('user_version = 39')
    oldDb.close()

    db = new OrchestrationDb(path)
    expect(rawDb(db).pragma('user_version', { simple: true })).toBe(40)
    for (const table of SIX_TABLES) {
      expect(hasTable(rawDb(db), table)).toBe(true)
    }
  })

  it('a v40-stamped DB with peer_link_bindings entirely absent is re-created', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec(`DROP TABLE peer_link_bindings`)
    oldDb.close()

    db = new OrchestrationDb(path)
    expect(hasTable(rawDb(db), 'peer_link_bindings')).toBe(true)
  })

  it('a missing binding column is repaired by nullable ALTER; revoked_at and contest_incident_id on existing rows survive', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putPeerLinkBinding({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })
    db.contestPeerLinkBinding('link1', 2000, 'incident1', 'detail', {
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1'
    })
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec(
      `ALTER TABLE peer_link_bindings RENAME COLUMN scan_completeness TO scan_completeness_old`
    )
    oldDb.close()

    db = new OrchestrationDb(path)
    expect(hasTable(rawDb(db), 'peer_link_bindings')).toBe(true)
    const row = db.getPeerLinkBinding('link1')
    expect(row).not.toBeNull()
    expect(row?.contestIncidentId).toBe('incident1')
    expect(row?.contestedAt).toBe(2000)
  })

  it('a missing NOT-NULL binding column that cannot be back-filled marks the row revoked (never deleted)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putPeerLinkBinding({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })
    db.close()
    db = undefined

    // Simulate an earlier in-review build that never wrote proof_protocol (drops the column).
    const oldDb = new Database(path)
    oldDb.exec(`ALTER TABLE peer_link_bindings DROP COLUMN proof_protocol`)
    oldDb.close()

    db = new OrchestrationDb(path)
    const row = db.getPeerLinkBinding('link1')
    expect(row).not.toBeNull()
    expect(row?.state).toBe('revoked')
    expect(row?.revokedAt).not.toBeNull()
  })

  it('a missing peer_link_containment column is repaired by ALTER and existing rows survive', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link1',
      action: 'quarantine',
      reasonCode: 'operator',
      reasonText: 'testing',
      detail: null,
      createdAt: 1000,
      expiresAt: null
    })
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec(`ALTER TABLE peer_link_containment RENAME COLUMN reason_text TO reason_text_old`)
    oldDb.close()

    db = new OrchestrationDb(path)
    expect(hasTable(rawDb(db), 'peer_link_containment')).toBe(true)
    expect(db.listContainment()).toHaveLength(1)
    expect(db.listContainment()[0]?.subjectId).toBe('link1')
  })

  it('a missing peer_reply_outbox column is repaired by ALTER and queued items survive', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.enqueueReplyOutbox({
      localMessageId: 'msg1',
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundPairingRevision: 1,
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      inReplyToMessageId: 'orig1',
      peerAgentId: 'agent1',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: 1000
    })
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec(`ALTER TABLE peer_reply_outbox RENAME COLUMN last_error TO last_error_old`)
    oldDb.close()

    db = new OrchestrationDb(path)
    expect(hasTable(rawDb(db), 'peer_reply_outbox')).toBe(true)
    expect(db.listReplyOutbox()).toHaveLength(1)
    expect(db.listReplyOutbox()[0]?.state).toBe('queued')
  })

  // Ruling 28(j)/ML-5: the v40 outbox repair's CHECK-rejection fallback. A pre-review build's
  // `state` CHECK (no 'abandoned' member) rejects the repair's primary UPDATE; the fallback
  // settles the row terminal through settled_at/last_error_code alone, with the code
  // repair_rejected — never the far-future next_attempt_after hack, and never the primary path's
  // own 'incomplete_row_fail_closed' code (which would falsely claim the write succeeded as
  // described).
  it('the outbox repair CHECK-rejection fallback settles an incomplete row with repair_rejected, settled_at stamped, state left alone', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.close()
    db = undefined

    const oldDb = new Database(path)
    oldDb.exec('DROP TABLE peer_reply_outbox')
    // A pre-review build's shape: `payload` nullable (so an incomplete row is representable at
    // all) and `state`'s CHECK missing 'abandoned' — the exact precondition the fallback exists
    // for.
    oldDb.exec(`
      CREATE TABLE peer_reply_outbox (
        id                       TEXT PRIMARY KEY,
        seq                      INTEGER NOT NULL,
        local_message_id         TEXT NOT NULL UNIQUE,
        link_device_id           TEXT NOT NULL,
        environment_id           TEXT NOT NULL,
        bound_pairing_revision   INTEGER NOT NULL,
        peer_credential_fp       TEXT NOT NULL,
        peer_key_fingerprint     TEXT NOT NULL,
        in_reply_to_message_id   TEXT NOT NULL,
        peer_agent_id            TEXT NOT NULL,
        peer_thread_id           TEXT,
        local_thread_id          TEXT,
        notice_run_id            TEXT,
        notice_pane_key          TEXT,
        payload                  TEXT,
        byte_count               INTEGER NOT NULL,
        state                    TEXT NOT NULL DEFAULT 'queued'
          CHECK(state IN ('queued','sending','delivered','refused','cancelled')),
        created_at               INTEGER NOT NULL
      )
    `)
    oldDb
      .prepare(
        `INSERT INTO peer_reply_outbox (
           id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
           peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
           payload, byte_count, state, created_at
         ) VALUES (?, 1, 'msg_repair_rejected', 'link_rr', 'env_rr', 1, 'pfp', 'pkf', 'orig_rr',
                   'agent_rr', NULL, 0, 'queued', 1000)`
      )
      .run('outbox_repair_rejected_1')
    oldDb.close()

    db = new OrchestrationDb(path)
    const sqlite = rawDb(db)
    const row = sqlite
      .prepare(
        `SELECT state, settled_at, last_error_code, next_attempt_after
           FROM peer_reply_outbox WHERE id = ?`
      )
      .get('outbox_repair_rejected_1') as {
      state: string
      settled_at: number | null
      last_error_code: string | null
      next_attempt_after: number | null
    }
    // state is untouched (the CHECK rejected the write that would have changed it) —
    // settled_at/last_error_code are the columns no CHECK constrains, and are what carry the
    // "this row is terminal" fact from here on.
    expect(row.state).toBe('queued')
    expect(row.settled_at).not.toBeNull()
    expect(row.last_error_code).toBe('repair_rejected')
    // No far-future next_attempt_after hack — settled_at alone is now what every ML-5 consumer
    // (the claim, the kick, the cap, health) treats as terminal.
    expect(row.next_attempt_after).toBeNull()

    // ML-5: the zombie is invisible to the per-link cap and to the wake computation.
    expect(db.countPendingReplyOutbox('link_rr')).toBe(0)
    expect(db.nextReplyOutboxWakeAt()).toBeNull()

    // The audit row names the fallback's own code, not the primary path's.
    const audit = sqlite
      .prepare(
        `SELECT reason_code FROM agent_audit
           WHERE verb = 'link_binding_unshipped_v40_repair' AND actor_host_id = ?`
      )
      .get('outbox_repair_rejected_1') as { reason_code: string } | undefined
    expect(audit?.reason_code).toBe('repair_rejected')
  })

  for (const table of [
    'peer_link_attempts',
    'peer_link_scan_facts',
    'peer_link_confirm_observations'
  ]) {
    it(`a ${table} shaped without an expected column is repaired by drop-and-recreate`, () => {
      const path = freshPath()
      db = new OrchestrationDb(path)
      db.close()
      db = undefined

      // Simulate an in-review build's narrower shape: drop the real table and recreate it missing
      // one expected column — the repair's hasColumn probe must catch this and DROP + re-create.
      const oldDb = new Database(path)
      oldDb.exec(`DROP TABLE ${table}`)
      oldDb.exec(`CREATE TABLE ${table} (link_device_id TEXT PRIMARY KEY)`)
      oldDb.close()

      db = new OrchestrationDb(path)
      const sqlite = rawDb(db)
      expect(hasTable(sqlite, table)).toBe(true)
      const columns = (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map(
        (c) => c.name
      )
      expect(columns.length).toBeGreaterThan(1)
    })
  }

  it('two bindings naming the same environment_id both insert (no UNIQUE)', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    const base = {
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted' as const,
      scanCompleteness: 'complete' as const,
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    }
    db.putPeerLinkBinding({ ...base, linkDeviceId: 'linkA' })
    db.putPeerLinkBinding({ ...base, linkDeviceId: 'linkB' })
    expect(db.findBindingsByEnvironment('env1')).toHaveLength(2)
  })

  it('resetAll() empties the outbox and confirm observations, and leaves bindings/attempts/facts/containment', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putPeerLinkBinding({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })
    db.putBindingAttempt('link1')
    db.putScanFact({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      outcome: 'proven',
      environmentPairingRevision: 1,
      linkCredentialFp: 'lfp',
      detail: null,
      observedAt: 1000
    })
    db.putConfirmObservation({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      kind: 'peer_confirmed',
      detail: null,
      observedAt: 1000
    })
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link1',
      action: 'quarantine',
      reasonCode: null,
      reasonText: null,
      detail: null,
      createdAt: 1000,
      expiresAt: null
    })
    db.enqueueReplyOutbox({
      localMessageId: 'msg1',
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundPairingRevision: 1,
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      inReplyToMessageId: 'orig1',
      peerAgentId: 'agent1',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: 1000
    })

    db.resetAll()

    expect(db.listReplyOutbox()).toHaveLength(0)
    expect(db.listConfirmObservations('link1')).toHaveLength(0)
    expect(db.getPeerLinkBinding('link1')).not.toBeNull()
    expect(db.getBindingAttempt('link1')).not.toBeNull()
    expect(db.listScanFacts('link1')).toHaveLength(1)
    expect(db.listContainment()).toHaveLength(1)
  })

  it("resetMessages() cancels every 'queued' AND 'sending' outbox row and leaves the five binding tables", () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putPeerLinkBinding({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })
    const id1 = db.enqueueReplyOutbox({
      localMessageId: 'msg1',
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundPairingRevision: 1,
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      inReplyToMessageId: 'orig1',
      peerAgentId: 'agent1',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: 1000
    })
    const claimed = db.claimNextReplyOutboxItem(2000)
    expect(claimed?.id).toBe(id1)
    expect(db.getReplyOutboxItem(id1)?.state).toBe('sending')

    db.resetMessages()

    expect(db.getReplyOutboxItem(id1)?.state).toBe('cancelled')
    expect(db.getPeerLinkBinding('link1')).not.toBeNull()
    expect(db.getBindingAttempt('link1')).toBeNull()
    expect(db.listContainment()).toHaveLength(0)
  })

  it('resetTasks() empties none of the six link-binding tables', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putPeerLinkBinding({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })
    db.enqueueReplyOutbox({
      localMessageId: 'msg1',
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundPairingRevision: 1,
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      inReplyToMessageId: 'orig1',
      peerAgentId: 'agent1',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: 1000
    })

    db.resetTasks()

    expect(db.getPeerLinkBinding('link1')).not.toBeNull()
    expect(db.listReplyOutbox()).toHaveLength(1)
  })

  it('link-forget --all (deleteBindingsAndAttemptsNotIn([])) empties bindings/attempts/facts/confirm-observations, leaves containment', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putPeerLinkBinding({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      boundEndpointId: 'ep1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lfp',
      peerCredentialFp: 'pfp',
      peerKeyFingerprint: 'pkf',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: 1000,
      lastVerifiedAt: 1000
    })
    db.putBindingAttempt('link1')
    db.putScanFact({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      outcome: 'proven',
      environmentPairingRevision: 1,
      linkCredentialFp: 'lfp',
      detail: null,
      observedAt: 1000
    })
    db.putConfirmObservation({
      linkDeviceId: 'link1',
      environmentId: 'env1',
      kind: 'peer_confirmed',
      detail: null,
      observedAt: 1000
    })
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link1',
      action: 'quarantine',
      reasonCode: null,
      reasonText: null,
      detail: null,
      createdAt: 1000,
      expiresAt: null
    })

    db.deleteBindingsAndAttemptsNotIn([])

    expect(db.getPeerLinkBinding('link1')).toBeNull()
    expect(db.getBindingAttempt('link1')).toBeNull()
    expect(db.listScanFacts('link1')).toHaveLength(0)
    expect(db.listConfirmObservations('link1')).toHaveLength(0)
    expect(db.listContainment()).toHaveLength(1)
  })

  it('a containment lift followed by a re-assertion produces one row with lifted_at IS NULL and the latest reason', () => {
    const path = freshPath()
    db = new OrchestrationDb(path)
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link1',
      action: 'quarantine',
      reasonCode: 'operator',
      reasonText: 'first',
      detail: null,
      createdAt: 1000,
      expiresAt: null
    })
    db.liftContainment('link', 'link1', 'quarantine', 2000)
    db.putContainment({
      subjectKind: 'link',
      subjectId: 'link1',
      action: 'quarantine',
      reasonCode: 'operator',
      reasonText: 'second',
      detail: null,
      createdAt: 3000,
      expiresAt: null
    })

    const rows = db.listContainment()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.liftedAt).toBeNull()
    expect(rows[0]?.reasonText).toBe('second')
  })
})
