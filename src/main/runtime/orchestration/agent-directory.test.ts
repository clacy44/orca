import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import {
  classifyAgentLiveness,
  getAgentById,
  getAgentByName,
  listAgents,
  refreshAgentLiveness,
  setAgentQuarantine,
  upsertAgentByPaneSuffix,
  writeAgentAudit,
  type UpsertAgentByPaneSuffixParams
} from './agent-directory'
import { getAgentByIdIncludingTombstoned, retireAgent } from './agent-retire'

describe('agent-directory', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function baseParams(
    overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
  ): UpsertAgentByPaneSuffixParams {
    return {
      displayName: 'merge-restructure-backend',
      role: 'backend for the merge restructure',
      hostId: 'local',
      paneKey: 'tab1:leaf-aaa',
      terminalHandle: 'term_a',
      processIncarnation: 'inc1',
      worktreeId: 'wt1',
      worktreePath: '/wt/merge-restructure',
      branch: 'merge-restructure',
      title: 'sanitized title',
      agentLabel: 'Claude Code',
      originHandle: 'term_a',
      originHostId: 'local',
      ...overrides
    }
  }

  describe('upsertAgentByPaneSuffix', () => {
    it('R4: register twice from one pane -> created then reminted, same id, same registered_at, new terminal_handle', () => {
      const db = rawDb()
      const first = upsertAgentByPaneSuffix(db, baseParams())
      expect(first.outcome).toBe('created')
      const createdAgent = first.outcome === 'created' ? first.agent : undefined
      expect(createdAgent).toBeDefined()

      const second = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_a_new' }))
      expect(second.outcome).toBe('reminted')
      const remintedAgent = second.outcome === 'reminted' ? second.agent : undefined
      expect(remintedAgent?.id).toBe(createdAgent?.id)
      expect(remintedAgent?.registered_at).toBe(createdAgent?.registered_at)
      expect(remintedAgent?.terminal_handle).toBe('term_a_new')
    })

    it('R5: pane moves tabs (tabId changes, leaf stable) -> same row via suffix match', () => {
      const db = rawDb()
      const first = upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      const createdAgent = first.outcome === 'created' ? first.agent : undefined
      const second = upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab2:leaf-aaa' }))
      expect(second.outcome).toBe('reminted')
      const remintedAgent = second.outcome === 'reminted' ? second.agent : undefined
      expect(remintedAgent?.id).toBe(createdAgent?.id)
      expect(remintedAgent?.pane_key).toBe('tab2:leaf-aaa')
    })

    it('refuses a name collision with a live/registered holder (name_taken, never silently renames)', () => {
      const db = rawDb()
      upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      const collision = upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab1:leaf-bbb', terminalHandle: 'term_b' })
      )
      expect(collision.outcome).toBe('name_taken')
      if (collision.outcome === 'name_taken') {
        expect(collision.alternative).not.toBe('merge-restructure-backend')
        expect(collision.alternative.length).toBeGreaterThan(0)
      }
    })

    it('T1 (S10-11 R1): dead-pane name collision rebinds in place — same id, mailbox follows, reMinted', () => {
      const db = rawDb()
      const first = upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      const originalId = first.outcome === 'created' ? first.agent.id : ''
      db.prepare(
        `INSERT INTO messages (id, from_handle, to_handle, subject) VALUES ('msg_1', 'peer', ?, 'while you were away')`
      ).run(`agent:${originalId}`)

      // A full relaunch: brand-new pane suffix (not just a new terminal_handle on the old
      // pane), the exact shape findByPaneSuffix cannot match. The old pane is confirmed dead.
      const rebind = upsertAgentByPaneSuffix(
        db,
        baseParams({
          paneKey: 'tab9:leaf-relaunched',
          terminalHandle: 'term_relaunched',
          isPaneLive: () => false
        })
      )
      expect(rebind.outcome).toBe('reminted')
      if (rebind.outcome === 'reminted') {
        expect(rebind.agent.id).toBe(originalId)
        expect(rebind.agent.pane_key).toBe('tab9:leaf-relaunched')
        expect(rebind.agent.terminal_handle).toBe('term_relaunched')
      }
      // Mail addressed to the durable id is untouched — it was never on a bare handle.
      expect(db.prepare('SELECT to_handle FROM messages WHERE id = ?').get('msg_1')).toEqual({
        to_handle: `agent:${originalId}`
      })

      // Only one row for this name — never a second, anonymous identity left behind.
      const rows = db
        .prepare('SELECT id FROM agents WHERE host_id = ? AND display_name = ?')
        .all('local', 'merge-restructure-backend') as { id: string }[]
      expect(rows).toEqual([{ id: originalId }])
    })

    it('T2 (S10-11 R1): a name held by a genuinely LIVE pane still refuses name_taken, naming the live pane', () => {
      const db = rawDb()
      upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_live' })
      )

      const collision = upsertAgentByPaneSuffix(
        db,
        baseParams({
          paneKey: 'tab9:leaf-newcomer',
          terminalHandle: 'term_newcomer',
          isPaneLive: (paneKey) => paneKey === 'tab1:leaf-aaa'
        })
      )
      expect(collision.outcome).toBe('name_taken')
      if (collision.outcome === 'name_taken') {
        expect(collision.livePaneKey).toBe('tab1:leaf-aaa')
        expect(collision.liveTerminalHandle).toBe('term_live')
      }
      // Never a raw INSERT / constraint failure, and never a second anonymous row for the name.
      const rows = db
        .prepare('SELECT id FROM agents WHERE host_id = ? AND display_name = ?')
        .all('local', 'merge-restructure-backend') as { id: string }[]
      expect(rows).toHaveLength(1)
    })

    it('omitting isPaneLive defaults conservative (assumed live -> name_taken, never a mistaken rebind)', () => {
      const db = rawDb()
      upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      const collision = upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab9:leaf-newcomer', terminalHandle: 'term_newcomer' })
      )
      expect(collision.outcome).toBe('name_taken')
    })

    it('a quarantined name holder stays locked regardless of pane liveness (existing semantics)', () => {
      const db = rawDb()
      const first = upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      const holderId = first.outcome === 'created' ? first.agent.id : ''
      db.prepare('UPDATE agents SET quarantined = 1 WHERE id = ?').run(holderId)

      const collision = upsertAgentByPaneSuffix(
        db,
        baseParams({
          paneKey: 'tab9:leaf-newcomer',
          terminalHandle: 'term_newcomer',
          isPaneLive: () => false // even a confirmed-dead pane must not reclaim a quarantined name
        })
      )
      expect(collision.outcome).toBe('name_taken')
      if (collision.outcome === 'name_taken') {
        expect(collision.livePaneKey).toBeNull()
        expect(collision.liveTerminalHandle).toBeNull()
      }
    })

    it("T3 (S10-11 R2): retire then re-register (fresh successor id) adopts the tombstoned predecessor's thread membership", () => {
      const db = rawDb()
      const first = upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      const predecessorId = first.outcome === 'created' ? first.agent.id : ''
      const { thread } = orchestrationDb!.createThread({
        subject: 'merge plan',
        createdByAgentId: predecessorId,
        participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
      })

      db.prepare(
        `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL WHERE id = ?`
      ).run(predecessorId)

      // A fresh pane re-registers the same name after the predecessor is gone (findByName
      // excludes tombstoned rows, so this is the ordinary 'created' path, not a rebind).
      const successor = upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab9:leaf-newcomer', terminalHandle: 'term_newcomer' })
      )
      expect(successor.outcome).toBe('created')
      if (successor.outcome !== 'created') {
        return
      }
      expect(successor.agent.id).not.toBe(predecessorId)
      expect(successor.adoptedThreads).toBe(1)

      const participant = db
        .prepare('SELECT participant_key, agent_id FROM thread_participants WHERE thread_id = ?')
        .get(thread.id) as { participant_key: string; agent_id: string }
      expect(participant.participant_key).toBe(successor.agent.id)
      expect(participant.agent_id).toBe(successor.agent.id)
    })

    it('adoptedThreads is 0 when no tombstoned predecessor shares the name', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams({ paneKey: 'tab1:leaf-aaa' }))
      expect(created.outcome).toBe('created')
      if (created.outcome === 'created') {
        expect(created.adoptedThreads).toBe(0)
      }
    })

    it('reclaims a name held by a gone+derived row (tombstones it, then inserts fresh)', () => {
      const db = rawDb()
      const derivedHolder = upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab1:leaf-aaa', role: null })
      )
      const holderId = derivedHolder.outcome === 'created' ? derivedHolder.agent.id : ''
      // Simulate a derived, gone row (as the RPC/derivation layer would produce).
      db.prepare("UPDATE agents SET derived = 1, state = 'gone' WHERE id = ?").run(holderId)

      const reclaimed = upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab2:leaf-ccc', terminalHandle: 'term_c' })
      )
      expect(reclaimed.outcome).toBe('created')
      if (reclaimed.outcome === 'created') {
        expect(reclaimed.agent.id).not.toBe(holderId)
        expect(reclaimed.agent.display_name).toBe('merge-restructure-backend')
      }
      const oldHolder = db.prepare('SELECT * FROM agents WHERE id = ?').get(holderId) as
        | { tombstoned_at: string | null }
        | undefined
      expect(oldHolder?.tombstoned_at).not.toBeNull()
    })
  })

  describe('mailbox repoint on re-mint (S10-7 F-C)', () => {
    function unreadCountFor(db: Database.Database, toHandle: string): number {
      return (
        db
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE to_handle = ? AND read = 0')
          .get(toHandle) as { n: number }
      ).n
    }

    // Fast bulk insert for backlog-sized fixtures — insertMessage() prepares a fresh statement
    // per call, too slow for thousands of rows. Defaults (run_id, delivery_contract,
    // body/type/priority) match insertMessage's own defaults.
    function bulkInsertUnread(db: Database.Database, toHandle: string, count: number): void {
      const stmt = db.prepare(
        `INSERT INTO messages (id, from_handle, to_handle, subject) VALUES (?, 'peer', ?, ?)`
      )
      db.exec('BEGIN')
      for (let i = 0; i < count; i += 1) {
        stmt.run(`msg_bulk_${toHandle}_${i}`, toHandle, `msg${i}`)
      }
      db.exec('COMMIT')
    }

    it('repoints unread bare-handle mail from the old terminal_handle into agent:<id>, reports the count, and audits it', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_old' }))
      const id = created.outcome === 'created' ? created.agent.id : ''

      orchestrationDb!.insertMessage({ from: 'peer', to: 'term_old', subject: 'msg1' })
      const readAlready = orchestrationDb!.insertMessage({
        from: 'peer',
        to: 'term_old',
        subject: 'already read'
      })
      db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(readAlready.id)
      orchestrationDb!.insertMessage({ from: 'peer', to: 'term_old', subject: 'msg2' })
      orchestrationDb!.insertMessage({ from: 'peer', to: 'term_unrelated', subject: 'not mine' })

      // Re-mint: same pane, terminal_handle changes (pane relaunch).
      const reminted = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_new' }))
      expect(reminted.outcome).toBe('reminted')
      if (reminted.outcome === 'reminted') {
        expect(reminted.repointedMessages).toBe(2)
        expect(reminted.pendingOnOldHandle).toBe(0)
      }

      expect(unreadCountFor(db, `agent:${id}`)).toBe(2)
      expect(unreadCountFor(db, 'term_old')).toBe(0) // the two unread rows moved
      expect(
        (
          db.prepare('SELECT to_handle FROM messages WHERE id = ?').get(readAlready.id) as {
            to_handle: string
          }
        ).to_handle
      ).toBe('term_old') // already-read mail is left alone
      expect(unreadCountFor(db, 'term_unrelated')).toBe(1) // untouched

      const audit = db
        .prepare("SELECT * FROM agent_audit WHERE verb = 'mailbox_repoint'")
        .all() as { agent_id: string; outcome: string }[]
      expect(audit).toHaveLength(1)
      expect(audit[0]?.agent_id).toBe(id)
      expect(audit[0]?.outcome).toBe('ok')
    })

    it('does nothing and audits nothing when terminal_handle is unchanged across a re-mint', () => {
      const db = rawDb()
      upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_stable' }))
      orchestrationDb!.insertMessage({ from: 'peer', to: 'term_stable', subject: 'msg1' })

      const reminted = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_stable' }))
      expect(reminted.outcome).toBe('reminted')
      if (reminted.outcome === 'reminted') {
        expect(reminted.repointedMessages).toBe(0)
        expect(reminted.pendingOnOldHandle).toBe(0)
      }
      expect(unreadCountFor(db, 'term_stable')).toBe(1) // left in place
      const audit = db.prepare("SELECT * FROM agent_audit WHERE verb = 'mailbox_repoint'").all()
      expect(audit).toHaveLength(0)
    })

    // REGRESSION (F-C major): a backlog bigger than one MAILBOX_REPOINT_BATCH_SIZE (200) used
    // to strand everything past the 200th row on the old handle forever — nothing else ever
    // remembers that handle once this transaction commits. The repoint now loops batches within
    // the same re-mint call to drain the backlog in full.
    it('drains a backlog spanning multiple batches in one re-mint, leaving nothing on the old handle', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_flood' }))
      const id = created.outcome === 'created' ? created.agent.id : ''
      bulkInsertUnread(db, 'term_flood', 205)

      const reminted = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_flood_2' }))
      expect(reminted.outcome).toBe('reminted')
      if (reminted.outcome === 'reminted') {
        expect(reminted.repointedMessages).toBe(205)
        expect(reminted.pendingOnOldHandle).toBe(0)
      }
      expect(unreadCountFor(db, `agent:${id}`)).toBe(205)
      expect(unreadCountFor(db, 'term_flood')).toBe(0)
    })

    // REGRESSION (F-C major): a backlog past the defensive per-call ceiling (bounds pathological
    // inline work) is reported honestly via pendingOnOldHandle rather than silently dropped —
    // and those rows are genuinely gone from any documented read path once this commits, so the
    // count must reflect that, not a false "still reachable at the old handle" promise.
    it('reports a truthful pendingOnOldHandle when a backlog exceeds the per-call ceiling', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_megaflood' }))
      const id = created.outcome === 'created' ? created.agent.id : ''
      bulkInsertUnread(db, 'term_megaflood', 2005)

      const reminted = upsertAgentByPaneSuffix(
        db,
        baseParams({ terminalHandle: 'term_megaflood_2' })
      )
      expect(reminted.outcome).toBe('reminted')
      if (reminted.outcome === 'reminted') {
        expect(reminted.repointedMessages).toBe(2000)
        expect(reminted.pendingOnOldHandle).toBe(5)
      }
      expect(unreadCountFor(db, `agent:${id}`)).toBe(2000)
      expect(unreadCountFor(db, 'term_megaflood')).toBe(5)
    })

    // REGRESSION (F-C major): moving a legacy_direct row off its bare handle breaks the
    // handle-keyed legacy lookups (findLegacyWorkerCompletion, promoteLegacyCoordinatorMailFor
    // Takeover) it depends on, for a mailbox no current_delivery read path ever surfaces it
    // from anyway.
    it('leaves legacy_direct mail on the old handle untouched', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_legacy' }))
      const id = created.outcome === 'created' ? created.agent.id : ''
      orchestrationDb!.insertMessage({
        from: 'peer',
        to: 'term_legacy',
        subject: 'legacy worker_done',
        deliveryContract: 'legacy_direct'
      })
      orchestrationDb!.insertMessage({ from: 'peer', to: 'term_legacy', subject: 'ordinary mail' })

      const reminted = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_legacy_2' }))
      expect(reminted.outcome).toBe('reminted')
      if (reminted.outcome === 'reminted') {
        expect(reminted.repointedMessages).toBe(1) // only the current_delivery row moves
        expect(reminted.pendingOnOldHandle).toBe(0) // legacy_direct isn't "pending" — it's not repointable at all
      }
      expect(unreadCountFor(db, `agent:${id}`)).toBe(1)
      expect(unreadCountFor(db, 'term_legacy')).toBe(1) // the legacy_direct row stays put
      const stillLegacy = db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE to_handle = ? AND delivery_contract = 'legacy_direct'"
        )
        .get('term_legacy') as { n: number }
      expect(stillLegacy.n).toBe(1)
    })

    // REGRESSION (F-C minor): a purged-but-unread row (purge doesn't set read) is unreadable
    // everywhere and must neither be moved nor counted — moving it wastes a batch slot on mail
    // nobody can ever see, and counting it made repointedMessages lie about what actually
    // became reachable.
    it('leaves purged-but-unread mail on the old handle and excludes it from the count', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_purged' }))
      const id = created.outcome === 'created' ? created.agent.id : ''
      const purged = orchestrationDb!.insertMessage({
        from: 'peer',
        to: 'term_purged',
        subject: 'to be purged'
      })
      db.prepare("UPDATE messages SET purged_at = datetime('now') WHERE id = ?").run(purged.id)
      orchestrationDb!.insertMessage({ from: 'peer', to: 'term_purged', subject: 'ordinary mail' })

      const reminted = upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: 'term_purged_2' }))
      expect(reminted.outcome).toBe('reminted')
      if (reminted.outcome === 'reminted') {
        expect(reminted.repointedMessages).toBe(1)
      }
      expect(unreadCountFor(db, `agent:${id}`)).toBe(1)
      expect(
        (
          db.prepare('SELECT to_handle FROM messages WHERE id = ?').get(purged.id) as {
            to_handle: string
          }
        ).to_handle
      ).toBe('term_purged')
    })
  })

  describe('reads filter tombstoned_at', () => {
    it('getAgentById / getAgentByName / listAgents never return a tombstoned row', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''
      db.prepare("UPDATE agents SET tombstoned_at = datetime('now') WHERE id = ?").run(id)

      expect(getAgentById(db, id)).toBeUndefined()
      expect(getAgentByName(db, 'local', 'merge-restructure-backend')).toBeUndefined()
      expect(
        listAgents(db, { includeQuarantined: true }).agents.find((a) => a.id === id)
      ).toBeUndefined()
    })

    // Mutation proof: removing "AND tombstoned_at IS NULL" from any of these reads would
    // resurrect a purged row (CONTAINMENT #8) into find/list/get output.
    it('MUTATION PROOF: tombstoned rows never resurface even when they are the only row', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''
      db.prepare("UPDATE agents SET tombstoned_at = datetime('now') WHERE id = ?").run(id)
      const result = listAgents(db, { includeQuarantined: true, includeDerived: true })
      expect(result.agents).toHaveLength(0)
    })
  })

  describe('refreshAgentLiveness', () => {
    it('rewrites state, terminal_handle, process_incarnation, and bumps last_seen_at', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''
      const before = getAgentById(db, id)

      const updated = refreshAgentLiveness(db, {
        id,
        state: 'live',
        terminalHandle: 'term_remint',
        processIncarnation: 'inc_remint'
      })

      expect(updated.state).toBe('live')
      expect(updated.terminal_handle).toBe('term_remint')
      expect(updated.process_incarnation).toBe('inc_remint')
      expect(updated.last_seen_at >= (before?.last_seen_at ?? '')).toBe(true)
    })

    it('throws agent_unknown for a tombstoned or missing id (never silently no-ops)', () => {
      const db = rawDb()
      expect(() =>
        refreshAgentLiveness(db, {
          id: 'agt_does_not_exist',
          state: 'gone',
          terminalHandle: null,
          processIncarnation: null
        })
      ).toThrow(/not found/)
    })
  })

  describe('quarantine', () => {
    it('setAgentQuarantine sets/lifts the flag and reason code, respected by listAgents omission', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''

      const quarantined = setAgentQuarantine(db, {
        id,
        quarantined: true,
        reasonCode: 'suspicious_role'
      })
      expect(quarantined.quarantined).toBe(1)
      expect(quarantined.quarantine_reason_code).toBe('suspicious_role')
      expect(quarantined.quarantined_at).not.toBeNull()

      const defaultList = listAgents(db)
      expect(defaultList.agents.find((a) => a.id === id)).toBeUndefined()
      expect(defaultList.omitted.quarantined).toBe(1)

      const withQuarantined = listAgents(db, { includeQuarantined: true })
      expect(withQuarantined.agents.find((a) => a.id === id)).toBeDefined()

      const lifted = setAgentQuarantine(db, { id, quarantined: false, reasonCode: null })
      expect(lifted.quarantined).toBe(0)
      expect(lifted.quarantined_at).toBeNull()
    })
  })

  describe('retireAgent (S10-7 F-B)', () => {
    it('tombstones the row and frees its display_name for a fresh registration', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''

      const result = retireAgent(db, id)
      expect(result.outcome).toBe('retired')
      expect(result.agent.tombstoned_at).not.toBeNull()
      expect(getAgentById(db, id)).toBeUndefined() // filtered read never sees it
      expect(getAgentByIdIncludingTombstoned(db, id)?.tombstoned_at).not.toBeNull()

      // Name reclaim: register.ts's findByName-based uniqueness check is unaffected by the
      // presence of the tombstoned row (idx_agents_name is WHERE tombstoned_at IS NULL).
      const reclaimed = upsertAgentByPaneSuffix(
        db,
        baseParams({ paneKey: 'tab2:leaf-zzz', terminalHandle: 'term_zzz' })
      )
      expect(reclaimed.outcome).toBe('created')
      if (reclaimed.outcome === 'created') {
        expect(reclaimed.agent.id).not.toBe(id)
        expect(reclaimed.agent.display_name).toBe('merge-restructure-backend')
      }
    })

    it('idempotent: retiring an already-tombstoned id returns already_retired, never throws', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''
      const first = retireAgent(db, id)
      expect(first.outcome).toBe('retired')
      const second = retireAgent(db, id)
      expect(second.outcome).toBe('already_retired')
      expect(second.agent.id).toBe(id)
    })

    it('throws agent_unknown for an id that never existed', () => {
      const db = rawDb()
      expect(() => retireAgent(db, 'agt_does_not_exist')).toThrow(/not found/)
    })
  })

  describe('provenance immutability (trigger-enforced, exercised through the DB method surface)', () => {
    it('re-mint never changes origin_* or registered_at even across many re-mints', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const originalAgent = created.outcome === 'created' ? created.agent : undefined
      for (let i = 0; i < 3; i += 1) {
        upsertAgentByPaneSuffix(db, baseParams({ terminalHandle: `term_${i}` }))
      }
      const finalRow = getAgentById(db, originalAgent?.id ?? '')
      expect(finalRow?.origin_pane_key).toBe(originalAgent?.origin_pane_key)
      expect(finalRow?.origin_host_id).toBe(originalAgent?.origin_host_id)
      expect(finalRow?.registered_at).toBe(originalAgent?.registered_at)
    })
  })

  describe('writeAgentAudit', () => {
    it('inserts an append-only row with actor/verb/outcome', () => {
      const db = rawDb()
      const created = upsertAgentByPaneSuffix(db, baseParams())
      const id = created.outcome === 'created' ? created.agent.id : ''
      const row = writeAgentAudit(db, {
        agentId: id,
        actorPaneKey: 'tab1:leaf-aaa',
        actorHostId: 'local',
        verb: 'register',
        outcome: 'created',
        reasonCode: null
      })
      expect(row.agent_id).toBe(id)
      expect(row.verb).toBe('register')
      expect(row.outcome).toBe('created')
    })
  })

  // checkAndBumpRate now lives in ./agent-rate-limit.ts — see agent-rate-limit.test.ts.
})

describe('classifyAgentLiveness', () => {
  const now = '2026-08-30T12:00:00.000Z'

  it('gone: pane does not resolve and last_seen_at is stale (>15min)', () => {
    const result = classifyAgentLiveness({
      paneResolves: false,
      lastAgentStatus: null,
      observedLive: false,
      lastSeenAt: '2026-08-30T11:00:00.000Z',
      now
    })
    expect(result).toEqual({ state: 'gone', pushable: false })
  })

  it('idle grace period: pane does not resolve but last_seen_at is recent', () => {
    const result = classifyAgentLiveness({
      paneResolves: false,
      lastAgentStatus: null,
      observedLive: false,
      lastSeenAt: '2026-08-30T11:59:00.000Z',
      now
    })
    expect(result).toEqual({ state: 'idle', pushable: false })
  })

  it('live: pane resolves, status working/permission, observed live', () => {
    for (const status of ['working', 'permission'] as const) {
      expect(
        classifyAgentLiveness({
          paneResolves: true,
          lastAgentStatus: status,
          observedLive: true,
          lastSeenAt: now,
          now
        })
      ).toEqual({ state: 'live', pushable: false })
    }
  })

  it('idle + pushable: pane resolves, status idle, observed live (the ambient-push gate)', () => {
    expect(
      classifyAgentLiveness({
        paneResolves: true,
        lastAgentStatus: 'idle',
        observedLive: true,
        lastSeenAt: now,
        now
      })
    ).toEqual({ state: 'idle', pushable: true })
  })

  it('cold restore: observedLive=false reports idle, never live, never pushable', () => {
    expect(
      classifyAgentLiveness({
        paneResolves: true,
        lastAgentStatus: 'working',
        observedLive: false,
        lastSeenAt: now,
        now
      })
    ).toEqual({ state: 'idle', pushable: false })
    expect(
      classifyAgentLiveness({
        paneResolves: true,
        lastAgentStatus: 'idle',
        observedLive: false,
        lastSeenAt: now,
        now
      })
    ).toEqual({ state: 'idle', pushable: false })
  })

  // Mutation proof: dropping the observedLive check would let a cold-restored 'working' pane
  // report `live`/pushable, exactly the bug the spec's Why comment (orca-runtime.ts:33524-33530)
  // warns against.
  it('MUTATION PROOF: guard fails if the observedLive gate is skipped', () => {
    const coldRestore = classifyAgentLiveness({
      paneResolves: true,
      lastAgentStatus: 'working',
      observedLive: false,
      lastSeenAt: now,
      now
    })
    expect(coldRestore.state).not.toBe('live')
    expect(coldRestore.pushable).toBe(false)
  })
})
