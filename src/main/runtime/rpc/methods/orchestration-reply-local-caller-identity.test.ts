// D-R177 F1-F4 (S10-21f Q1/R141): orchestration.reply's plain LOCAL branch (no
// peer_link_device_id, not a peer ask, not federated worker mail) must bind authorship to the
// ATTESTED caller — never params.from/original.to_handle — whenever either side of the original
// message is `agent:`-addressed, and must refuse a self-reply. Modelled line-for-line on
// link-binding-reply-relay-caller-identity.test.ts (real ORCHESTRATION_METHODS handler, real
// OrchestrationDb, verifyOrchestrationCompatibilityCaller stubbed per pane).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_UNREGISTERED = 'tabU:uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_C = 'tabC:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function method(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
  const m = method(name)
  const parsed = m.params ? m.params.parse(params) : undefined
  return m.handler(parsed, context)
}

function raw(db: OrchestrationDb) {
  return (
    db as unknown as {
      db: {
        prepare: (sql: string) => {
          get: (...a: unknown[]) => unknown
          all: (...a: unknown[]) => unknown[]
          run: (...a: unknown[]) => unknown
        }
      }
    }
  ).db
}

function makeAuthority(
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

type AuditRow = {
  agent_id: string | null
  actor_pane_key: string | null
  actor_host_id: string | null
  outcome: string
  reason_code: string | null
}

describe('D-R177 F1-F4: orchestration.reply local branch fail-closed authorship', () => {
  let root: string
  let dataPath: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentAId: string
  let agentBId: string
  let agentCId: string

  async function registerAgent(
    name: string,
    evidence: { terminalHandle: string; paneKey: string }
  ): Promise<string> {
    const result = (await call(
      'orchestration.agents.register',
      { name, role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: evidence }
    )) as { agent: { id: string } }
    return result.agent.id
  }

  function messageCount(): number {
    return (raw(db).prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n
  }

  function readFlag(id: string): number {
    return (raw(db).prepare('SELECT read FROM messages WHERE id = ?').get(id) as { read: number })
      .read
  }

  function auditRows(verb: string): AuditRow[] {
    return raw(db)
      .prepare(
        'SELECT agent_id, actor_pane_key, actor_host_id, outcome, reason_code FROM agent_audit WHERE verb = ?'
      )
      .all(verb) as AuditRow[]
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-reply-local-caller-identity-'))
    dataPath = join(root, 'userdata')
    appState.userData = dataPath

    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    // Only PANE_A resolves to an attested caller; PANE_UNREGISTERED is attested but never
    // registered (no agents.register call for it); any other evidence is unattested.
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      const paneKey = (evidence as { paneKey?: string } | null)?.paneKey
      if (paneKey === PANE_A) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (paneKey === PANE_UNREGISTERED) {
        return makeAuthority(PANE_UNREGISTERED, 'term_u')
      }
      if (paneKey === PANE_B) {
        return makeAuthority(PANE_B, 'term_b')
      }
      if (paneKey === PANE_C) {
        return makeAuthority(PANE_C, 'term_c')
      }
      return null
    })
    // F3 pins the boundary: the unauthenticated fallback is DELETED on this branch, so stub it
    // to resolve nothing — a would-be fallback stays visibly inert either way.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)

    agentAId = await registerAgent('agent-a', { terminalHandle: 'term_a', paneKey: PANE_A })
    agentBId = await registerAgent('agent-b', { terminalHandle: 'term_b', paneKey: PANE_B })
    agentCId = await registerAgent('agent-c', { terminalHandle: 'term_c', paneKey: PANE_C })
  })

  afterEach(() => {
    runtime.replyOutbox?.stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('case 1: the observed inversion — reply to your own latest message is refused not_the_addressee', async () => {
    const originalId = 'msg_inv0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentAId}`,
      to: `agent:${agentBId}`,
      subject: 'from A to B',
      body: 'hi B',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })
    const before = messageCount()

    await expect(
      call(
        'orchestration.reply',
        { id: originalId, body: 'reply from A to itself' },
        {
          runtime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
        }
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })

    expect(messageCount()).toBe(before)
    // C1 (M1): a refusal must not consume the original — markAsRead must not have run.
    expect(readFlag(originalId)).toBe(0)
    const rows = auditRows('reply')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('not_the_addressee')
    // C2: audit rows carry the resolved caller's identity, not blanks.
    expect(rows[0].agent_id).toBe(agentAId)
    expect(rows[0].actor_pane_key).toBe(PANE_A)
  })

  it('case 2: attribution — a reply to a message addressed to you stamps YOUR sender fields', async () => {
    const originalId = 'msg_attr0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: `agent:${agentAId}`,
      subject: 'from B to A',
      body: 'hi A',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })

    const result = (await call(
      'orchestration.reply',
      { id: originalId, body: 'reply from A' },
      { runtime, orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A } }
    )) as {
      message: {
        from_handle: string
        sender_pane_key: string | null
        sender_agent_id: string | null
      }
    }

    expect(result.message.from_handle).toBe(`agent:${agentAId}`)
    expect(result.message.sender_pane_key).toBe(PANE_A)
    expect(result.message.sender_agent_id).toBe(agentAId)
  })

  it('case 3: unattested caller refuses no_pane_identity, enqueuing nothing', async () => {
    const originalId = 'msg_unatt0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: `agent:${agentAId}`,
      subject: 'from B to A',
      body: 'hi A',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })
    const before = messageCount()

    await expect(
      call(
        'orchestration.reply',
        { id: originalId, body: 'reply from nowhere' },
        {
          runtime,
          orchestrationCompatibilityEvidence: {
            terminalHandle: 'term_ghost',
            paneKey: 'tabG:ghost'
          }
        }
      )
    ).rejects.toMatchObject({ code: 'no_pane_identity' })

    expect(messageCount()).toBe(before)
    const rows = auditRows('reply')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('no_pane_identity')
    // C2: no attested pane exists at all — nothing to name.
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].actor_pane_key).toBeNull()
  })

  it('case 4: attested-but-unregistered caller refuses no_registered_identity', async () => {
    const originalId = 'msg_unreg0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: `agent:${agentAId}`,
      subject: 'from B to A',
      body: 'hi A',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })
    const before = messageCount()

    await expect(
      call(
        'orchestration.reply',
        { id: originalId, body: 'reply from an unregistered pane' },
        {
          runtime,
          orchestrationCompatibilityEvidence: {
            terminalHandle: 'term_u',
            paneKey: PANE_UNREGISTERED
          }
        }
      )
    ).rejects.toMatchObject({ code: 'no_registered_identity' })

    expect(messageCount()).toBe(before)
    const rows = auditRows('reply')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('no_registered_identity')
    // C2: the pane IS attested (unlike case 3) — the audit must carry that attested pane key
    // even though no agent row exists to name.
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].actor_pane_key).toBe(PANE_UNREGISTERED)
  })

  it('case 6: derived caller is refused derived_agent_unaddressable at the source, with audit', async () => {
    const originalId = 'msg_derived0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: `agent:${agentAId}`,
      subject: 'from B to A',
      body: 'hi A',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })
    const before = messageCount()
    // Derive a row for PANE_A's caller by minting it via `agents find`-style derivation rather
    // than `agents register` — simplest reliable way to get derived === 1: mark the already
    // registered agent-a row as derived directly.
    raw(db).prepare('UPDATE agents SET derived = 1 WHERE id = ?').run(agentAId)

    await expect(
      call(
        'orchestration.reply',
        { id: originalId, body: 'reply from a derived row' },
        {
          runtime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
        }
      )
    ).rejects.toMatchObject({ code: 'derived_agent_unaddressable' })

    expect(messageCount()).toBe(before)
    const rows = auditRows('reply')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('derived_agent_unaddressable')
    expect(rows[0].agent_id).toBe(agentAId)
    expect(rows[0].actor_pane_key).toBe(PANE_A)
  })

  it('case 5: scope guard — a run:/term_-addressed original still succeeds with no evidence, unchanged', async () => {
    const originalId = 'msg_scope0000001'
    db.insertGatedMessage({
      id: originalId,
      from: 'run:run_test_local',
      to: 'term_x',
      subject: 'plain terminal mail',
      body: 'hi term_x',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })

    const result = (await call(
      'orchestration.reply',
      { id: originalId, body: 'reply with no evidence at all' },
      { runtime }
    )) as { message: { to_handle: string } }

    expect(result.message.to_handle).toBe('run:run_test_local')
  })

  it('case 7 (C3): a third, uninvolved agent cannot reply into an agent-addressed thread by id', async () => {
    expect(agentCId).not.toBe(agentAId)
    const originalId = 'msg_third0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: `agent:${agentAId}`,
      subject: 'from B to A',
      body: 'hi A',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })
    const before = messageCount()

    await expect(
      call(
        'orchestration.reply',
        { id: originalId, body: 'reply from an uninvolved third agent' },
        {
          runtime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_c', paneKey: PANE_C }
        }
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })

    expect(messageCount()).toBe(before)
  })

  it('case 8 (C3): self-reply to your own term_-authored row is refused, not just an agent:-authored one', async () => {
    const originalId = 'msg_term_self0000001'
    db.insertGatedMessage({
      id: originalId,
      from: 'term_a',
      to: `agent:${agentBId}`,
      subject: 'from term_a to B',
      body: 'hi B',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })
    const before = messageCount()

    await expect(
      call(
        'orchestration.reply',
        { id: originalId, body: 'reply from A to its own term_-authored row' },
        {
          runtime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
        }
      )
    ).rejects.toMatchObject({ code: 'not_the_addressee' })

    expect(messageCount()).toBe(before)
  })

  it('case 9 (C3): term_-to/agent-from shape is in scope and a non-self reply still succeeds', async () => {
    const originalId = 'msg_term_to0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: 'term_x',
      subject: 'from B to a plain terminal',
      body: 'hi term_x',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })

    const result = (await call(
      'orchestration.reply',
      { id: originalId, body: 'reply from A' },
      { runtime, orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A } }
    )) as { message: { from_handle: string; sender_agent_id: string | null } }

    expect(result.message.from_handle).toBe(`agent:${agentAId}`)
    expect(result.message.sender_agent_id).toBe(agentAId)
  })

  it('case 10 (C3): a forged params.from is fully ignored on the identity branch — from_handle is always the attested caller', async () => {
    const originalId = 'msg_forged0000001'
    db.insertGatedMessage({
      id: originalId,
      from: `agent:${agentBId}`,
      to: `agent:${agentAId}`,
      subject: 'from B to A',
      body: 'hi A',
      runId: 'run_test_local',
      verb: 'send',
      threadId: null
    })

    const result = (await call(
      'orchestration.reply',
      { id: originalId, body: 'reply from A, forging from', from: `agent:${agentBId}` },
      { runtime, orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A } }
    )) as { message: { from_handle: string } }

    expect(result.message.from_handle).toBe(`agent:${agentAId}`)
  })
})
