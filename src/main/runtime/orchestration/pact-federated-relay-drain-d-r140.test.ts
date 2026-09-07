// S10-21b B20 (D-R140 N3/21b-E11) — the propose block window's applied-only bump. Split into
// its own file (max-lines discipline) rather than growing pact-federated-containment-b14.test.ts
// (already at its own budget) or pact-federated-propose-race.test.ts further.
//
// S10-21b B21 (D-D3 redesign — SCENARIO_CORRECTION, declared test deletions): NF-1 and NF-2
// DELETED — they asserted properties of the relay-owed pause/resume drain
// (`drainPausedOrResumed`/`enqueueRelayForAppliedVerb`), a mechanism this commit removes
// entirely (21b-E8 REVOKED). N3 and its two guards are KEPT byte-identical; unused NF-1/NF-2
// imports (`REPLY_OUTBOX_PER_LINK_CAP`, `PACT_RESERVED_HEADROOM`, `pausePact`, `resumePact`,
// `drainPendingRebindParty`) and their now-orphaned `engagedFederatedPact`/`fillOutboxCap`
// helpers are dropped with them.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import { OrchestrationError } from './orchestration-error'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env_dr140'

describe('S10-21b B20 (D-R140 NF-1/NF-2/N3)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
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

  function seedFederatedPeer(d: OrchestrationDb, remoteAgentId: string, name: string): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId,
      displayName: name,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(d), {
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

  function seedPeerThreadMapping(
    d: OrchestrationDb,
    threadId: string,
    peerThreadId: string,
    peerKey: string
  ): void {
    rawDb(d)
      .prepare(
        `INSERT INTO messages (id, from_handle, to_handle, subject, thread_id, peer_link_device_id, peer_thread_id)
         VALUES (?, ?, 'host', 's', ?, ?, ?)`
      )
      .run(`msg_seed_${threadId}`, peerKey, threadId, ENV, peerThreadId)
  }

  function inboundArgs(
    overrides: Partial<ApplyInboundPactVerbArgs> & {
      toAgentId: string
      senderAgentId: string
      peerThreadId: string | null
    }
  ): ApplyInboundPactVerbArgs {
    return {
      pairedDeviceId: ENV,
      senderEnvironmentId: ENV,
      messageId: 'msg_aaaaaaaaaaa1',
      body: undefined,
      pact: { verb: 'step', seq: 1, era: 0 },
      ...overrides
    }
  }

  // -----------------------------------------------------------------------------------------
  // D-R140 N3 (21b-E11) — `bumpProposalBlockWindow` runs AFTER the propose's own transaction
  // commits: applied proposals only. RED at base: a refused retry (bad seq) bumped the window
  // BEFORE the seq check, so a single legitimately-applied propose already read as two arrivals
  // and spuriously suppressed the wait guard's `answer_first` refusal for a still-unanswered
  // first proposal.
  // -----------------------------------------------------------------------------------------
  it('N3: a refused propose retry does not bump the block window (RED at base)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n3')
    const peerKey = seedFederatedPeer(d, 'r_n3', 'peer_n3')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread.id, 'thr_0000000a3001', peerKey)

    // A refused retry — seq must be exactly 1 for a propose (A-F8); this one is refused
    // `pact_out_of_order` before the transaction (and, at base, after the bump).
    expect(() =>
      d.applyInboundPactVerb(
        inboundArgs({
          toAgentId: a,
          senderAgentId: 'r_n3',
          peerThreadId: 'thr_0000000a3001',
          pact: { verb: 'propose', seq: 99, era: 1, stepsTotal: null }
        })
      )
    ).toThrow(OrchestrationError)

    // The corrected retry applies cleanly — the FIRST (and only) applied proposal.
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3',
        peerThreadId: 'thr_0000000a3001',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread.id)?.pact_state).toBe('proposed')

    // Only one APPLIED proposal has ever landed — the wait guard must still treat this as the
    // window-establishing (still-blocking) proposal, not a suppressed re-propose.
    expect(d.isPactProposalReArmSuppressed(peerKey, a)).toBe(false)
  })

  // -----------------------------------------------------------------------------------------
  // N3 guard (b) — an answered-then-re-proposed pair (both APPLIED) still suppresses re-arm,
  // exactly as isProposalReArmSuppressed's unchanged `count >= 2` semantics require. Passes at
  // base too (isProposalReArmSuppressed itself is untouched) — a guard, not a red-at-base test.
  // -----------------------------------------------------------------------------------------
  it('N3 guard: an answered propose followed by a re-propose (both applied) still suppresses re-arm', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n3b')
    const peerKey = seedFederatedPeer(d, 'r_n3b', 'peer_n3b')

    const { thread: thread1 } = d.createThread({
      subject: 's1',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread1.id, 'thr_00000b300001', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3b',
        peerThreadId: 'thr_00000b300001',
        messageId: 'msg_00000b300001',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    // Answered.
    d.declinePact({ ...actor(a), threadId: thread1.id, reasonCode: null })

    const { thread: thread2 } = d.createThread({
      subject: 's2',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread2.id, 'thr_00000b300002', peerKey)
    // A distinct messageId from thread1's own propose — gate 8a's dedupe is scoped by
    // (link, sender, messageId); reusing `inboundArgs`' shared default would collide.
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3b',
        peerThreadId: 'thr_00000b300002',
        messageId: 'msg_00000b300002',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread2.id)?.pact_state).toBe('proposed')

    expect(d.isPactProposalReArmSuppressed(peerKey, a)).toBe(true)
  })

  // -----------------------------------------------------------------------------------------
  // N3 guard (c) — a single, still-unanswered first proposal never suppresses the wait guard.
  // -----------------------------------------------------------------------------------------
  it('N3 guard: a lone unanswered first proposal does not suppress re-arm', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a_n3c')
    const peerKey = seedFederatedPeer(d, 'r_n3c', 'peer_n3c')
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    seedPeerThreadMapping(d, thread.id, 'thr_00000c300000', peerKey)
    d.applyInboundPactVerb(
      inboundArgs({
        toAgentId: a,
        senderAgentId: 'r_n3c',
        peerThreadId: 'thr_00000c300000',
        pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null }
      })
    )
    expect(d.getThread(thread.id)?.pact_state).toBe('proposed')
    expect(d.isPactProposalReArmSuppressed(peerKey, a)).toBe(false)
  })
})
