// S10-21b B18 (D-R137 F9): `enqueueReservedReleasesAfterReset`'s message-gate-refusal fallback.
// Fails at base b9df9b7061: a 'refused' outcome from `enqueueFederatedPactVerbWithin` re-asserted
// `pact_state='released'` via the follow-up UPDATE but never wrote a release ledger row nor
// stamped `pact_release_at` — the pact stays released-but-unpurgeable forever (the retention
// trigger's exemption requires `pact_release_at IS NOT NULL`).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import type * as PactFederatedEmitModule from './pact-federated-emit'

// `forceRefuseRelease` defaults to passthrough (the real implementation) — setup's own
// `engagedFederatedPact` proposes a real federated pact through this SAME mocked function
// before the test ever wants a refusal; only the release-verb call made by
// `enqueueReservedReleasesAfterReset` (during `resetAll`) is switched to 'refused'.
const { enqueueWithinMock, forceRefuseRelease } = vi.hoisted(() => ({
  enqueueWithinMock: vi.fn(),
  forceRefuseRelease: { value: false }
}))
vi.mock('./pact-federated-emit', async (importOriginal) => {
  const actual = await importOriginal<typeof PactFederatedEmitModule>()
  enqueueWithinMock.mockImplementation(
    (...args: Parameters<typeof actual.enqueueFederatedPactVerbWithin>) => {
      const [, , verb] = args
      if (forceRefuseRelease.value && verb === 'release') {
        return {
          outcome: 'refused',
          verdict: { tier: 'hard', ruleIds: ['test_rule'] },
          refusalId: 1
        }
      }
      return actual.enqueueFederatedPactVerbWithin(...args)
    }
  )
  return {
    ...actual,
    enqueueFederatedPactVerbWithin: (
      ...args: Parameters<typeof actual.enqueueFederatedPactVerbWithin>
    ) => enqueueWithinMock(...args)
  }
})

import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_reset'
const REMOTE_AGENT_ID = 'rb'

describe('S10-21b B18 (D-R137 F9): reset-settlement release refusal fallback', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    enqueueWithinMock.mockClear()
    forceRefuseRelease.value = false
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedAgent(d: OrchestrationDb, id: string): string {
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
    const result = d.upsertAgentByPaneSuffix(params)
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

  function seedFederatedPeer(d: OrchestrationDb): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'b (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(d), {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint1',
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
    return renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId: REMOTE_AGENT_ID })
  }

  function engagedFederatedPact(d: OrchestrationDb, a: string): string {
    const peerKey = seedFederatedPeer(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    rawDb(d)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    return thread.id
  }

  it('a message-gate refusal during the reserved release still leaves the pact locally released and purgeable', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const threadId = engagedFederatedPact(d, a)

    forceRefuseRelease.value = true
    d.resetAll()

    const row = rawDb(d)
      .prepare(`SELECT pact_state, pact_release_at FROM threads WHERE id = ?`)
      .get(threadId) as { pact_state: string; pact_release_at: string | null }
    expect(row.pact_state).toBe('released')
    expect(row.pact_release_at).not.toBeNull()

    const ledgerRow = rawDb(d)
      .prepare(`SELECT kind, reason_code FROM pact_steps WHERE thread_id = ? AND kind = 'release'`)
      .get(threadId) as { kind: string; reason_code: string } | undefined
    expect(ledgerRow?.kind).toBe('release')
    expect(ledgerRow?.reason_code).toBe('local_reset')
  })
})
