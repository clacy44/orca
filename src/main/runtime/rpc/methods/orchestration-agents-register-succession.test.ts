// F-9b (Ruling 33 Addendum 1): a rename that PROMOTES an existing (possibly derived) row into a
// name it did not hold before — the plain `remintRow` fallback — never ran thread/pact/mail
// succession at all before this fix, even though the exact same name-keyed predecessor lookup
// the 'created' path already used was sitting right there. A chair that retired then registered
// from a pane holding only a derived row silently lost every thread and pact under its old name.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_AGENT_METHODS } from './orchestration-agents'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import type Database from '../../../sqlite/sync-database'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function authorityFor(
  paneKey: string,
  terminalHandle: string
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_a',
    ptyId: 'pty-a',
    worktreeId: 'wt_1',
    worktreePath: '/repo/alpha',
    branch: 'alpha',
    tabId: 'tabA',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'alpha work',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('orchestration.agents.register: F-9b succession on rename/promote (Ruling 33 Addendum 1)', () => {
  let db: OrchestrationDb
  let sqlite: Database.Database
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    sqlite = (db as unknown as { db: Database.Database }).db
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
    })
  }

  function method(name: string) {
    const found = ORCHESTRATION_AGENT_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  afterEach(() => {
    db?.close()
  })

  it('T1: retire then register from a pane holding a DERIVED row adopts the predecessor thread/pact/mail (a NEW id promotes into the name)', async () => {
    setup()
    // Register 'chair' first, from PANE_A.
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_A, 'term_a')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_a',
        paneKey: PANE_A,
        launchToken: 'lt-a'
      }
    }
    const chair = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
    }
    const chairId = chair.agent.id

    // One thread with a pact column, one unread message addressed to agent:<chair>.
    const { thread } = db.createThread({
      subject: 'merge plan',
      createdByAgentId: chairId,
      participants: [{ participantKey: chairId, agentId: chairId, role: 'owner' }]
    })
    sqlite
      .prepare('UPDATE threads SET pact_proposer_agent_id = ? WHERE id = ?')
      .run(chairId, thread.id)
    db.insertGatedMessage({
      from: 'peer',
      to: `agent:${chairId}`,
      subject: 'still yours',
      type: 'status',
      priority: 'normal'
    })

    // Retire 'chair' (frees the name; the row is tombstoned).
    db.retireAgent(chairId)

    // A restart mints a derived row on a NEW pane suffix.
    const derivedRow = db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: PANE_B,
      terminalHandle: 'term_b',
      processIncarnation: 'proc-2',
      worktreeId: 'wt_1',
      worktreePath: '/repo/alpha',
      branch: 'alpha',
      title: null,
      agentLabel: null
    })
    const derivedRowId = derivedRow?.id ?? ''

    // Plain register from that pane, same desired name — the rename/promote fallback.
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_b',
          ptyId: 'pty-b',
          tabId: 'tabB',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        })
      ],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_b' &&
        evidence.paneKey === PANE_B &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_B, 'term_b')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_b',
        paneKey: PANE_B,
        launchToken: 'lt-b'
      }
    }
    const wake = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const promoted = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      reMinted: boolean
      created: boolean
      adoptedThreads: number
      repointedMessages: number
      unreadWaiting: number
      unreadMailOnRetiredId: number
    }

    // F-9b: the DERIVED row's own id promotes into 'chair' — the tombstoned predecessor
    // (chairId) is never reused; its history is ADOPTED onto the new id instead.
    expect(promoted.reMinted).toBe(true)
    expect(promoted.created).toBe(false)
    expect(promoted.agent.id).toBe(derivedRowId)
    expect(promoted.agent.id).not.toBe(chairId)
    expect(promoted.adoptedThreads).toBe(1)
    expect(promoted.repointedMessages).toBe(1)
    expect(promoted.unreadMailOnRetiredId).toBe(0)
    expect(promoted.unreadWaiting).toBe(1)
    expect(wake).toHaveBeenCalledWith(`agent:${derivedRowId}`, 'status', null, null)

    const pactRow = sqlite
      .prepare('SELECT pact_proposer_agent_id FROM threads WHERE id = ?')
      .get(thread.id) as { pact_proposer_agent_id: string | null }
    expect(pactRow.pact_proposer_agent_id).toBe(derivedRowId)
  })

  it('T2: the promote audit row carries the "name succession" reason', async () => {
    setup()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_A, 'term_a')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_a',
        paneKey: PANE_A,
        launchToken: 'lt-a'
      }
    }
    const chair = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
    }
    db.createThread({
      subject: 'plan',
      createdByAgentId: chair.agent.id,
      participants: [{ participantKey: chair.agent.id, agentId: chair.agent.id, role: 'owner' }]
    })
    db.retireAgent(chair.agent.id)
    db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: PANE_B,
      terminalHandle: 'term_b',
      processIncarnation: 'proc-2',
      worktreeId: 'wt_1',
      worktreePath: '/repo/alpha',
      branch: 'alpha',
      title: null,
      agentLabel: null
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_b',
          ptyId: 'pty-b',
          tabId: 'tabB',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        })
      ],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_b' &&
        evidence.paneKey === PANE_B &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_B, 'term_b')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_b',
        paneKey: PANE_B,
        launchToken: 'lt-b'
      }
    }
    const promoted = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
    }
    const audit = sqlite
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'register' AND reason_code LIKE 'name succession%' ORDER BY seq DESC LIMIT 1`
      )
      .get(promoted.agent.id) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('name succession')
    expect(audit?.reason_code).toContain('"chair"')
  })

  it('T3: catch-up adopts on a later plain register when an earlier one missed succession, and a second register does nothing more', async () => {
    setup()
    // Simulate the pre-fix state directly: a tombstoned predecessor with membership, and a
    // successor row ALREADY present under the SAME name (no thread_succession marker for it).
    const predecessor = db.upsertAgentByPaneSuffix({
      displayName: 'chair',
      role: null,
      hostId: 'local',
      paneKey: 'tabX:leaf-old',
      terminalHandle: 'term_old',
      processIncarnation: 'proc-old',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: 'local'
    })
    if (predecessor.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const predecessorId = predecessor.agent.id
    const { thread } = db.createThread({
      subject: 'plan',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })
    // Tombstoning alone (never a rename) frees the UNIQUE(host_id, display_name) slot for a
    // fresh 'chair' insert below — the index is `WHERE tombstoned_at IS NULL`.
    sqlite
      .prepare(`UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL WHERE id = ?`)
      .run(predecessorId)

    // A successor already sits under 'chair' with NO thread_succession marker (the S10-15-era
    // bug this catch-up repairs) — inserted via raw SQL, deliberately bypassing
    // upsertAgentByPaneSuffix's own 'created'-path adoption (R2), which would otherwise adopt
    // immediately and defeat the point of this fixture: a row that ALREADY exists, pre-fix,
    // with nothing ever having adopted for it.
    const successorId = 'agt_successor01'
    sqlite
      .prepare(
        `INSERT INTO agents (
           id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
           worktree_id, worktree_path, branch, title, agent_label, state, derived,
           origin_kind, origin_pane_key, origin_handle, origin_host_id
         ) VALUES (?, 'chair', NULL, 'local', ?, 'term_a', 'proc-1', 'wt_1', '/repo/alpha',
           'alpha', NULL, NULL, 'idle', 0, 'pane', ?, 'term_a', 'local')`
      )
      .run(successorId, PANE_A, PANE_A)
    expect(db.isThreadParticipant(thread.id, successorId)).toBe(false)

    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_A, 'term_a')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_a',
        paneKey: PANE_A,
        launchToken: 'lt-a'
      }
    }
    const first = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      adoptedThreads: number
    }
    expect(first.agent.id).toBe(successorId)
    expect(first.adoptedThreads).toBe(1)
    expect(db.isThreadParticipant(thread.id, successorId)).toBe(true)

    const auditCountAfterFirst = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`
        )
        .get(successorId) as { n: number }
    ).n
    expect(auditCountAfterFirst).toBe(1)

    const second = (await call('orchestration.agents.register', { name: 'chair' })) as {
      adoptedThreads: number
    }
    expect(second.adoptedThreads).toBe(0)
    const auditCountAfterSecond = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`
        )
        .get(successorId) as { n: number }
    ).n
    expect(auditCountAfterSecond).toBe(1)
  })

  it('T4a: takeover path (existingForPane null) is unchanged — reason stays "dead-pane identity takeover"', async () => {
    setup()
    const holder = db.upsertAgentByPaneSuffix({
      displayName: 'chair',
      role: null,
      hostId: 'local',
      paneKey: 'tabX:leaf-old',
      terminalHandle: 'term_old',
      processIncarnation: 'proc-old',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: 'local'
    })
    if (holder.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_A, 'term_a')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_a',
        paneKey: PANE_A,
        launchToken: 'lt-a'
      }
    }
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      reMinted: boolean
    }
    expect(result.reMinted).toBe(true)
    expect(result.agent.id).toBe(holder.agent.id)
    const audit = sqlite
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'register' ORDER BY seq DESC LIMIT 1`
      )
      .get(result.agent.id) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('dead-pane identity takeover')
  })

  it('T4b: a quarantined predecessor still blocks catch-up adoption (blockedByQuarantinedPredecessor true)', async () => {
    setup()
    const predecessor = db.upsertAgentByPaneSuffix({
      displayName: 'chair',
      role: null,
      hostId: 'local',
      paneKey: 'tabX:leaf-old',
      terminalHandle: 'term_old',
      processIncarnation: 'proc-old',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: 'local'
    })
    if (predecessor.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    db.setAgentQuarantine({ id: predecessor.agent.id, quarantined: true, reasonCode: 'test' })
    sqlite
      .prepare(`UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL WHERE id = ?`)
      .run(predecessor.agent.id)

    const successor = db.upsertAgentByPaneSuffix({
      displayName: 'chair',
      role: null,
      hostId: 'local',
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      worktreeId: 'wt_1',
      worktreePath: '/repo/alpha',
      branch: 'alpha',
      title: null,
      agentLabel: null,
      originHandle: 'term_a',
      originHostId: 'local'
    })
    if (successor.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_A, 'term_a')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_a',
        paneKey: PANE_A,
        launchToken: 'lt-a'
      }
    }
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      blockedByQuarantinedPredecessor: boolean
      adoptedThreads: number
    }
    expect(result.blockedByQuarantinedPredecessor).toBe(true)
    expect(result.adoptedThreads).toBe(0)
  })

  // F-4 (attacker-lens review, Ruling 33(a) H6a): T3 above always lands on the SAME pane as the
  // pre-existing successor row, which goes through remintRow's own succession:true (the
  // rename/promote fallback, agent-directory.ts:195) — the register-RPC catch-up call never
  // actually runs there (its marker is already written by that direct succession). This drives
  // the dead-pane-BY-NAME takeover instead (agent-directory.ts:223, remintRow succession:false):
  // a DIFFERENT pane with no row of its own reclaims a dead, non-derived name holder that itself
  // never got a thread_succession marker — the catch-up in orchestration-agents-register.ts is
  // the ONLY thing that can adopt here.
  const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  it('T5 (F-4): catch-up is the sole adoption mechanism on the dead-pane-by-name takeover path, and also surfaces uninherited peer questions (F-2)', async () => {
    setup()
    const predecessorId = 'agt_pred_takeover'
    sqlite
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES (?, 'chair', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
      )
      .run(predecessorId)
    const { thread } = db.createThread({
      subject: 'plan',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })
    sqlite
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, to_agent_id)
         VALUES ('q_takeover', 'peer_questions', 'peer:t1', 'remote:env:asker', 'pending', ?)`
      )
      .run(predecessorId)

    // The current name holder: a real registered row (NOT derived), dead pane, no
    // thread_succession marker for it yet — simulates a row that existed before this fix.
    const holderId = 'agt_holder_takeover'
    sqlite
      .prepare(
        `INSERT INTO agents (
           id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
           worktree_id, worktree_path, branch, title, agent_label, state, derived,
           origin_kind, origin_pane_key, origin_handle, origin_host_id
         ) VALUES (?, 'chair', NULL, 'local', 'tabX:leaf-old', 'term_old', 'proc-old',
           NULL, NULL, NULL, NULL, NULL, 'idle', 0, 'pane', 'tabX:leaf-old', 'term_old', 'local')`
      )
      .run(holderId)

    // Register from PANE_C — no row of its own, so upsertAgentByPaneSuffix falls into the
    // no-existing-row branch, finds `holderId` by name, dead pane, non-derived, non-quarantined
    // -> remintRow(succession:false) at agent-directory.ts:223.
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_c',
          ptyId: 'pty-c',
          tabId: 'tabC',
          leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        })
      ],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_c' &&
        evidence.paneKey === PANE_C &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_C, 'term_c')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_c',
        paneKey: PANE_C,
        launchToken: 'lt-c'
      }
    }

    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      adoptedThreads: number
      pendingPeerQuestions: number
    }
    expect(result.agent.id).toBe(holderId)
    expect(result.adoptedThreads).toBe(1)
    expect(db.isThreadParticipant(thread.id, holderId)).toBe(true)
    expect(result.pendingPeerQuestions).toBe(1)

    const auditCountAfterFirst = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`
        )
        .get(holderId) as { n: number }
    ).n
    expect(auditCountAfterFirst).toBe(1)

    const second = (await call('orchestration.agents.register', { name: 'chair' })) as {
      adoptedThreads: number
    }
    expect(second.adoptedThreads).toBe(0)
  })

  // F-3 (attacker-lens review, Ruling 33(a) H6a): a QUARANTINED successor must never adopt,
  // whether succession runs inline (remintRow's own succession:true) or via the register-RPC
  // catch-up call — exercised here through the catch-up path (T5's exact shape, but the
  // successor row itself is quarantined).
  it('T6 (F-3): a quarantined successor adopts nothing via catch-up, and the skip is audited', async () => {
    setup()
    const predecessorId = 'agt_pred_quarantined_succ'
    sqlite
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES (?, 'chair', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
      )
      .run(predecessorId)
    const { thread } = db.createThread({
      subject: 'plan',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })

    const holderId = 'agt_holder_quarantined'
    sqlite
      .prepare(
        `INSERT INTO agents (
           id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
           worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
           origin_kind, origin_pane_key, origin_handle, origin_host_id
         ) VALUES (?, 'chair', NULL, 'local', 'tabX:leaf-old', 'term_old', 'proc-old',
           NULL, NULL, NULL, NULL, NULL, 'idle', 0, 1, 'pane', 'tabX:leaf-old', 'term_old', 'local')`
      )
      .run(holderId)

    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_c',
          ptyId: 'pty-c',
          tabId: 'tabC',
          leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        })
      ],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_c' &&
        evidence.paneKey === PANE_C &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_C, 'term_c')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_c',
        paneKey: PANE_C,
        launchToken: 'lt-c'
      }
    }

    // A quarantined holder refuses the name outright (existing name_taken semantics) — the
    // catch-up guard is exercised directly at the db layer here instead, since the RPC surface
    // for a quarantined name holder never reaches remintRow/catch-up at all.
    const catchUp = db.catchUpThreadSuccession('local', 'chair', holderId)
    expect(catchUp).toBeNull()
    expect(db.isThreadParticipant(thread.id, holderId)).toBe(false)
    const skipAudit = sqlite
      .prepare(
        `SELECT outcome, reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession_skipped' ORDER BY seq DESC LIMIT 1`
      )
      .get(holderId) as { outcome: string; reason_code: string } | undefined
    expect(skipAudit?.reason_code).toBe('succession_skipped_quarantined')
    const marker = sqlite
      .prepare(`SELECT 1 FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`)
      .get(holderId)
    expect(marker).toBeUndefined()
  })

  // F-7 (attacker-lens review, Ruling 33(a) H6a): the 'name succession' audit reason must carry
  // BOTH the adopted-thread count and the predecessor count ("N thread(s) from M
  // predecessor(s)"), and that count must be the TOTAL after catch-up runs, not just the
  // upsert's own share.
  it('T7 (F-7): the name-succession audit reason reports "N thread(s) from M predecessor(s)"', async () => {
    setup()
    const predA = 'agt_pred_a'
    const predB = 'agt_pred_b'
    for (const id of [predA, predB]) {
      sqlite
        .prepare(
          `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
           VALUES (?, 'chair', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
        )
        .run(id)
    }
    db.createThread({
      subject: 'plan a',
      createdByAgentId: predA,
      participants: [{ participantKey: predA, agentId: predA, role: 'owner' }]
    })
    db.createThread({
      subject: 'plan b',
      createdByAgentId: predB,
      participants: [{ participantKey: predB, agentId: predB, role: 'owner' }]
    })

    // derived: 1 — the isPromoteSuccession audit-reason classification (register.ts) requires
    // `existingForPane.derived === 1` (a placeholder promoting into the name), which is also
    // exactly the shape the register RPC actually mints on a restart (T1's own flow); a
    // non-derived row here would take the plain-refresh path and never carry the
    // "name succession" reason at all.
    const successorId = 'agt_successor_multi'
    sqlite
      .prepare(
        `INSERT INTO agents (
           id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
           worktree_id, worktree_path, branch, title, agent_label, state, derived,
           origin_kind, origin_pane_key, origin_handle, origin_host_id
         ) VALUES (?, 'chair', NULL, 'local', ?, 'term_a', 'proc-1', 'wt_1', '/repo/alpha',
           'alpha', NULL, NULL, 'idle', 1, 'pane', ?, 'term_a', 'local')`
      )
      .run(successorId, PANE_A, PANE_A)

    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal()],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return authorityFor(PANE_A, 'term_a')
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_a',
        paneKey: PANE_A,
        launchToken: 'lt-a'
      }
    }
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      adoptedThreads: number
    }
    expect(result.adoptedThreads).toBe(2)
    const audit = sqlite
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'register' AND reason_code LIKE 'name succession%' ORDER BY seq DESC LIMIT 1`
      )
      .get(result.agent.id) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('2 thread(s) from 2 predecessor(s)')
  })
})
