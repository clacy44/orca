// F-19 (Ruling 33(a)): split out of agent-directory.test.ts to stay under the max-lines
// ratchet — same precedent as this repo's other topic-split test files. Covers B1's
// derived-placeholder reclaim branch in upsertAgentByPaneSuffix (agent-directory.ts).
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { upsertAgentByPaneSuffix, type UpsertAgentByPaneSuffixParams } from './agent-directory'

describe('F-19 (Ruling 33(a)): derived-placeholder reclaim on rename collision', () => {
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

  // A restart mints a derived row bound to THIS pane's suffix (agent-directory-rpc-liveness.ts
  // via agent-directory-rpc-liveness.ts / derived-agent-rows.ts) — simulated directly here the
  // same shape those mint, rather than going through the RPC layer this unit test doesn't have.
  function insertDerivedRow(
    db: Database.Database,
    params: { id: string; paneKey: string; quarantined?: number }
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         origin_kind, origin_pane_key, origin_handle, origin_host_id
       ) VALUES (?, ?, NULL, 'local', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'gone', 1, ?,
         'derived', ?, NULL, 'local')`
    ).run(params.id, params.id, params.paneKey, params.quarantined ?? 0, params.paneKey)
  }

  it('T1: derived row on caller pane + dead-pane name holder -> reminted, id preserved, derived row tombstoned, suffix uniquely held', () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    insertDerivedRow(db, { id: 'agt_derived1', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')
    if (result.outcome === 'reminted') {
      expect(result.agent.id).toBe(holderId)
      expect(result.agent.pane_key).toBe('tab2:leaf-bbb')
      expect(result.agent.derived).toBe(0)
    }
    const derivedRow = db
      .prepare('SELECT tombstoned_at, pane_key FROM agents WHERE id = ?')
      .get('agt_derived1') as { tombstoned_at: string | null; pane_key: string | null }
    expect(derivedRow.tombstoned_at).not.toBeNull()
    expect(derivedRow.pane_key).toBeNull()
    const suffixHolders = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agents
         WHERE tombstoned_at IS NULL AND substr(pane_key, instr(pane_key, ':') + 1) = 'leaf-bbb'`
      )
      .get() as { c: number }
    expect(suffixHolders.c).toBe(1)
  })

  it('T2: unread mail on the derived row is repointed onto the reclaimed id with a mailbox_repoint audit row', () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    insertDerivedRow(db, { id: 'agt_derived2', paneKey: 'tab2:leaf-bbb' })
    db.prepare(
      `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
       VALUES ('msg_derived_mail', 'run_peer_local', 'peer', 'agent:agt_derived2', 'poke', 'status', 'normal', 0)`
    ).run()

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')
    const moved = db
      .prepare(`SELECT to_handle, read FROM messages WHERE id = 'msg_derived_mail'`)
      .get() as { to_handle: string; read: number }
    expect(moved.to_handle).toBe(`agent:${holderId}`)
    const audit = db
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'mailbox_repoint' ORDER BY seq DESC LIMIT 1`
      )
      .get(holderId) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('succession')
    expect(audit?.reason_code).toContain('agt_derived2')
  })

  it('T3: derived row + LIVE name holder -> name_taken, holderPaneDead false', () => {
    const db = rawDb()
    upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    insertDerivedRow(db, { id: 'agt_derived3', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: (paneKey) => paneKey === 'tab1:leaf-aaa'
      })
    )
    expect(result.outcome).toBe('name_taken')
    if (result.outcome === 'name_taken') {
      expect(result.holderPaneDead).toBe(false)
    }
    const derivedRow = db
      .prepare('SELECT tombstoned_at FROM agents WHERE id = ?')
      .get('agt_derived3') as { tombstoned_at: string | null }
    expect(derivedRow.tombstoned_at).toBeNull()
  })

  it('T4a: a quarantined name holder still refuses even when the caller pane is derived', () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''
    db.prepare('UPDATE agents SET quarantined = 1 WHERE id = ?').run(holderId)
    insertDerivedRow(db, { id: 'agt_derived4', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('name_taken')
    const derivedRow = db
      .prepare('SELECT tombstoned_at FROM agents WHERE id = ?')
      .get('agt_derived4') as { tombstoned_at: string | null }
    expect(derivedRow.tombstoned_at).toBeNull()
  })

  it('T4b: a quarantined derived row on the caller pane still refuses (never reclaims through a locked row)', () => {
    const db = rawDb()
    upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    insertDerivedRow(db, { id: 'agt_derived5', paneKey: 'tab2:leaf-bbb', quarantined: 1 })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('name_taken')
    const derivedRow = db
      .prepare('SELECT tombstoned_at FROM agents WHERE id = ?')
      .get('agt_derived5') as { tombstoned_at: string | null }
    expect(derivedRow.tombstoned_at).toBeNull()
  })

  // F-1 (attacker-lens review, Ruling 33(a) H6a): the name holder itself can have its OWN
  // tombstoned same-name predecessor (a THIRD row, from before the holder was ever minted) —
  // disjoint from the derived row's id-keyed adoption above, and only reachable via
  // remintRow's own name-keyed adoptPredecessorThreadMembership. Before this fix, remintRow was
  // always called with succession defaulted false on this path, so that predecessor's
  // threads/pacts/mail were never adopted on a reclaim.
  it("T5: composed reclaim — the name holder's own tombstoned predecessor is adopted too (thread, pact column, mail), exactly once", () => {
    const db = rawDb()
    const predecessorId = 'agt_pred_chair'
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         origin_kind, origin_pane_key, origin_handle, origin_host_id, tombstoned_at
       ) VALUES (?, 'chair', NULL, 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         'gone', 0, 0, 'pane', NULL, NULL, 'local', datetime('now'))`
    ).run(predecessorId)

    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''

    const { thread } = orchestrationDb!.createThread({
      subject: 'plan',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })
    db.prepare('UPDATE threads SET pact_proposer_agent_id = ? WHERE id = ?').run(
      predecessorId,
      thread.id
    )
    db.prepare(
      `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
       VALUES ('msg_pred_mail', 'run_peer_local', 'peer', ?, 'poke', 'status', 'normal', 0)`
    ).run(`agent:${predecessorId}`)
    // F-2 (attacker-lens review, Ruling 33(a) H6a): a pending peer question addressed to the
    // predecessor is never repointed by design (Ruling 32 Addendum 9) — the reclaim must still
    // report it honestly via remintRow's own countUninheritedPredecessorMail (succession:true).
    db.prepare(
      `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, to_agent_id)
       VALUES ('q_pred', 'peer_questions', 'peer:t1', 'remote:env:asker', 'pending', ?)`
    ).run(predecessorId)

    insertDerivedRow(db, { id: 'agt_derived6', paneKey: 'tab2:leaf-bbb' })

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')
    if (result.outcome !== 'reminted') {
      throw new Error('fixture setup failed')
    }
    expect(result.agent.id).toBe(holderId)
    expect(result.adoptedThreads).toBe(1)
    expect(result.pendingPeerQuestions).toBe(1)
    expect(orchestrationDb!.isThreadParticipant(thread.id, holderId)).toBe(true)

    const pactRow = db
      .prepare('SELECT pact_proposer_agent_id FROM threads WHERE id = ?')
      .get(thread.id) as { pact_proposer_agent_id: string | null }
    expect(pactRow.pact_proposer_agent_id).toBe(holderId)

    const movedMail = db
      .prepare(`SELECT to_handle FROM messages WHERE id = 'msg_pred_mail'`)
      .get() as { to_handle: string }
    expect(movedMail.to_handle).toBe(`agent:${holderId}`)

    const auditCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`
        )
        .get(holderId) as { n: number }
    ).n
    expect(auditCount).toBe(1)

    // A second plain register (no derived row left to reclaim through) adopts nothing more —
    // the predecessor's history already landed on the holder id.
    const second = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_a_new',
        displayName: 'chair'
      })
    )
    expect(second.outcome).toBe('reminted')
    if (second.outcome === 'reminted') {
      expect(second.adoptedThreads).toBe(0)
    }
  })

  // F-8 (attacker-lens review, Ruling 33(a) H6a): mail sitting at the CALLER's own current bare
  // terminal handle (e.g. H5b's C2 orphan-identity notice, inserted while the pane still only
  // held a derived row) is a distinct stranding surface from the displaced derived row's OLD
  // handle (T2 above) — neither repointMailboxFromBareHandle (moves `existing.terminal_handle`
  // only when it DIFFERS from the caller's current one) nor remintRow's own repoint
  // (moves `nameHolder`'s old handle) ever reaches it.
  it("T6: the caller's own current bare-handle backlog is repointed onto the reclaimed id", () => {
    const db = rawDb()
    const holder = upsertAgentByPaneSuffix(
      db,
      baseParams({ paneKey: 'tab1:leaf-aaa', terminalHandle: 'term_a', displayName: 'chair' })
    )
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''

    // A derived row whose OWN terminal_handle is already the caller's current handle (the same
    // pane relaunched under the same handle) — the T2 old-handle repoint is a deliberate no-op
    // here (existing.terminal_handle === params.terminalHandle).
    db.prepare(
      `INSERT INTO agents (
         id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
         worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
         origin_kind, origin_pane_key, origin_handle, origin_host_id
       ) VALUES ('agt_derived6', 'agt_derived6', NULL, 'local', 'tab2:leaf-bbb', 'term_caller',
         NULL, NULL, NULL, NULL, NULL, NULL, 'gone', 1, 0, 'derived', 'tab2:leaf-bbb', NULL,
         'local')`
    ).run()

    // H5b's own notice row (or any other backlog) sitting at the bare handle before the reclaim.
    db.prepare(
      `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
       VALUES ('msg_caller_backlog', 'run_peer_local', 'runtime', 'term_caller', 'waits', 'status', 'normal', 0)`
    ).run()

    const result = upsertAgentByPaneSuffix(
      db,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_caller',
        displayName: 'chair',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')

    const movedMail = db
      .prepare(`SELECT to_handle FROM messages WHERE id = 'msg_caller_backlog'`)
      .get() as { to_handle: string }
    expect(movedMail.to_handle).toBe(`agent:${holderId}`)

    const audit = db
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'mailbox_repoint' AND reason_code LIKE '%caller backlog%' ORDER BY seq DESC LIMIT 1`
      )
      .get(holderId) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('term_caller')
  })
})
