// S10-1d: agent:<id> routing + durability (A4/BUG5/BUG6) at the RPC layer. Registers fixture
// agent rows directly via db.upsertAgentByPaneSuffix (an already-tested pure DB call) rather than
// through orchestration.agents.register, so these tests focus on send/check, not identity.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../shared/orchestration-rpc-contract'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('agent: routing + durability', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentBId: string
  const ctx: RpcContext = {} as RpcContext

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
})
