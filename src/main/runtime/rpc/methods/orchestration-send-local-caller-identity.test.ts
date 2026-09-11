// D-R177 F5 (S10-21f Q1/R141, brief b1b C4): orchestration.send's point-to-point branch must
// fail closed on the SENDER's authorship once the recipient resolves to an agent: — never trust
// params.from/the unauthenticated getTerminalPaneKey(from) fallback for that case. Modelled
// line-for-line on orchestration-reply-local-caller-identity.test.ts (real ORCHESTRATION_METHODS
// handler, real OrchestrationDb, verifyOrchestrationCompatibilityCaller stubbed per pane).
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

describe('D-R177 F5: orchestration.send point-to-point agent-recipient fail-closed authorship', () => {
  let root: string
  let dataPath: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentAId: string
  let agentBId: string

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

  function auditRows(verb: string): AuditRow[] {
    return raw(db)
      .prepare(
        'SELECT agent_id, actor_pane_key, actor_host_id, outcome, reason_code FROM agent_audit WHERE verb = ?'
      )
      .all(verb) as AuditRow[]
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-send-local-caller-identity-'))
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
      return null
    })
    // Pins the boundary: an unauthenticated fallback resolving the VICTIM's real pane must stay
    // visibly inert on the agent-recipient branch either way.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_a') {
        return PANE_A
      }
      if (handle === 'term_b') {
        return PANE_B
      }
      return null
    })

    agentAId = await registerAgent('agent-a', { terminalHandle: 'term_a', paneKey: PANE_A })
    agentBId = await registerAgent('agent-b', { terminalHandle: 'term_b', paneKey: PANE_B })
  })

  afterEach(() => {
    runtime.replyOutbox?.stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('case 1: unattested local send to an agent: recipient refuses no_pane_identity, zero rows', async () => {
    const before = messageCount()

    await expect(
      call(
        'orchestration.send',
        { to: `agent:${agentBId}`, from: 'term_a', subject: 'hi', body: 'hi B' },
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
    const rows = auditRows('send')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('no_pane_identity')
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].actor_pane_key).toBeNull()
  })

  it('case 2: attested-but-unregistered caller refuses no_registered_identity, pane key named', async () => {
    const before = messageCount()

    await expect(
      call(
        'orchestration.send',
        { to: `agent:${agentBId}`, subject: 'hi', body: 'hi B' },
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
    const rows = auditRows('send')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('no_registered_identity')
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].actor_pane_key).toBe(PANE_UNREGISTERED)
  })

  it('case 3: derived caller is refused derived_agent_unaddressable, with audit', async () => {
    raw(db).prepare('UPDATE agents SET derived = 1 WHERE id = ?').run(agentAId)
    const before = messageCount()

    await expect(
      call(
        'orchestration.send',
        { to: `agent:${agentBId}`, subject: 'hi', body: 'hi B' },
        {
          runtime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
        }
      )
    ).rejects.toMatchObject({ code: 'derived_agent_unaddressable' })

    expect(messageCount()).toBe(before)
    const rows = auditRows('send')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('derived_agent_unaddressable')
    expect(rows[0].agent_id).toBe(agentAId)
    expect(rows[0].actor_pane_key).toBe(PANE_A)
  })

  it('case 4: attested send with a forged --from refuses forbidden, zero rows', async () => {
    const before = messageCount()

    await expect(
      call(
        'orchestration.send',
        { to: `agent:${agentBId}`, from: 'term_b', subject: 'hi', body: 'forged from' },
        {
          runtime,
          orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A }
        }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })

    expect(messageCount()).toBe(before)
    const rows = auditRows('send')
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('forbidden')
    expect(rows[0].agent_id).toBe(agentAId)
    expect(rows[0].actor_pane_key).toBe(PANE_A)
  })

  it('case 5: attested send to agent: stores sender_pane_key/sender_agent_id of the caller and from = its terminal handle', async () => {
    const result = (await call(
      'orchestration.send',
      { to: `agent:${agentBId}`, subject: 'hi', body: 'hi B' },
      { runtime, orchestrationCompatibilityEvidence: { terminalHandle: 'term_a', paneKey: PANE_A } }
    )) as {
      message: {
        from_handle: string
        sender_pane_key: string | null
        sender_agent_id: string | null
      }
    }

    expect(result.message.from_handle).toBe('term_a')
    expect(result.message.sender_pane_key).toBe(PANE_A)
    expect(result.message.sender_agent_id).toBe(agentAId)
  })

  it('case 6: send to a run:/term_ recipient from an unattested caller is unchanged', async () => {
    const result = (await call(
      'orchestration.send',
      { to: 'term_x', from: 'term_ghost', subject: 'hi', body: 'plain terminal mail' },
      { runtime }
    )) as { message: { to_handle: string } }

    expect(result.message.to_handle).toBe('term_x')
  })

  it('case 7: a bare-name recipient that resolves to an agent is gated the same as agent:<id>', async () => {
    const before = messageCount()

    await expect(
      call(
        'orchestration.send',
        { to: 'agent-b', from: 'term_a', subject: 'hi', body: 'hi B' },
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
  })
})
