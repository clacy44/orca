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
})
