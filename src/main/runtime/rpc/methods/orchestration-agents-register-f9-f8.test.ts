// H6b fix-up (Ruling 33 Addendum 1, D-R97 F-9 BLOCKER / F-8 completion): sibling to
// orchestration-agents-register-succession.test.ts, split out rather than added there because
// that file already sits at the 800-line test ratchet.
//
// F-9 (BLOCKER): predecessorCount/pendingPeerQuestions/unreadMailOnRetiredId are re-derived
// totals over the SAME predecessor set on both the inline upsert and the register-RPC catch-up
// (agent-thread-succession.ts's countUninheritedPredecessorMail / adoptFromPredecessors's
// `predecessors.length`) — summing them (orchestration-agents-register.ts) double-counted
// whenever the catch-up ran. adoptedThreads/repointedMessages stay summed (genuinely
// incremental: the first pass moves rows the second no longer finds).
//
// F-8 completion: mail addressed to the caller's own bare terminal handle (e.g. a C2 orphan
// notice) must be repointed onto the registered row's agent mailbox on every outcome that
// yields one — created, derived promote, and dead-pane-by-name takeover (the reclaim path
// already did this itself, agent-directory-derived-reclaim.ts).
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
import {
  upsertAgentByPaneSuffix,
  type UpsertAgentByPaneSuffixParams
} from '../../orchestration/agent-directory'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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

describe('orchestration.agents.register: F-9 (BLOCKER) un-doubled catch-up figures + F-8 completion (Ruling 33 Addendum 1)', () => {
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

  function useTerminal(overrides: Partial<RuntimeTerminalSummary>, paneKey: string): void {
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal(overrides)],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === overrides.handle &&
        evidence?.paneKey === paneKey &&
        evidence?.launchToken
      ) {
        return authorityFor(paneKey, overrides.handle as string)
      }
      return null
    })
    ctx = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: overrides.handle,
        paneKey,
        launchToken: 'lt'
      }
    }
  }

  it('T-F9a: a tombstoned same-name predecessor with 2 pending question_threads rows and no adoptable thread membership -> pendingPeerQuestions is 2 (not 4), and the audit reason names 1 predecessor (not 2)', async () => {
    setup()
    useTerminal({ handle: 'term_a', ptyId: 'pty-a', tabId: 'tabA' }, PANE_A)
    const chair = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
    }
    const chairId = chair.agent.id
    sqlite
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, to_agent_id)
         VALUES ('q1', 'peer_questions', 'peer:t1', 'remote:env:asker1', 'pending', ?)`
      )
      .run(chairId)
    sqlite
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, to_agent_id)
         VALUES ('q2', 'peer_questions', 'peer:t2', 'remote:env:asker2', 'pending', ?)`
      )
      .run(chairId)
    db.retireAgent(chairId)
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

    useTerminal({ handle: 'term_b', ptyId: 'pty-b', tabId: 'tabB' }, PANE_B)
    const promoted = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      reMinted: boolean
      adoptedThreads: number
      pendingPeerQuestions: number
    }
    expect(promoted.reMinted).toBe(true)
    // No adoptable thread_participants rows were ever inserted for chairId, so nothing greened
    // the thread_succession marker on the inline call — the register-RPC catch-up runs too.
    expect(promoted.adoptedThreads).toBe(0)
    expect(promoted.pendingPeerQuestions).toBe(2)

    const audit = sqlite
      .prepare(
        `SELECT reason_code FROM agent_audit WHERE agent_id = ? AND verb = 'register' AND reason_code LIKE 'name succession%' ORDER BY seq DESC LIMIT 1`
      )
      .get(promoted.agent.id) as { reason_code: string } | undefined
    expect(audit?.reason_code).toContain('from 1 predecessor(s)')
    expect(audit?.reason_code).not.toContain('from 2 predecessor(s)')
  })

  it('T-F9b: a quarantined tombstoned predecessor blocks adoption outright -> registering twice reports the same un-doubled pendingPeerQuestions both times', async () => {
    setup()
    const predecessorId = 'agt_pred_quarantined_blocked'
    sqlite
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES (?, 'chair', 'local', 'gone', 0, 1, 'pane', 'local', datetime('now'))`
      )
      .run(predecessorId)
    sqlite
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, to_agent_id)
         VALUES ('q1', 'peer_questions', 'peer:t1', 'remote:env:asker1', 'pending', ?)`
      )
      .run(predecessorId)

    useTerminal({ handle: 'term_a', ptyId: 'pty-a', tabId: 'tabA' }, PANE_A)
    const first = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      created: boolean
      blockedByQuarantinedPredecessor: boolean
      pendingPeerQuestions: number
    }
    expect(first.created).toBe(true)
    expect(first.blockedByQuarantinedPredecessor).toBe(true)
    // countUninheritedPredecessorMail is not itself blocked by quarantine (F-9 honesty comment,
    // agent-thread-succession.ts) — it still sums this predecessor's pending question, but only
    // once, not once per re-derivation.
    expect(first.pendingPeerQuestions).toBe(1)

    // A second, plain re-register from the same pane re-runs the promote fallback (unconditional
    // succession:true) AND the register-RPC catch-up again — neither ever writes a
    // thread_succession marker here (nothing is ever adopted while blocked), so both sources
    // keep re-deriving on every call. The figure must stay stable, never grow.
    const second = (await call('orchestration.agents.register', { name: 'chair' })) as {
      blockedByQuarantinedPredecessor: boolean
      pendingPeerQuestions: number
    }
    expect(second.blockedByQuarantinedPredecessor).toBe(true)
    expect(second.pendingPeerQuestions).toBe(1)
    expect(second.pendingPeerQuestions).toBe(first.pendingPeerQuestions)
  })

  it('T-F9c: inline adoption alone adopts 2 threads and writes the thread_succession marker -> the register-RPC catch-up is null, and the reported figures equal the inline result (guards the non-catch-up arm)', async () => {
    setup()
    const predecessorId = 'agt_pred_two_threads'
    sqlite
      .prepare(
        `INSERT INTO agents (id, display_name, host_id, state, derived, quarantined, origin_kind, origin_host_id, tombstoned_at)
         VALUES (?, 'chair', 'local', 'gone', 0, 0, 'pane', 'local', datetime('now'))`
      )
      .run(predecessorId)
    const t1 = db.createThread({
      subject: 'plan a',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })
    const t2 = db.createThread({
      subject: 'plan b',
      createdByAgentId: predecessorId,
      participants: [{ participantKey: predecessorId, agentId: predecessorId, role: 'owner' }]
    })

    useTerminal({ handle: 'term_a', ptyId: 'pty-a', tabId: 'tabA' }, PANE_A)
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      created: boolean
      adoptedThreads: number
      pendingPeerQuestions: number
      unreadMailOnRetiredId: number
    }
    expect(result.created).toBe(true)
    expect(result.adoptedThreads).toBe(2)
    expect(db.isThreadParticipant(t1.thread.id, result.agent.id)).toBe(true)
    expect(db.isThreadParticipant(t2.thread.id, result.agent.id)).toBe(true)
    // No question_threads / bare-handle mail was left behind on the predecessor here.
    expect(result.pendingPeerQuestions).toBe(0)
    expect(result.unreadMailOnRetiredId).toBe(0)

    const markerCount = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession'`
        )
        .get(result.agent.id) as { n: number }
    ).n
    expect(markerCount).toBe(1)
  })

  it("T-F8a: a created register repoints mail already sitting on the caller's bare terminal handle", async () => {
    setup()
    sqlite
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
         VALUES ('msg_c2_created', 'run_c2', 'runtime', 'term_a', 'orphaned notice', 'status', 'normal', 0)`
      )
      .run()

    useTerminal({ handle: 'term_a', ptyId: 'pty-a', tabId: 'tabA' }, PANE_A)
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      created: boolean
      repointedMessages: number
    }
    expect(result.created).toBe(true)
    expect(result.repointedMessages).toBe(1)
    const moved = sqlite
      .prepare(`SELECT to_handle FROM messages WHERE id = 'msg_c2_created'`)
      .get() as { to_handle: string }
    expect(moved.to_handle).toBe(`agent:${result.agent.id}`)
  })

  it("T-F8b: a derived-row promote repoints mail sitting on the caller's bare terminal handle even though the handle did not change", async () => {
    setup()
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
    sqlite
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
         VALUES ('msg_c2_promote', 'run_c2', 'runtime', 'term_b', 'orphaned notice', 'status', 'normal', 0)`
      )
      .run()

    useTerminal({ handle: 'term_b', ptyId: 'pty-b', tabId: 'tabB' }, PANE_B)
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      reMinted: boolean
      created: boolean
      repointedMessages: number
    }
    expect(result.reMinted).toBe(true)
    expect(result.created).toBe(false)
    expect(result.repointedMessages).toBe(1)
    const moved = sqlite
      .prepare(`SELECT to_handle FROM messages WHERE id = 'msg_c2_promote'`)
      .get() as { to_handle: string }
    expect(moved.to_handle).toBe(`agent:${result.agent.id}`)
  })

  it("T-F8c: a dead-pane-by-name takeover repoints mail sitting on the caller's own bare terminal handle (distinct from the holder's old handle)", async () => {
    setup()
    const holderId = 'agt_holder_f8c'
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
    sqlite
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
         VALUES ('msg_c2_takeover', 'run_c2', 'runtime', 'term_c', 'orphaned notice', 'status', 'normal', 0)`
      )
      .run()

    useTerminal({ handle: 'term_c', ptyId: 'pty-c', tabId: 'tabC' }, PANE_C)
    const result = (await call('orchestration.agents.register', { name: 'chair' })) as {
      agent: { id: string }
      reMinted: boolean
      repointedMessages: number
    }
    expect(result.reMinted).toBe(true)
    expect(result.agent.id).toBe(holderId)
    expect(result.repointedMessages).toBe(1)
    const moved = sqlite
      .prepare(`SELECT to_handle FROM messages WHERE id = 'msg_c2_takeover'`)
      .get() as { to_handle: string }
    expect(moved.to_handle).toBe(`agent:${holderId}`)
  })

  it("T-F8d: the reclaim path still repoints the caller backlog exactly once (row count unchanged from the existing reclaim test's expectation)", () => {
    setup()
    const raw = sqlite

    function baseParams(
      overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
    ): UpsertAgentByPaneSuffixParams {
      return {
        displayName: 'chair',
        role: null,
        hostId: 'local',
        paneKey: 'tab1:leaf-aaa',
        terminalHandle: 'term_a',
        processIncarnation: 'inc1',
        worktreeId: 'wt1',
        worktreePath: '/wt/chair',
        branch: 'chair',
        title: null,
        agentLabel: null,
        originHandle: 'term_a',
        originHostId: 'local',
        ...overrides
      }
    }

    const holder = upsertAgentByPaneSuffix(raw, baseParams())
    const holderId = holder.outcome === 'created' ? holder.agent.id : ''

    raw
      .prepare(
        `INSERT INTO agents (
           id, display_name, role, host_id, pane_key, terminal_handle, process_incarnation,
           worktree_id, worktree_path, branch, title, agent_label, state, derived, quarantined,
           origin_kind, origin_pane_key, origin_handle, origin_host_id
         ) VALUES ('agt_derived_f8d', 'agt_derived_f8d', NULL, 'local', 'tab2:leaf-bbb',
           'term_caller', NULL, NULL, NULL, NULL, NULL, NULL, 'gone', 1, 0, 'derived',
           'tab2:leaf-bbb', NULL, 'local')`
      )
      .run()
    raw
      .prepare(
        `INSERT INTO messages (id, run_id, from_handle, to_handle, subject, type, priority, read)
         VALUES ('msg_f8d_backlog', 'run_f8d', 'runtime', 'term_caller', 'waits', 'status', 'normal', 0)`
      )
      .run()

    const result = upsertAgentByPaneSuffix(
      raw,
      baseParams({
        paneKey: 'tab2:leaf-bbb',
        terminalHandle: 'term_caller',
        isPaneLive: () => false
      })
    )
    expect(result.outcome).toBe('reminted')
    if (result.outcome === 'reminted') {
      expect(result.agent.id).toBe(holderId)
      // Exactly one row's worth moved -- if remintRow's own guarded repoint ran a second time
      // on top of reclaimDerivedPlaceholder's explicit callerBacklog repoint, this would be 2.
      expect(result.repointedMessages).toBe(1)
    }
    const movedCount = (
      raw
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE id = 'msg_f8d_backlog' AND to_handle = ?`
        )
        .get(`agent:${holderId}`) as { n: number }
    ).n
    expect(movedCount).toBe(1)
  })
})
