import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_AGENT_METHODS } from './orchestration-agents'
import { OrchestrationDb } from '../../orchestration/db'
import type Database from '../../../sqlite/sync-database'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_A_MOVED = 'tabA2:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
// A relaunch, not a moved tab: a brand-new leaf suffix (unlike PANE_A_MOVED, which keeps
// PANE_A's leaf), the exact shape findByPaneSuffix cannot match — the S10-11 THE ONE BUG case.
const PANE_A_RELAUNCH = 'tabA9:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// [C13] retire now requires an attested, registered caller (Addendum 5(k)(5)) — a dedicated
// operator identity for the retire-describe tests below, so the pre-existing B fixtures (which
// stay deliberately unregistered until their own register/reclaim assertions) are untouched.
const PANE_OP = 'tabOp:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeAuthority(
  paneKey: string,
  terminalHandle: string,
  processIncarnation = 'proc-1'
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation,
    launchTokenHash: 'hash'
  }
}

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_a',
    ptyId: 'pty-a',
    worktreeId: 'wt_1',
    worktreePath: '/repo/merge-restructure',
    branch: 'merge-restructure',
    tabId: 'tabA',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '✳ fixing the auth bug',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('orchestration.agents.* RPC methods', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (
        evidence?.terminalHandle === 'term_a_moved' &&
        evidence.paneKey === PANE_A_MOVED &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A_MOVED, 'term_a_moved')
      }
      if (
        evidence?.terminalHandle === 'term_b' &&
        evidence.paneKey === PANE_B &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_B, 'term_b')
      }
      if (
        evidence?.terminalHandle === 'term_a_relaunched' &&
        evidence.paneKey === PANE_A_RELAUNCH &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A_RELAUNCH, 'term_a_relaunched')
      }
      if (
        evidence?.terminalHandle === 'term_op' &&
        evidence.paneKey === PANE_OP &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_OP, 'term_op')
      }
      return null
    })
  }

  afterEach(() => {
    db?.close()
  })

  function method(name: string) {
    const found = ORCHESTRATION_AGENT_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  function ctx(evidence?: {
    terminalHandle: string
    paneKey: string
    launchToken: string
  }): RpcContext {
    return { runtime, orchestrationCompatibilityEvidence: evidence }
  }

  async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, context)
  }

  const evidenceA = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'lt-a' }
  const evidenceAMoved = {
    terminalHandle: 'term_a_moved',
    paneKey: PANE_A_MOVED,
    launchToken: 'lt-a'
  }
  const evidenceB = { terminalHandle: 'term_b', paneKey: PANE_B, launchToken: 'lt-b' }
  const evidenceOp = { terminalHandle: 'term_op', paneKey: PANE_OP, launchToken: 'lt-op' }
  const evidenceARelaunch = {
    terminalHandle: 'term_a_relaunched',
    paneKey: PANE_A_RELAUNCH,
    launchToken: 'lt-a'
  }

  it('R1: register with no evidence refuses with no_pane_identity and writes zero rows', async () => {
    setup()
    await expect(
      call('orchestration.agents.register', { name: 'foo-agent' }, ctx())
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining('re-attests this pane automatically'),
          expect.stringContaining('relaunch this agent in a fresh Orca pane')
        ])
      }
    })
    expect(db.listAgents({}).agents).toHaveLength(0)
  })

  it("R2: a caller claiming another pane's terminalHandle is refused, target row untouched", async () => {
    setup()
    await call(
      'orchestration.agents.register',
      { name: 'backend-agent', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )
    const before = db.getAgentByName('local', 'backend-agent')

    // B claims A's terminalHandle in the evidence but signs with its own pane key —
    // the mock's authority function (mirroring the real one) refuses this combination.
    await expect(
      call(
        'orchestration.agents.register',
        { name: 'impersonator' },
        ctx({ terminalHandle: 'term_a', paneKey: PANE_B, launchToken: 'lt-b' })
      )
    ).rejects.toMatchObject({ code: 'no_pane_identity' })

    const after = db.getAgentByName('local', 'backend-agent')
    expect(after).toEqual(before)
  })

  it('R4: register twice from one pane is created then reMinted, same id, new terminal_handle', async () => {
    setup()
    const first = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string }; created: boolean; reMinted: boolean }
    expect(first.created).toBe(true)
    expect(first.reMinted).toBe(false)

    // Simulate a restart: same pane, terminal re-minted under a fresh handle.
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a2' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a2')
      }
      return null
    })
    const second = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx({ terminalHandle: 'term_a2', paneKey: PANE_A, launchToken: 'lt-a' })
    )) as { agent: { id: string; terminalHandle: string }; created: boolean; reMinted: boolean }
    expect(second.created).toBe(false)
    expect(second.reMinted).toBe(true)
    expect(second.agent.id).toBe(first.agent.id)
    expect(second.agent.terminalHandle).toBe('term_a2')
  })

  it('S10-7 F-C: re-mint with a changed terminal_handle repoints unread bare-handle mail and reports repointedMessages', async () => {
    setup()
    const first = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string }; created: boolean; repointedMessages: number }
    expect(first.repointedMessages).toBe(0) // nothing to repoint on a fresh row

    db.insertMessage({ from: 'peer', to: 'term_a', subject: 'while you were away' })
    db.insertMessage({ from: 'peer', to: 'term_a', subject: 'still pending' })

    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a2' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a2')
      }
      return null
    })
    const second = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx({ terminalHandle: 'term_a2', paneKey: PANE_A, launchToken: 'lt-a' })
    )) as { agent: { id: string }; reMinted: boolean; repointedMessages: number }
    expect(second.reMinted).toBe(true)
    expect(second.repointedMessages).toBe(2)

    const checked = (await call('orchestration.agents.get', { id: first.agent.id }, ctx())) as {
      agent: { id: string }
    }
    expect(checked.agent.id).toBe(first.agent.id)
    expect(db.getUnreadMessages(`agent:${first.agent.id}`)).toHaveLength(2)
    expect(db.getUnreadMessages('term_a')).toHaveLength(0)
  })

  it('R5: pane moving tabs (tabId changes, leaf stable) still resolves to the same row', async () => {
    setup()
    const first = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string } }

    const second = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceAMoved)
    )) as { agent: { id: string }; reMinted: boolean }
    expect(second.reMinted).toBe(true)
    expect(second.agent.id).toBe(first.agent.id)
  })

  describe('S10-11 R1: dead-pane rebind on register', () => {
    // T1 (register + threads/mail resolution together) and T3/T4 (thread membership succession
    // and outsider degradation) need orchestration.threads.* alongside agents.* — covered in
    // orchestration-threads.test.ts, which registers the full ORCHESTRATION_METHODS aggregate.
    it('T2: a name held by a genuinely LIVE pane still refuses name_taken, naming the live pane', async () => {
      setup()
      await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )

      // PANE_A is still live this time — a real second agent trying to steal a live name.
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) =>
        paneKey === PANE_A
          ? { terminalHandle: 'term_a', lastAgentStatus: 'idle', observedLive: true }
          : { terminalHandle: null, lastAgentStatus: null, observedLive: false }
      )

      await expect(
        call(
          'orchestration.agents.register',
          { name: 'merge-backend', role: 'someone else' },
          ctx(evidenceARelaunch)
        )
      ).rejects.toMatchObject({
        code: 'name_taken',
        message: expect.stringContaining('term_a'),
        data: {
          nextSteps: expect.arrayContaining([
            expect.stringContaining('orca agents register --name')
          ])
        }
      })
    })

    it('R1 fix: an already-registered pane renaming itself into a name a LIVE different pane holds gets typed name_taken, never a raw UNIQUE constraint error', async () => {
      setup()
      await call('orchestration.agents.register', { name: 'agent-a' }, ctx(evidenceA))
      await call('orchestration.agents.register', { name: 'agent-b' }, ctx(evidenceB))

      // Both panes genuinely live this time — the rename target's own row is not reclaimable.
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) =>
        paneKey === PANE_B
          ? { terminalHandle: 'term_b', lastAgentStatus: 'idle', observedLive: true }
          : { terminalHandle: null, lastAgentStatus: null, observedLive: false }
      )

      // Pane A re-registers under agent-b's name — the rename path (findByPaneSuffix matches
      // its own row), not the fresh-name path T2 above covers.
      await expect(
        call('orchestration.agents.register', { name: 'agent-b' }, ctx(evidenceA))
      ).rejects.toMatchObject({ code: 'name_taken', message: expect.stringContaining('term_b') })

      // Both original rows survive, agent-a's row untouched by the failed rename.
      expect(db.getAgentByName('local', 'agent-a')?.terminal_handle).toBe('term_a')
      expect(db.getAgentByName('local', 'agent-b')?.terminal_handle).toBe('term_b')
    })

    it('R1 corroboration: a holder recently observed live is not a takeover target even when its pty momentarily reads unconnected', async () => {
      setup()
      await call('orchestration.agents.register', { name: 'merge-backend' }, ctx(evidenceA))

      // No connected pty for PANE_A (terminalHandle null — the raw signal alone would say
      // "dead") but the leaf was last observed genuinely working — a transient reconnect blip,
      // not a gone pane.
      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey) =>
        paneKey === PANE_A
          ? { terminalHandle: null, lastAgentStatus: 'working', observedLive: true }
          : { terminalHandle: null, lastAgentStatus: null, observedLive: false }
      )

      await expect(
        call(
          'orchestration.agents.register',
          { name: 'merge-backend', role: 'impersonating' },
          ctx(evidenceARelaunch)
        )
      ).rejects.toMatchObject({ code: 'name_taken' })
      // Original row untouched — no takeover happened.
      const holder = db.getAgentByName('local', 'merge-backend')
      expect(holder?.pane_key).toBe(PANE_A)
    })

    it('auditability: a dead-pane identity takeover writes a distinct reason_code; an ordinary self re-register does not', async () => {
      setup()
      const rawDb = (db as unknown as { db: Database.Database }).db

      // Ordinary case: same pane re-registering (R4 scenario) — never a "takeover".
      await call('orchestration.agents.register', { name: 'agent-b' }, ctx(evidenceA))
      await call('orchestration.agents.register', { name: 'agent-b' }, ctx(evidenceA))
      const selfReminted = rawDb
        .prepare(
          "SELECT reason_code FROM agent_audit WHERE verb = 'register' AND outcome = 'reminted'"
        )
        .all() as { reason_code: string | null }[]
      expect(selfReminted).toHaveLength(1)
      expect(selfReminted[0].reason_code).toBeNull()

      // Takeover case: PANE_A confirmed dead, a different pane reclaims its name.
      await call('orchestration.agents.register', { name: 'agent-a' }, ctx(evidenceA))
      await call(
        'orchestration.agents.register',
        { name: 'agent-a', role: 'take two' },
        ctx(evidenceARelaunch)
      )
      const takeover = rawDb
        .prepare(
          "SELECT agent_id, reason_code FROM agent_audit WHERE verb = 'register' AND outcome = 'reminted' AND reason_code IS NOT NULL"
        )
        .all() as { agent_id: string; reason_code: string }[]
      expect(takeover).toHaveLength(1)
      expect(takeover[0].reason_code).toContain('dead-pane identity takeover')
      expect(takeover[0].agent_id).toBe(db.getAgentByName('local', 'agent-a')?.id)
    })
  })

  it('list: derived rows are flagged derived and ranked lower than registered rows', async () => {
    setup()
    await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_a',
          tabId: 'tabA',
          leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }),
        terminal({
          handle: 'term_b',
          tabId: 'tabB',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          branch: 'merge-restructure',
          worktreePath: '/repo/merge-restructure-2',
          title: '✳ unrelated task'
        })
      ],
      totalCount: 2,
      truncated: false
    })

    const listing = (await call('orchestration.agents.list', {}, ctx())) as {
      agents: { displayName: string; derived: boolean }[]
      derivedCount: number
    }
    expect(listing.derivedCount).toBe(1)
    const registered = listing.agents.find((a) => a.displayName === 'merge-backend')
    const derived = listing.agents.find((a) => a.derived)
    expect(registered?.derived).toBe(false)
    expect(derived).toBeDefined()
    expect(derived?.displayName.startsWith('merge-restructure-')).toBe(true)
  })

  it('find: resolved / ambiguous / no_match outcomes never auto-address', async () => {
    setup()
    await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )
    const resolved = (await call(
      'orchestration.agents.find',
      { query: 'the merge-restructure backend agent' },
      ctx()
    )) as { outcome: string; candidates: unknown[] }
    expect(resolved.outcome).toBe('resolved')
    expect(resolved.candidates.length).toBeGreaterThan(0)

    await call(
      'orchestration.agents.register',
      { name: 'merge-frontend', role: 'backend for the merge restructure' },
      ctx(evidenceB)
    )
    const ambiguous = (await call(
      'orchestration.agents.find',
      { query: 'the merge-restructure backend agent' },
      ctx()
    )) as { outcome: string; nextSteps: string[] }
    expect(ambiguous.outcome).toBe('ambiguous')
    expect(ambiguous.nextSteps.length).toBeGreaterThan(0)

    const noMatch = (await call(
      'orchestration.agents.find',
      { query: 'something completely unrelated to anything' },
      ctx()
    )) as { outcome: string; nextSteps: string[] }
    expect(noMatch.outcome).toBe('no_match')
    expect(noMatch.nextSteps).toContain('orca agents list')
  })

  it('quarantine: local caller can quarantine another agent; a federated caller cannot', async () => {
    setup()
    const registered = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend' },
      ctx(evidenceA)
    )) as { agent: { id: string } }

    const quarantined = (await call(
      'orchestration.agents.quarantine',
      { id: registered.agent.id, reasonCode: 'suspicious' },
      { runtime, orchestrationCompatibilityEvidence: evidenceB }
    )) as { agent: { quarantined: boolean } }
    expect(quarantined.agent.quarantined).toBe(true)

    await call(
      'orchestration.agents.quarantine',
      { id: registered.agent.id, lift: true },
      { runtime, orchestrationCompatibilityEvidence: evidenceB }
    )

    await expect(
      call(
        'orchestration.agents.quarantine',
        { id: registered.agent.id, reasonCode: 'x' },
        { runtime, orchestrationCompatibilityEvidence: evidenceB, pairedDeviceId: 'device-1' }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a quarantined agent is omitted from find candidates but counted in omitted.quarantined', async () => {
    setup()
    const registered = (await call(
      'orchestration.agents.register',
      { name: 'merge-backend', role: 'backend for the merge restructure' },
      ctx(evidenceA)
    )) as { agent: { id: string } }
    await call(
      'orchestration.agents.quarantine',
      { id: registered.agent.id, reasonCode: 'x' },
      ctx(evidenceB)
    )
    const found = (await call(
      'orchestration.agents.find',
      { query: 'the merge-restructure backend agent' },
      ctx()
    )) as { outcome: string; omitted: { quarantined: number } }
    expect(found.outcome).toBe('no_match')
    expect(found.omitted.quarantined).toBe(1)
  })

  describe('orchestration.agents.retire (S10-7 F-B)', () => {
    it('a local caller retires an idle agent and its name is immediately free to reclaim', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }
      // [C13] retire requires an attested, registered caller — a dedicated operator identity,
      // distinct from B, so B stays unregistered for the fresh-reclaim assertion below.
      await call(
        'orchestration.agents.register',
        { name: 'retire-operator', role: 'operator' },
        ctx(evidenceOp)
      )

      const retired = (await call(
        'orchestration.agents.retire',
        { id: registered.agent.id },
        ctx(evidenceOp)
      )) as { agent: { id: string }; outcome: string }
      expect(retired.outcome).toBe('retired')

      // Never resolvable again under its old id.
      await expect(
        call('orchestration.agents.get', { id: registered.agent.id }, ctx())
      ).rejects.toMatchObject({ code: 'not_found' })

      // The freed name reclaims under a fresh registration (a different id).
      const reclaimed = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'someone else now' },
        ctx(evidenceB)
      )) as { agent: { id: string; displayName: string } }
      expect(reclaimed.agent.displayName).toBe('merge-backend')
      expect(reclaimed.agent.id).not.toBe(registered.agent.id)
    })

    it('is idempotent by id: retiring twice returns already_retired, never throws', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }
      // [C13] retire requires an attested, registered caller.
      await call(
        'orchestration.agents.register',
        { name: 'retire-operator', role: 'operator' },
        ctx(evidenceOp)
      )

      await call('orchestration.agents.retire', { id: registered.agent.id }, ctx(evidenceOp))
      const second = (await call(
        'orchestration.agents.retire',
        { id: registered.agent.id },
        ctx(evidenceOp)
      )) as { outcome: string }
      expect(second.outcome).toBe('already_retired')
    })

    it('refuses a federated caller', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }

      await expect(
        call(
          'orchestration.agents.retire',
          { id: registered.agent.id },
          { runtime, orchestrationCompatibilityEvidence: evidenceB, pairedDeviceId: 'device-1' }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('refuses a currently live, attested agent unless --force', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }
      // [C13] retire requires an attested, registered caller.
      await call(
        'orchestration.agents.register',
        { name: 'retire-operator', role: 'operator' },
        ctx(evidenceOp)
      )

      vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
        terminalHandle: 'term_a',
        lastAgentStatus: 'working',
        observedLive: true
      })

      await expect(
        call('orchestration.agents.retire', { id: registered.agent.id }, ctx(evidenceOp))
      ).rejects.toMatchObject({ code: 'agent_live' })

      const forced = (await call(
        'orchestration.agents.retire',
        { id: registered.agent.id, force: true },
        ctx(evidenceOp)
      )) as { outcome: string }
      expect(forced.outcome).toBe('retired')
    })

    it('quarantine -> retire: a quarantined row stays name-locked until retired', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }
      await call(
        'orchestration.agents.quarantine',
        { id: registered.agent.id, reasonCode: 'suspicious' },
        ctx(evidenceB)
      )

      // Quarantine alone does not free the name.
      await expect(
        call(
          'orchestration.agents.register',
          { name: 'merge-backend', role: 'impersonating' },
          ctx(evidenceB)
        )
      ).rejects.toMatchObject({ code: 'name_taken' })

      // [C13] retire requires an attested, registered caller — a dedicated operator identity,
      // distinct from B, so B stays unregistered for the fresh-reclaim assertion below.
      await call(
        'orchestration.agents.register',
        { name: 'retire-operator', role: 'operator' },
        ctx(evidenceOp)
      )
      await call('orchestration.agents.retire', { id: registered.agent.id }, ctx(evidenceOp))

      // Retire is the cleanup step that frees it.
      const reclaimed = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'fresh row' },
        ctx(evidenceB)
      )) as { created: boolean; agent: { displayName: string } }
      expect(reclaimed.created).toBe(true)
      expect(reclaimed.agent.displayName).toBe('merge-backend')
    })

    // [v3.2] T35 (Addendum 5(k)(5), D-R92 P4): retire requires attestation, checked BEFORE any
    // mutation — not merely refused with the row already tombstoned.
    it('T35: an unattested local caller is refused no_pane_identity before any mutation', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }
      const retireAgentSpy = vi.spyOn(db, 'retireAgent')

      await expect(
        call('orchestration.agents.retire', { id: registered.agent.id }, ctx())
      ).rejects.toMatchObject({ code: 'no_pane_identity' })

      expect(retireAgentSpy).not.toHaveBeenCalled()
      const untouched = db.getAgentByIdIncludingTombstoned(registered.agent.id)
      expect(untouched?.tombstoned_at).toBeNull()
    })

    it('T35: an attested-but-unregistered local caller is refused no_registered_identity before any mutation', async () => {
      setup()
      const registered = (await call(
        'orchestration.agents.register',
        { name: 'merge-backend', role: 'backend' },
        ctx(evidenceA)
      )) as { agent: { id: string } }
      const retireAgentSpy = vi.spyOn(db, 'retireAgent')

      // evidenceB is attested (verifyOrchestrationCompatibilityCaller resolves it) but has never
      // registered an agent for its pane.
      await expect(
        call('orchestration.agents.retire', { id: registered.agent.id }, ctx(evidenceB))
      ).rejects.toMatchObject({ code: 'no_registered_identity' })

      expect(retireAgentSpy).not.toHaveBeenCalled()
      const untouched = db.getAgentByIdIncludingTombstoned(registered.agent.id)
      expect(untouched?.tombstoned_at).toBeNull()
    })
  })

  describe('orchestration.agents.relink (S10-4 ruling 5)', () => {
    function federatedDispatch(environmentId: string) {
      const run = db.createRun({
        objective: 'cross-host work',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const task = db.createTask({ spec: 'do the thing', runId: run.id })
      const { dispatch } = db.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        federation: {
          environmentId,
          environmentName: 'work-laptop',
          peerFingerprint: 'peer_fingerprint_1',
          protocolVersion: 3
        }
      })
      return dispatch
    }

    it('resets the relay cursors for a local caller', async () => {
      setup()
      const dispatch = federatedDispatch('env_stale')
      db.importFederatedRelayItem({
        dispatchId: dispatch.id,
        sequence: 1,
        relayKind: 'status',
        message: {
          id: 'relay_1',
          runId: dispatch.run_id,
          from: `dispatch:${dispatch.id}`,
          to: `run:${dispatch.run_id}`,
          subject: 'progress',
          body: 'still going',
          type: 'status',
          priority: 'normal'
        },
        lifecycle: { kind: 'none' }
      })
      expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(1)

      const result = (await call(
        'orchestration.agents.relink',
        { environmentId: 'env_stale' },
        ctx()
      )) as { dispatchIds: string[] }
      expect(result.dispatchIds).toEqual([dispatch.id])
      expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(0)
    })

    it('is a no-op for an environment with no active federated dispatch', async () => {
      setup()
      const result = (await call(
        'orchestration.agents.relink',
        { environmentId: 'env_unknown' },
        ctx()
      )) as { dispatchIds: string[] }
      expect(result.dispatchIds).toEqual([])
    })

    it('refuses a federated caller; the local operator can still relink afterward', async () => {
      setup()
      const dispatch = federatedDispatch('env_stale')
      await expect(
        call(
          'orchestration.agents.relink',
          { environmentId: 'env_stale' },
          { runtime, orchestrationCompatibilityEvidence: undefined, pairedDeviceId: 'device-1' }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(db.getFederatedDispatch(dispatch.id)!.to_home_imported_sequence).toBe(0)

      const result = (await call(
        'orchestration.agents.relink',
        { environmentId: 'env_stale' },
        ctx()
      )) as { dispatchIds: string[] }
      expect(result.dispatchIds).toEqual([dispatch.id])
    })
  })
})
