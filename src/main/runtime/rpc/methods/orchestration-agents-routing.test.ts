// S10-1d: agent:<id> routing + durability (A4/BUG5/BUG6) at the RPC layer. Registers fixture
// agent rows directly via db.upsertAgentByPaneSuffix (an already-tested pure DB call) rather than
// through orchestration.agents.register, so these tests focus on send/check, not identity — but
// `check`'s agent: branch is itself identity-gated (ARBITRATION A1: only
// runtime.verifyOrchestrationCompatibilityCaller, never a bare --terminal), so term_b's evidence
// still has to attest for the same reason orchestration-agents.test.ts's register fixtures do.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../shared/orchestration-rpc-contract'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { toPublicAgentView } from './agent-directory-rpc-view'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EVIDENCE_B = { terminalHandle: 'term_b', paneKey: PANE_B, launchToken: 'token-b' }

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

describe('agent: routing + durability', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentBId: string
  const ctx: RpcContext = { orchestrationCompatibilityEvidence: EVIDENCE_B } as RpcContext

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
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

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_a') {
        return PANE_A
      }
      if (handle === 'term_b') {
        return PANE_B
      }
      return null
    })
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === EVIDENCE_B.terminalHandle &&
        evidence.paneKey === EVIDENCE_B.paneKey &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_B, 'term_b')
      }
      return null
    })
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime

    const created = db.upsertAgentByPaneSuffix({
      displayName: 'peer-b',
      role: 'peer agent',
      hostId: 'local',
      paneKey: PANE_B,
      terminalHandle: 'term_b',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_b',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    agentBId = created.agent.id
  }

  afterEach(() => {
    db?.close()
  })

  it('T1: send to agent:<id> with no bound Run lands on PEER_RUN_ID; check returns it, no throw', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'lock-step: schema freeze'
    })
    const stored = db.getMessageById(db.getUnreadMessages(`agent:${agentBId}`)[0]?.id ?? '')
    expect(stored?.run_id).toBe(PEER_RUN_ID)

    const checked = (await call('orchestration.check', { terminal: 'term_b' })) as {
      mailbox: string
      agentId: string
      messages: { subject: string }[]
      deliveryId: string
    }
    expect(checked.mailbox).toBe(`agent:${agentBId}`)
    expect(checked.agentId).toBe(agentBId)
    expect(checked.messages).toHaveLength(1)
    expect(checked.messages[0]?.subject).toBe('lock-step: schema freeze')
    expect(checked.deliveryId).toBeTruthy()
  })

  it('D1/D2: an unacked delivery replays identically; --ack clears it', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'first'
    })
    const first = (await call('orchestration.check', { terminal: 'term_b' })) as {
      deliveryId: string
      messages: unknown[]
      replayed: boolean
    }
    const second = (await call('orchestration.check', { terminal: 'term_b' })) as {
      deliveryId: string
      messages: unknown[]
      replayed: boolean
    }
    expect(second.deliveryId).toBe(first.deliveryId)
    expect(second.messages).toEqual(first.messages)
    expect(second.replayed).toBe(true)

    const acked = (await call('orchestration.check', {
      terminal: 'term_b',
      ack: first.deliveryId
    })) as { messages: unknown[]; pendingBehind: number }
    expect(acked.messages).toHaveLength(0)
    expect(acked.pendingBehind).toBe(0)
  })

  it('D4: messages.delivered_at stays NULL through any number of check calls', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'still undelivered'
    })
    await call('orchestration.check', { terminal: 'term_b' })
    await call('orchestration.check', { terminal: 'term_b' })
    const rows = db.getUndeliveredUnreadMessages(`agent:${agentBId}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.delivered_at).toBeNull()
  })

  it('T2: a genuine legacy row in the bare-handle mailbox is reported as legacyPending and left unread', async () => {
    setup()
    db.insertMessage({
      from: 'term_x',
      to: 'term_b',
      subject: 'legacy mail',
      runId: ORCHESTRATION_LEGACY_RUN_ID
    })
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'current mail'
    })
    const checked = (await call('orchestration.check', { terminal: 'term_b' })) as {
      legacyPending: number
      messages: { subject: string }[]
    }
    expect(checked.legacyPending).toBe(1)
    expect(checked.messages.map((m) => m.subject)).toEqual(['current mail'])
    const legacyRow = db.getAllMessagesForHandle('term_b').find((m) => m.subject === 'legacy mail')
    expect(legacyRow?.read).toBe(0)
  })

  it('T5: send to a quarantined agent refuses with agent_quarantined and nothing is stored', async () => {
    setup()
    db.setAgentQuarantine({ id: agentBId, quarantined: true, reasonCode: 'flagged' })
    await expect(
      call('orchestration.send', {
        from: 'term_a',
        to: `agent:${agentBId}`,
        subject: 'should not land'
      })
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
    expect(db.getUnreadMessages(`agent:${agentBId}`)).toHaveLength(0)
  })

  it('D6: --peek mints no delivery', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'peek me'
    })
    const peeked = (await call('orchestration.check', {
      terminal: 'term_b',
      peek: true
    })) as { messages: unknown[]; deliveryId?: string }
    expect(peeked.messages).toHaveLength(1)
    expect(peeked.deliveryId).toBeUndefined()

    // A real (non-peek) check afterward still mints a fresh delivery — peek left nothing behind.
    const real = (await call('orchestration.check', { terminal: 'term_b' })) as {
      deliveryId: string
      replayed: boolean
    }
    expect(real.deliveryId).toBeTruthy()
    expect(real.replayed).toBe(false)
  })

  // MUTATION PROOF (adversarial review blocker #1, ARBITRATION A1): an attacker calling
  // `orchestration.check` with a bare --terminal naming the victim's handle, but WITHOUT the
  // victim's attested launch evidence, must never reach the victim's agent: mailbox. Reverting
  // the identity gate to `orchestrationCompatibilityCallerAuthority?.paneKey ?? paneKey` (the
  // pre-fix fallback) makes this pass again with `checked.mailbox === 'agent:<id>'` and the
  // victim's mail exposed.
  it("MUTATION PROOF: an unattested caller naming the victim's --terminal never gets the agent: mailbox", async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'private to b'
    })
    const unattested = { runtime } as RpcContext // no orchestrationCompatibilityEvidence at all
    const m = method('orchestration.check')
    const parsed = m.params ? m.params.parse({ terminal: 'term_b' }) : undefined
    const result = (await m.handler(parsed, unattested)) as {
      mailbox?: string
      agentId?: string
      messages: unknown[]
    }
    expect(result.mailbox).toBeUndefined()
    expect(result.agentId).toBeUndefined()
    // Falls through to the bare-handle branch instead — never the durable agent: mailbox, and
    // never the agent-addressed mail (which was sent to `agent:<id>`, not `term_b`).
    expect(result.messages).toHaveLength(0)
  })

  // MUTATION PROOF: a caller who supplies a terminalPaneKey PARAM (not attested evidence) naming
  // the victim's pane must also be refused — kills reinstating the `?? paneKey` fallback that
  // trusted a client-claimed pane key.
  it('MUTATION PROOF: a caller-supplied terminalPaneKey naming the victim never grants the agent: mailbox', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'private to b'
    })
    const attackerCtx = { runtime } as RpcContext // no evidence — only the param claims identity
    const m = method('orchestration.check')
    const parsed = m.params
      ? m.params.parse({ terminal: 'attacker_handle', terminalPaneKey: PANE_B })
      : undefined
    const result = (await m.handler(parsed, attackerCtx)) as {
      mailbox?: string
      agentId?: string
    }
    expect(result.mailbox).toBeUndefined()
    expect(result.agentId).toBeUndefined()
    // The victim's cached terminal_handle must be untouched by the attacker's claimed handle.
    const victim = db.getAgentById(agentBId)
    expect(victim?.terminal_handle).toBe('term_b')
  })

  // MUTATION PROOF (adversarial review major #5): a derived row — minted by ANY caller's
  // `agents list`/`find` for every live pane, never something the pane's own owner opted into —
  // must not route `check` through the durable agent: branch. Reverting the `derived !== 1`
  // guard would silently flip this pane's pre-existing bare-handle mailbox from destructive to
  // replay-until-ack (owner decision 3) merely because a third party listed the directory.
  it("MUTATION PROOF: a derived row never routes the pane's own check through the durable branch", async () => {
    setup()
    const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_a') {
        return PANE_A
      }
      if (handle === 'term_b') {
        return PANE_B
      }
      if (handle === 'term_c') {
        return PANE_C
      }
      return null
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_c' &&
        evidence.paneKey === PANE_C &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_C, 'term_c')
      }
      if (
        evidence?.terminalHandle === EVIDENCE_B.terminalHandle &&
        evidence.paneKey === EVIDENCE_B.paneKey &&
        evidence.launchToken
      ) {
        return makeAuthority(PANE_B, 'term_b')
      }
      return null
    })
    await call('orchestration.send', { from: 'term_a', to: 'term_c', subject: 'bare handle mail' })
    // A DIFFERENT caller's `agents list`/`find` mints a derived row for term_c's pane — term_c's
    // own owner never registered and never opted in.
    db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: PANE_C,
      terminalHandle: 'term_c',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null
    })

    const ctxC = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_c',
        paneKey: PANE_C,
        launchToken: 'token-c'
      }
    } as RpcContext
    const m = method('orchestration.check')
    const parsed = m.params ? m.params.parse({ terminal: 'term_c' }) : undefined
    const result = (await m.handler(parsed, ctxC)) as {
      mailbox?: string
      agentId?: string
      messages: { subject: string }[]
    }
    expect(result.mailbox).toBeUndefined()
    expect(result.agentId).toBeUndefined()
    // Still delivered — just through the pre-existing bare-handle path, not the durable one.
    expect(result.messages.map((msg) => msg.subject)).toEqual(['bare handle mail'])
  })

  // FIX (blocker): a derived row's `agent:<id>` mailbox has no reader — sending there must be
  // refused with a typed error naming the bare handle, not silently accepted into a black hole.
  it('send to agent:<derivedId> is refused with derived_agent_unaddressable naming the bare handle', async () => {
    setup()
    const PANE_D = 'tabD:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const derived = db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: PANE_D,
      terminalHandle: 'term_d',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null
    })
    expect(derived?.derived).toBe(1)

    let caught: unknown
    try {
      await call('orchestration.send', {
        from: 'term_a',
        to: `agent:${derived?.id}`,
        subject: 'work item for you'
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OrchestrationError)
    expect((caught as OrchestrationError).code).toBe('derived_agent_unaddressable')
    const nextSteps = (caught as OrchestrationError & { data?: { nextSteps?: string[] } }).data
      ?.nextSteps
    expect(nextSteps?.some((step) => step.includes('term_d'))).toBe(true)

    // No message was stored for the derived id.
    expect(db.getUnreadMessages(`agent:${derived?.id}`)).toHaveLength(0)

    // Negative control: the registered agent's address still routes and is readable via the
    // attested check.
    await call('orchestration.send', {
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'registered still works'
    })
    const checked = (await call('orchestration.check', { terminal: 'term_b' })) as {
      agentId: string
      messages: { subject: string }[]
    }
    expect(checked.agentId).toBe(agentBId)
    expect(checked.messages.map((m) => m.subject)).toEqual(['registered still works'])
  })

  // FIX (major, re-review): quarantine outranks the derived refusal — derived_agent_unaddressable's
  // nextSteps name the pane's bare handle, which for a quarantined row is a one-command bypass of
  // the quarantine. The public view withholds the handle for the same reason.
  it('a QUARANTINED derived agent refuses agent_quarantined and never surfaces the pane handle', async () => {
    setup()
    const PANE_Q = 'tabQ:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const derived = db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: PANE_Q,
      terminalHandle: 'term_q',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null
    })
    expect(derived?.derived).toBe(1)
    db.setAgentQuarantine({ id: derived!.id, quarantined: true, reasonCode: 'poisoned' })

    let caught: unknown
    try {
      await call('orchestration.send', {
        from: 'term_a',
        to: `agent:${derived?.id}`,
        subject: 'should not route'
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OrchestrationError)
    expect((caught as OrchestrationError).code).toBe('agent_quarantined')
    const nextSteps = (caught as OrchestrationError & { data?: { nextSteps?: string[] } }).data
      ?.nextSteps
    expect(nextSteps?.some((step) => step.includes('term_q'))).toBe(false)
    expect(db.getUnreadMessages(`agent:${derived?.id}`)).toHaveLength(0)
    expect(db.getUnreadMessages('term_q')).toHaveLength(0)

    // The public view withholds the pane handle while quarantined...
    const view = toPublicAgentView(db.getAgentById(derived!.id)!, false)
    expect(view.quarantined).toBe(true)
    expect(view.terminalHandle).toBeUndefined()

    // ...and restores it once the quarantine lifts (the derived refusal's nextSteps depend on it).
    db.setAgentQuarantine({ id: derived!.id, quarantined: false, reasonCode: null })
    const restored = toPublicAgentView(db.getAgentById(derived!.id)!, false)
    expect(restored.terminalHandle).toBe('term_q')
  })

  // S10-7 F-B: mail to a retired agent's old id must name the successor (a fresh row that
  // reclaimed the retired agent's display_name), never the generic agent_unknown message a
  // never-existed id gets.
  it('send to a retired agent refuses with agent_retired, naming the successor that reclaimed its name', async () => {
    setup()
    const retiredId = agentBId
    const outcome = db.retireAgent(retiredId)
    expect(outcome.outcome).toBe('retired')

    const successor = db.upsertAgentByPaneSuffix({
      displayName: 'peer-b',
      role: 'the new peer-b',
      hostId: 'local',
      paneKey: 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      terminalHandle: 'term_c',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_c',
      originHostId: 'local'
    })
    if (successor.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }

    let caught: unknown
    try {
      await call('orchestration.send', {
        from: 'term_a',
        to: `agent:${retiredId}`,
        subject: 'mail for the old row'
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OrchestrationError)
    expect((caught as OrchestrationError).code).toBe('agent_retired')
    const nextSteps = (caught as OrchestrationError & { data?: { nextSteps?: string[] } }).data
      ?.nextSteps
    expect(nextSteps?.some((step) => step.includes(successor.agent.id))).toBe(true)
    expect(db.getUnreadMessages(`agent:${retiredId}`)).toHaveLength(0)
  })

  it('send to a retired agent with no successor refuses with agent_retired and generic nextSteps', async () => {
    setup()
    const retiredId = agentBId
    db.retireAgent(retiredId)

    let caught: unknown
    try {
      await call('orchestration.send', {
        from: 'term_a',
        to: `agent:${retiredId}`,
        subject: 'mail for the old row'
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OrchestrationError)
    expect((caught as OrchestrationError).code).toBe('agent_retired')
    const nextSteps = (caught as OrchestrationError & { data?: { nextSteps?: string[] } }).data
      ?.nextSteps
    expect(nextSteps).toContain('orca agents list')
  })
})
