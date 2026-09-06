// S10-21b B10 (design §2.13, Ruling 34 Addendum 4 amendment 14) — T30: simultaneous
// cross-propose tie-break. Every test here fails at base 151845af72: pact-federated-
// propose-race.ts does not exist, and applyPropose only ever refuses a second propose via
// requireUnclaimedPact on the RESOLVED thread's own column — it never declines the loser, never
// applies the winner, and never catches a re-registered-duplicate proposal landing on a fresh
// thread.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { resolveCrossProposeOutcome } from './pact-federated-propose-race'
import { OrchestrationError } from './orchestration-error'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import type { ThreadRow } from './types'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function expectRefusalCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected a refusal (${code}), got none`)
  } catch (err) {
    expect(err).toBeInstanceOf(OrchestrationError)
    expect((err as OrchestrationError).code).toBe(code)
  }
}

const ENV = 'env1'
// Grammar minimum/maximum 12-hex thread ids (orchestration-id-grammar.ts) — a real thread id
// minted by `createThread` (randomBytes(6).toString('hex')) sorts strictly between these with
// probability 1 - 2^-48, the same determinism margin the rest of this suite accepts for
// randomly-minted ids.
const THREAD_ID_MIN = 'thr_000000000000'
const THREAD_ID_MAX = 'thr_ffffffffffff'

describe('pact-federated-propose-race (S10-21b B10, T30)', () => {
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

  function seedFederatedPeer(
    d: OrchestrationDb,
    remoteAgentId: string,
    displayName: string
  ): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId,
      displayName,
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

  // `a` proposes locally to the federated peer `peerKey` — the outstanding proposal the peer's
  // own simultaneous propose races against. `peerThreadId` seeds the mail-thread mapping an
  // ordinary exchange would already have left (§1.4), so an inbound propose with the same
  // wire `threadId` resolves onto THIS SAME thread rather than a fresh one.
  function localOutstandingPropose(
    d: OrchestrationDb,
    a: string,
    peerKey: string,
    peerThreadId: string
  ): ThreadRow {
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    rawDb(d)
      .prepare(`UPDATE threads SET pact_peer_thread_id = ? WHERE id = ?`)
      .run(peerThreadId, thread.id)
    return d.proposePact({
      ...actor(a),
      threadId: thread.id,
      peerAgentId: peerKey,
      stepsTotal: null
    })
  }

  function inboundProposeArgs(
    overrides: Partial<ApplyInboundPactVerbArgs> & {
      toAgentId: string
      senderAgentId: string
      peerThreadId: string
    }
  ): ApplyInboundPactVerbArgs {
    return {
      pairedDeviceId: ENV,
      senderEnvironmentId: ENV,
      messageId: 'msg_aaaaaaaaaaa1',
      body: undefined,
      pact: { verb: 'propose', seq: 1, era: 1, stepsTotal: null },
      ...overrides
    }
  }

  // -------------------------------------------------------------------------------------------
  // The comparison predicate itself: symmetric, deterministic, never a function of arrival
  // order. Both hosts run this SAME function with their own thread as "local" and the wire
  // value as "incoming" — proving it is lower-id-wins on both a lower-incoming and a
  // higher-incoming input demonstrates the two real hosts converge on the same winner.
  // -------------------------------------------------------------------------------------------
  it('T30: the tie-break predicate — lower originating thread id always wins, whichever side is "local"', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer(d, 'r1', 'peer-x')
    const thread = localOutstandingPropose(d, a, peerKey, 'thr_seed00000a1')

    const argsIncomingLower = inboundProposeArgs({
      toAgentId: a,
      senderAgentId: 'r1',
      peerThreadId: THREAD_ID_MIN
    })
    expect(resolveCrossProposeOutcome(rawDb(d), thread, argsIncomingLower, peerKey)).toBe(
      'incoming_wins'
    )

    const argsIncomingHigher = inboundProposeArgs({
      toAgentId: a,
      senderAgentId: 'r1',
      peerThreadId: THREAD_ID_MAX
    })
    // Local wins — the ordinary requireUnclaimedPact refusal fires, no new refusal path.
    expectRefusalCode(
      () => resolveCrossProposeOutcome(rawDb(d), thread, argsIncomingHigher, peerKey),
      'pact_exists'
    )
  })

  // -------------------------------------------------------------------------------------------
  // Full apply: incoming wins ⇒ local proposal auto-declined (real ledger row + relay), then
  // the incoming propose applies, in that order.
  // -------------------------------------------------------------------------------------------
  it('T30: incoming propose wins ⇒ local proposal declined (ledger row + relay) before the incoming propose applies', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKey = seedFederatedPeer(d, 'r1', 'peer-x')
    const thread = localOutstandingPropose(d, a, peerKey, THREAD_ID_MIN)

    const result = d.applyInboundPactVerb(
      inboundProposeArgs({ toAgentId: a, senderAgentId: 'r1', peerThreadId: THREAD_ID_MIN })
    )
    expect(result.accepted).toBe(true)

    const declineStep = rawDb(d)
      .prepare(
        `SELECT kind, reason_code, relay_state FROM pact_steps WHERE thread_id = ? AND kind = 'decline'`
      )
      .get(thread.id) as { kind: string; reason_code: string; relay_state: string } | undefined
    expect(declineStep?.kind).toBe('decline')
    expect(declineStep?.reason_code).toBe('pact_cross_propose_race')
    expect(declineStep?.relay_state).toBe('pending')

    const outboxRow = rawDb(d)
      .prepare(
        `SELECT relay_kind FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_decline'`
      )
      .get(thread.id) as { relay_kind: string } | undefined
    expect(outboxRow?.relay_kind).toBe('pact_decline')

    const row = rawDb(d)
      .prepare(
        `SELECT pact_state, pact_proposer_agent_id, pact_with_agent_id FROM threads WHERE id = ?`
      )
      .get(thread.id) as {
      pact_state: string
      pact_proposer_agent_id: string
      pact_with_agent_id: string
    }
    expect(row.pact_state).toBe('proposed')
    expect(row.pact_proposer_agent_id).toBe(peerKey)
    expect(row.pact_with_agent_id).toBe(a)
  })

  // -------------------------------------------------------------------------------------------
  // The re-registered-duplicate case (T30's second assertion): B3's (link, display_name)
  // conjunct still refuses, even though a naive per-resolved-thread tie-break would let it
  // through onto a fresh, unclaimed thread.
  // -------------------------------------------------------------------------------------------
  it('T30: a re-registered duplicate peer (same link + display_name, new remote id) is refused even on a FRESH thread', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const peerKeyOld = seedFederatedPeer(d, 'r1', 'peer-x')
    localOutstandingPropose(d, a, peerKeyOld, 'thr_seed00000b1')

    // Re-registration: a second remote_agents row, same (environment_id, display_name), a new
    // remote_agent_id — the identity fallback matches on (link, display_name), never the id.
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId: 'r2',
      displayName: 'peer-x',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })

    // A FRESH, unclaimed thread — requireUnclaimedPact alone would pass this thread; only the
    // identity-aware pair guard sees the conflict.
    const { thread: freshThread } = d.createThread({
      subject: 's2',
      createdByAgentId: a,
      participants: [{ participantKey: a, agentId: a }]
    })
    const peerThreadId = 'thr_222222222222'
    rawDb(d)
      .prepare(
        `UPDATE threads SET pact_peer_link_device_id = ?, pact_peer_thread_id = ? WHERE id = ?`
      )
      .run(ENV, peerThreadId, freshThread.id)

    expectRefusalCode(
      () =>
        d.applyInboundPactVerb(
          inboundProposeArgs({ toAgentId: a, senderAgentId: 'r2', peerThreadId })
        ),
      'pact_exists_with_peer'
    )
  })
})
