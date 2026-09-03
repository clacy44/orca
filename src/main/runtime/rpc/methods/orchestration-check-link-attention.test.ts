// S10-16 C6, R19.5/Ruling 21 Protocol B2, test 79's surface slice: `orchestration.check` through
// the REAL RPC handler (rpc/methods/orchestration.ts's `orchestration.check` defineMethod entry),
// against a real OrchestrationDb fixture — not a unit test of the formatter alone. Local caller
// carries `linkBindingAttention`; the same call with `pairedDeviceId` set, or a mobile client,
// carries no such field (R19.5's local-caller gate); a healthy host carries no field either.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

function method(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

describe('orchestration.check: linkBindingAttention (S10-16 C6)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })

  afterEach(() => {
    db.close()
  })

  function contestLinkC(): void {
    db.contestPeerLinkBinding('link_c', Date.now(), 'incident_1', 'detail', {
      environmentId: 'env_1',
      boundEndpointId: 'ep_1',
      boundPairingRevision: 1,
      linkCredentialFp: 'fp_link',
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'p1'
    })
  }

  async function check(ctx: Partial<RpcContext> = {}): Promise<Record<string, unknown>> {
    const m = method('orchestration.check')
    const parsed = m.params ? m.params.parse({ terminal: 'term_x' }) : undefined
    return m.handler(parsed, { runtime, ...ctx } as RpcContext) as Promise<Record<string, unknown>>
  }

  it('a healthy host carries no field', async () => {
    const result = await check()
    expect(result.linkBindingAttention).toBeUndefined()
  })

  it('a local caller with a contested link sees linkBindingAttention', async () => {
    contestLinkC()
    const result = await check()
    expect(typeof result.linkBindingAttention).toBe('string')
    expect(result.linkBindingAttention).toContain('contested')
  })

  it('the same call with pairedDeviceId set carries no such field', async () => {
    contestLinkC()
    const result = await check({ pairedDeviceId: 'dev_peer', clientKind: 'runtime' })
    expect(result.linkBindingAttention).toBeUndefined()
  })

  it('a mobile client carries no such field either', async () => {
    contestLinkC()
    const result = await check({ clientKind: 'mobile' })
    expect(result.linkBindingAttention).toBeUndefined()
  })

  // F3/Ruling 27(c): the attention read must never fail `check` — a throw degrades LOUDLY to a
  // host-constant literal and an audit row, never silently to "no attention" and never by
  // failing the whole verb (the fleet's hottest read).
  it('a throwing attention read still returns the check result, carrying the host-constant degradation literal', async () => {
    vi.spyOn(db, 'listPeerLinkBindings').mockImplementation(() => {
      throw new Error('v40 table missing')
    })
    const auditCountBefore = (
      db as unknown as { db: { prepare: (sql: string) => { get: () => { n: number } } } }
    ).db
      .prepare('SELECT COUNT(*) AS n FROM agent_audit')
      .get().n

    const result = await check()

    expect(typeof result.linkBindingAttention).toBe('string')
    expect(result.linkBindingAttention).toBe(
      'Link binding health could not be read on this host — orca environment link-status'
    )
    expect(result.messages).toBeDefined()

    const auditCountAfter = (
      db as unknown as { db: { prepare: (sql: string) => { get: () => { n: number } } } }
    ).db
      .prepare('SELECT COUNT(*) AS n FROM agent_audit')
      .get().n
    expect(auditCountAfter).toBe(auditCountBefore + 1)
    const row = (
      db as unknown as {
        db: { prepare: (sql: string) => { get: () => { verb: string; outcome: string } } }
      }
    ).db
      .prepare('SELECT verb, outcome FROM agent_audit ORDER BY rowid DESC LIMIT 1')
      .get()
    expect(row.verb).toBe('check')
    expect(row.outcome).toBe('link_attention_unavailable')
  })

  // Ruling 27 Addendum 1(j)/C6a-2: the F3 guard's own audit write is guarded in its own
  // try/catch, and the degradation literal is set BEFORE that write is attempted — so a DB whose
  // writeAgentAudit ALSO throws (the broken-DB case the guard exists for) still yields the
  // literal and a successful `check`, never a thrown check.
  it('a DB whose writeAgentAudit also throws still yields the degradation line and a successful check', async () => {
    vi.spyOn(db, 'listPeerLinkBindings').mockImplementation(() => {
      throw new Error('v40 table missing')
    })
    vi.spyOn(db, 'writeAgentAudit').mockImplementation(() => {
      throw new Error('audit table missing too')
    })

    const result = await check()

    expect(result.linkBindingAttention).toBe(
      'Link binding health could not be read on this host — orca environment link-status'
    )
    expect(result.messages).toBeDefined()
  })
})
