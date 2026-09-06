// S10-21b B16b (design §4.7, §7) — the RPC/CLI caller for `setLocalRemoteAgentQuarantine`.
// Every test here FAILS AT BASE 3c34d4ec25: `orchestration.agents.quarantineRemote` does not
// exist (no method of that name is registered).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_AGENT_METHODS } from './orchestration-agents'
import { OrchestrationDb } from '../../orchestration/db'
import type Database from '../../../sqlite/sync-database'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type { UpsertAgentByPaneSuffixParams } from '../../orchestration/agent-directory'
import { renderFederatedPartyKey } from '../../orchestration/pact-federated-identity'
import { putPeerLinkBinding } from '../../orchestration/link-binding-store'

const ENV = 'env_b16b'
const HOST = 'peer-host'
const PANE_OP = 'tabOp:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
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

describe('orchestration.agents.quarantineRemote RPC (S10-21b B16b)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (evidence?.terminalHandle === 'term_op' && evidence.paneKey === PANE_OP) {
        return makeAuthority(PANE_OP, 'term_op')
      }
      return null
    })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation((selector) => {
      if (selector === HOST) {
        return { environmentId: ENV, name: HOST, peerFingerprint: 'fp' }
      }
      throw new Error(`unknown host: ${selector}`)
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

  function ctx(): RpcContext {
    return {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_op',
        paneKey: PANE_OP,
        launchToken: 'lt-op'
      }
    }
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx())
  }

  function seedAgent(id: string): string {
    const params: UpsertAgentByPaneSuffixParams = {
      displayName: id,
      role: null,
      hostId: 'local',
      paneKey: `tab:${id}`,
      terminalHandle: `term_${id}`,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: `term_${id}`,
      originHostId: 'local'
    }
    const result = db.upsertAgentByPaneSuffix(params)
    if (result.outcome === 'name_taken') {
      throw new Error(`seedAgent: name taken for ${id}`)
    }
    return result.agent.id
  }

  function actor(agentId: string): {
    callerAgentId: string
    callerPaneKey: string | null
    callerHostId: string
  } {
    return { callerAgentId: agentId, callerPaneKey: `tab:${agentId}`, callerHostId: 'local' }
  }

  function seedFederatedPeer(remoteAgentId: string, displayName: string): string {
    db.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: HOST,
      linkKind: 'environment',
      remoteAgentId,
      displayName,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(db), {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: `endpoint_${remoteAgentId}`,
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    return renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId })
  }

  // Same shape as pact-link-evidence-sweep.test.ts's fixture: settle the propose relay noise
  // out of the way so this file's own single-outstanding-item assertions see only the row the
  // quarantine caller's own pause creates.
  function engagedFederatedPact(a: string, peerKey: string): { threadId: string } {
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    db.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    rawDb(db)
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    rawDb(db)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    return { threadId: thread.id }
  }

  it("T-B16b-1: quarantining a peer under a POST-REBIND id withholds the PRE-rebind chain's pacts too", async () => {
    setup()
    const a = seedAgent('a')
    const oldKey = seedFederatedPeer('r_old', 'peer-x')
    const { threadId } = engagedFederatedPact(a, oldKey)
    // Simulate a rebind: a new mirror row supersedes the old one under the SAME display name.
    seedFederatedPeer('r_new', 'peer-x')
    rawDb(db)
      .prepare(
        `UPDATE remote_agents SET superseded_at = datetime('now'), succeeded_by_remote_agent_id = ?
         WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .run('r_new', ENV, 'r_old')

    const result = (await call('orchestration.agents.quarantineRemote', {
      name: 'peer-x',
      host: HOST,
      reasonCode: 'rotated'
    })) as { chainLength: number }
    expect(result.chainLength).toBe(2)

    const oldRow = rawDb(db)
      .prepare(
        `SELECT local_quarantined FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(ENV, 'r_old') as { local_quarantined: number }
    expect(oldRow.local_quarantined).toBe(1)
    const newRow = rawDb(db)
      .prepare(
        `SELECT local_quarantined FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(ENV, 'r_new') as { local_quarantined: number }
    expect(newRow.local_quarantined).toBe(1)

    const thread = db.getThread(threadId)
    expect(thread?.pact_paused_at).not.toBeNull()
    expect(thread?.pact_pause_reason).toBe('counterpart_quarantined')
  })

  it('T-B16b-2: quarantining triggers exactly one coalesced pause relay item per affected pact', async () => {
    setup()
    const a = seedAgent('a')
    const peerKey = seedFederatedPeer('r1', 'peer-y')
    const { threadId } = engagedFederatedPact(a, peerKey)

    await call('orchestration.agents.quarantineRemote', {
      name: 'peer-y',
      host: HOST,
      reasonCode: 'abuse'
    })

    const items = rawDb(db)
      .prepare(
        `SELECT relay_kind, state FROM peer_reply_outbox
         WHERE pact_thread_id = ? AND settled_at IS NULL`
      )
      .all(threadId) as { relay_kind: string; state: string }[]
    expect(items).toHaveLength(1)
    expect(items[0].relay_kind).toBe('pact_pause')
    expect(items[0].state).toBe('queued')
  })

  it('a chain reaching PACT_SUPERSESSION_CHAIN_MAX refuses typed, never silently truncates', async () => {
    setup()
    const CHAIN_LEN = 70
    for (let i = 0; i < CHAIN_LEN; i++) {
      const id = `chain_${i}`
      const succ = i < CHAIN_LEN - 1 ? `chain_${i + 1}` : null
      rawDb(db)
        .prepare(
          `INSERT INTO remote_agents
             (environment_id, environment_name, link_kind, remote_agent_id, display_name, role,
              state, derived, remote_quarantined, local_quarantined, succeeded_by_remote_agent_id,
              superseded_at)
           VALUES (?, ?, 'environment', ?, ?, NULL, 'live', 0, 0, 0, ?, ?)`
        )
        .run(ENV, HOST, id, `chain-display-${i}`, succ, succ ? '2024-01-01T00:00:00.000Z' : null)
    }

    await expect(
      call('orchestration.agents.quarantineRemote', {
        id: `chain_${CHAIN_LEN - 1}`,
        host: HOST
      })
    ).rejects.toMatchObject({ code: 'pact_supersession_chain_too_long' })

    // Never silently truncated: not one row in the chain was quarantined.
    const quarantinedCount = rawDb(db)
      .prepare(`SELECT COUNT(*) AS n FROM remote_agents WHERE local_quarantined = 1`)
      .get() as { n: number }
    expect(quarantinedCount.n).toBe(0)
  })

  it('lift is symmetric and never resumes a containment pause', async () => {
    setup()
    const a = seedAgent('a')
    const peerKey = seedFederatedPeer('r2', 'peer-z')
    const { threadId } = engagedFederatedPact(a, peerKey)

    await call('orchestration.agents.quarantineRemote', {
      name: 'peer-z',
      host: HOST,
      reasonCode: 'abuse'
    })
    expect(db.getThread(threadId)?.pact_paused_at).not.toBeNull()

    await call('orchestration.agents.quarantineRemote', { name: 'peer-z', host: HOST, lift: true })

    const row = rawDb(db)
      .prepare(
        `SELECT local_quarantined FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(ENV, 'r2') as { local_quarantined: number }
    expect(row.local_quarantined).toBe(0)
    // Lifting never itself resumes: the pact stays paused until an operator releases it.
    expect(db.getThread(threadId)?.pact_paused_at).not.toBeNull()
    const resumeRows = rawDb(db)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'resume'`)
      .get(threadId) as { n: number }
    expect(resumeRows.n).toBe(0)
  })

  it('a federated caller (paired device) is refused; only a local operator may quarantine a remote mirror', async () => {
    setup()
    const a = seedAgent('a')
    const peerKey = seedFederatedPeer('r3', 'peer-w')
    engagedFederatedPact(a, peerKey)
    const m = method('orchestration.agents.quarantineRemote')
    const parsed = m.params!.parse({ name: 'peer-w', host: HOST })
    let thrown: unknown
    try {
      await m.handler(parsed, { ...ctx(), pairedDeviceId: 'device_1' })
    } catch (err) {
      thrown = err
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe('forbidden')
  })
})
