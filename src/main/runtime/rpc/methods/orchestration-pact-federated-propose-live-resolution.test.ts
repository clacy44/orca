// S10-21b B18 (D-R138 row (c)): `orchestration.threads.pact --with <name> --host <host>`'s
// live-resolution `upsertRemoteAgent` must run the SAME grammar + fingerprint-conflict gates the
// inbound importer (federated-sender-identity.ts) runs, before the write — never a second,
// hand-rolled check. Fails at base b9df9b7061: handleFederatedPropose (orchestration-pact.ts)
// wrote the peer's `agents.get` answer straight to `upsertRemoteAgent` with no gate at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'
import type Database from '../../../sqlite/sync-database'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

const evidenceA = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'lt-a' }

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('S10-21b B18 (D-R138 row (c)): federated propose live-resolution runs the importer gates', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.getTerminalProcessIncarnation = () => 'proc-1'
    runtime.listTerminals = async () => ({ terminals: [], totalCount: 0, truncated: false })
    runtime.getAgentDirectoryLivenessSignals = () => ({
      terminalHandle: null,
      lastAgentStatus: null,
      observedLive: false
    })
    runtime.verifyOrchestrationCompatibilityCaller = (evidence) =>
      evidence?.terminalHandle === evidenceA.terminalHandle && evidence.paneKey === PANE_A
        ? makeAuthority(PANE_A, 'term_a')
        : null
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'env_windows_1',
      name: 'windows',
      peerFingerprint: 'fp_windows_1'
    })
  }

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  function ctx(): RpcContext {
    return { runtime, orchestrationCompatibilityEvidence: evidenceA }
  }

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx())
  }

  async function registerAgent(): Promise<{ id: string; threadId: string }> {
    const registered = (await call('orchestration.agents.register', {
      name: 'agent-a',
      role: 'test agent'
    })) as { agent: { id: string } }
    const agentId = registered.agent.id
    // A solo thread (the caller only) — real client shape: `pact --with name@host` targets an
    // already-created thread via `--on`; the federated peer is resolved live, never a local
    // `threads.create` participant.
    const { thread } = db.createThread({
      subject: 's',
      createdByAgentId: agentId,
      participants: [{ participantKey: agentId, agentId }]
    })
    return { id: agentId, threadId: thread.id }
  }

  it('refuses a peer answer with a malformed agent id, writing no remote_agents row', async () => {
    setup()
    const { threadId } = await registerAgent()
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      agent: {
        id: 'not-a-valid-id',
        displayName: 'peer-x',
        role: null,
        state: 'live',
        derived: false,
        quarantined: false
      }
    })

    await expect(
      call('orchestration.threads.pact', { id: threadId, with: 'peer-x', host: 'windows' })
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    const count = rawDb(db).prepare(`SELECT COUNT(*) AS n FROM remote_agents`).get() as {
      n: number
    }
    expect(count.n).toBe(0)
  })

  it('refuses a peer answer whose fingerprint already speaks for a different link, writing no remote_agents row', async () => {
    setup()
    const { threadId } = await registerAgent()
    // A prior contact on a DIFFERENT link already bound this same peer fingerprint.
    rawDb(db)
      .prepare(
        `INSERT INTO remote_agents
           (environment_id, environment_name, link_kind, remote_agent_id, display_name, role,
            state, derived, remote_quarantined, local_quarantined, peer_fingerprint)
         VALUES ('env_other_link', 'other', 'environment', 'agt_000000000001', 'peer-y', NULL,
                 'live', 0, 0, 0, 'fp_windows_1')`
      )
      .run()
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      agent: {
        id: 'agt_000000000002',
        displayName: 'peer-x',
        role: null,
        state: 'live',
        derived: false,
        quarantined: false
      }
    })

    await expect(
      call('orchestration.threads.pact', { id: threadId, with: 'peer-x', host: 'windows' })
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    const count = rawDb(db)
      .prepare(`SELECT COUNT(*) AS n FROM remote_agents WHERE environment_id = 'env_windows_1'`)
      .get() as { n: number }
    expect(count.n).toBe(0)
  })
})
