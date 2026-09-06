// S10-21b B3 (design §1.1-1.4, §2.13, §4.4) — party identity + repoint. Every test here fails
// against the B2 base (562203af47): pact-federated-identity.ts does not exist yet, and neither
// requireAccountablePeer nor the pair-guard's identity fallback resolve a federated party.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { requireAccountablePeer, requireNoEngagedPactWithPeer } from './pact-shared'
import {
  isFederatedPact,
  renderFederatedPartyKey,
  repointFederatedPactParty
} from './pact-federated-identity'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('pact-federated-identity', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedAgent(
    d: OrchestrationDb,
    id: string,
    overrides: Partial<UpsertAgentByPaneSuffixParams> = {}
  ): string {
    const result = d.upsertAgentByPaneSuffix({
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
      originHostId: 'local',
      ...overrides
    })
    if (result.outcome === 'name_taken') {
      throw new Error(`seedAgent: name taken for ${id}`)
    }
    return result.agent.id
  }

  function seedRemoteAgent(
    d: OrchestrationDb,
    params: { environmentId: string; remoteAgentId: string; displayName: string }
  ): void {
    d.upsertRemoteAgent({
      environmentId: params.environmentId,
      environmentName: params.environmentId,
      linkKind: 'paired_device',
      remoteAgentId: params.remoteAgentId,
      displayName: params.displayName,
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
  }

  // ---------------------------------------------------------------------------------------
  // isFederatedPact — one predicate, never a string-prefix test.
  // ---------------------------------------------------------------------------------------
  describe('isFederatedPact', () => {
    it('is true only when pact_peer_agent_id is set, regardless of what the party columns say', () => {
      // A local pact whose stored party id happens to CONTAIN the "remote:" literal (a
      // pathological display-name-derived collision, never minted by this codebase, but the
      // discriminator must not be fooled by it): pact_peer_agent_id stays NULL, so this must
      // read as local. Proves the predicate never inspects pact_proposer_agent_id/
      // pact_with_agent_id's own text.
      expect(
        isFederatedPact({
          pact_peer_agent_id: null
        } as never)
      ).toBe(false)

      expect(
        isFederatedPact({
          pact_peer_agent_id: 'agt_000000000005'
        } as never)
      ).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------------------
  // repointFederatedPactParty
  // ---------------------------------------------------------------------------------------
  describe('repointFederatedPactParty', () => {
    it('rewrites the pact columns, participant row, anchor columns, unsettled outbox rows and one audit row, atomically', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'local-a')
      const oldRemoteId = 'agt_0000000000aa'
      const newRemoteId = 'agt_0000000000bb'
      const oldKey = renderFederatedPartyKey({ linkDeviceId: 'link1', remoteAgentId: oldRemoteId })
      const newKey = renderFederatedPartyKey({ linkDeviceId: 'link2', remoteAgentId: newRemoteId })

      const { thread } = d.createThread({
        subject: 's',
        createdByAgentId: local,
        participants: [
          { participantKey: local, agentId: local },
          { participantKey: oldKey, agentId: null }
        ]
      })

      raw
        .prepare(
          `UPDATE threads SET
             pact_proposer_agent_id = ?, pact_with_agent_id = ?, pact_state = 'engaged',
             pact_turn_agent_id = ?,
             pact_peer_agent_id = ?, pact_peer_link_device_id = 'link1',
             pact_peer_environment_id = 'link1', pact_peer_key_fingerprint = 'fp-old',
             pact_peer_thread_id = 'peer-thread-1'
           WHERE id = ?`
        )
        .run(local, oldKey, oldKey, oldRemoteId, thread.id)

      raw
        .prepare(
          `INSERT INTO peer_link_bindings (
             link_device_id, environment_id, bound_endpoint_id, bound_pairing_revision,
             link_credential_fp, peer_credential_fp, peer_key_fingerprint, proof_protocol,
             proved_at, last_verified_at
           ) VALUES ('link2', 'link2', 'ep', 1, 'lcfp', 'pcfp', 'fp-new', 'proto', 0, 0)`
        )
        .run()

      // One unsettled outbox row for the pact — must be repointed.
      raw
        .prepare(
          `INSERT INTO peer_reply_outbox (
             id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
             peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
             payload, byte_count, created_at, pact_thread_id, settled_at
           ) VALUES ('ob1', 1, 'lm1', 'link1', 'link1', 1, 'pcfp', 'fp-old', 'irtm1', ?, '{}', 2, 0, ?, NULL)`
        )
        .run(oldRemoteId, thread.id)

      // One SETTLED outbox row for the same pact — must NOT be touched.
      raw
        .prepare(
          `INSERT INTO peer_reply_outbox (
             id, seq, local_message_id, link_device_id, environment_id, bound_pairing_revision,
             peer_credential_fp, peer_key_fingerprint, in_reply_to_message_id, peer_agent_id,
             payload, byte_count, created_at, pact_thread_id, settled_at
           ) VALUES ('ob2', 2, 'lm2', 'link1', 'link1', 1, 'pcfp', 'fp-old', 'irtm2', ?, '{}', 2, 0, ?, 12345)`
        )
        .run(oldRemoteId, thread.id)

      repointFederatedPactParty(raw, thread.id, {
        linkDeviceId: 'link2',
        environmentId: 'link2',
        remoteAgentId: newRemoteId,
        reason: 'test_rebind'
      })

      const row = raw.prepare('SELECT * FROM threads WHERE id = ?').get(thread.id) as Record<
        string,
        unknown
      >
      expect(row.pact_proposer_agent_id).toBe(local) // untouched: never held the old key
      expect(row.pact_with_agent_id).toBe(newKey)
      expect(row.pact_turn_agent_id).toBe(newKey)
      expect(row.pact_peer_agent_id).toBe(newRemoteId)
      expect(row.pact_peer_link_device_id).toBe('link2')
      expect(row.pact_peer_environment_id).toBe('link2')
      expect(row.pact_peer_key_fingerprint).toBe('fp-new')

      const participant = raw
        .prepare(`SELECT * FROM thread_participants WHERE thread_id = ? AND participant_key = ?`)
        .get(thread.id, newKey)
      expect(participant).toBeDefined()
      const staleParticipant = raw
        .prepare(`SELECT * FROM thread_participants WHERE thread_id = ? AND participant_key = ?`)
        .get(thread.id, oldKey)
      expect(staleParticipant).toBeUndefined()

      const outbox1 = raw
        .prepare(
          'SELECT peer_agent_id, link_device_id, environment_id FROM peer_reply_outbox WHERE id = ?'
        )
        .get('ob1') as Record<string, unknown>
      expect(outbox1).toEqual({
        peer_agent_id: newRemoteId,
        link_device_id: 'link2',
        environment_id: 'link2'
      })

      const outbox2 = raw
        .prepare(
          'SELECT peer_agent_id, link_device_id, environment_id FROM peer_reply_outbox WHERE id = ?'
        )
        .get('ob2') as Record<string, unknown>
      expect(outbox2).toEqual({
        peer_agent_id: oldRemoteId,
        link_device_id: 'link1',
        environment_id: 'link1'
      })

      const audit = raw
        .prepare(`SELECT * FROM agent_audit WHERE verb = 'repointFederatedPactParty'`)
        .all() as Record<string, unknown>[]
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason_code).toBe('test_rebind')
    })

    it('preserves the current key fingerprint when no peer_link_bindings row exists for the new link', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const { thread } = d.createThread({ subject: 's', createdByAgentId: null, participants: [] })
      raw
        .prepare(
          `UPDATE threads SET
             pact_peer_agent_id = 'agt_0000000000aa', pact_peer_link_device_id = 'link1',
             pact_peer_environment_id = 'link1', pact_peer_key_fingerprint = 'fp-old'
           WHERE id = ?`
        )
        .run(thread.id)

      repointFederatedPactParty(raw, thread.id, {
        linkDeviceId: 'link-unknown',
        environmentId: 'link-unknown',
        remoteAgentId: 'agt_0000000000bb',
        reason: 'test_no_binding'
      })

      const row = raw
        .prepare('SELECT pact_peer_key_fingerprint FROM threads WHERE id = ?')
        .get(thread.id) as { pact_peer_key_fingerprint: string }
      expect(row.pact_peer_key_fingerprint).toBe('fp-old')
    })
  })

  // ---------------------------------------------------------------------------------------
  // requireAccountablePeer's federated arm
  // ---------------------------------------------------------------------------------------
  describe("requireAccountablePeer's federated arm", () => {
    it('resolves a live, unquarantined, unsuperseded remote party', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'caller')
      seedRemoteAgent(d, {
        environmentId: 'link1',
        remoteAgentId: 'agt_0000000000aa',
        displayName: 'peer'
      })
      const key = renderFederatedPartyKey({
        linkDeviceId: 'link1',
        remoteAgentId: 'agt_0000000000aa'
      })
      const result = requireAccountablePeer(raw, local, key)
      expect(result).toEqual({ id: key, display_name: 'peer', federated: true })
    })

    it('refuses agent_quarantined on local_quarantined', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'caller2')
      seedRemoteAgent(d, {
        environmentId: 'link1',
        remoteAgentId: 'agt_0000000000cc',
        displayName: 'peer2'
      })
      raw
        .prepare(`UPDATE remote_agents SET local_quarantined = 1 WHERE remote_agent_id = ?`)
        .run('agt_0000000000cc')
      const key = renderFederatedPartyKey({
        linkDeviceId: 'link1',
        remoteAgentId: 'agt_0000000000cc'
      })
      expect(() => requireAccountablePeer(raw, local, key)).toThrowError(
        expect.objectContaining({ code: 'agent_quarantined' })
      )
    })

    it('refuses agent_quarantined on remote_quarantined', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'caller3')
      d.upsertRemoteAgent({
        environmentId: 'link1',
        environmentName: 'link1',
        linkKind: 'paired_device',
        remoteAgentId: 'agt_0000000000dd',
        displayName: 'peer3',
        role: null,
        state: 'live',
        derived: false,
        remoteQuarantined: true
      })
      const key = renderFederatedPartyKey({
        linkDeviceId: 'link1',
        remoteAgentId: 'agt_0000000000dd'
      })
      expect(() => requireAccountablePeer(raw, local, key)).toThrowError(
        expect.objectContaining({ code: 'agent_quarantined' })
      )
    })

    it('refuses (agent_unknown-shaped) on superseded_at IS NOT NULL', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'caller4')
      seedRemoteAgent(d, {
        environmentId: 'link1',
        remoteAgentId: 'agt_0000000000ee',
        displayName: 'peer4'
      })
      raw
        .prepare(
          `UPDATE remote_agents SET superseded_at = '2026-01-01T00:00:00Z',
             succeeded_by_remote_agent_id = 'agt_0000000000ff' WHERE remote_agent_id = ?`
        )
        .run('agt_0000000000ee')
      const key = renderFederatedPartyKey({
        linkDeviceId: 'link1',
        remoteAgentId: 'agt_0000000000ee'
      })
      expect(() => requireAccountablePeer(raw, local, key)).toThrowError(
        expect.objectContaining({ code: 'agent_unknown' })
      )
    })
  })

  // ---------------------------------------------------------------------------------------
  // The pair guard's new (link, display_name) conjunct (§2.13 / T30 groundwork)
  // ---------------------------------------------------------------------------------------
  describe('requireNoEngagedPactWithPeer — (link, display_name) conjunct', () => {
    it('catches a re-registered duplicate: same link + display_name, different remote_agent_id', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'caller5')
      const oldRemoteId = 'agt_0000000000a1'
      const newRemoteId = 'agt_0000000000a2'
      seedRemoteAgent(d, {
        environmentId: 'linkX',
        remoteAgentId: oldRemoteId,
        displayName: 'dup-peer'
      })
      seedRemoteAgent(d, {
        environmentId: 'linkX',
        remoteAgentId: newRemoteId,
        displayName: 'dup-peer'
      })
      const oldKey = renderFederatedPartyKey({ linkDeviceId: 'linkX', remoteAgentId: oldRemoteId })
      const newKey = renderFederatedPartyKey({ linkDeviceId: 'linkX', remoteAgentId: newRemoteId })

      const { thread } = d.createThread({
        subject: 's',
        createdByAgentId: local,
        participants: [{ participantKey: local, agentId: local }]
      })
      raw
        .prepare(
          `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?,
             pact_with_agent_id = ?, pact_turn_agent_id = ?, pact_peer_agent_id = ? WHERE id = ?`
        )
        .run(local, oldKey, local, oldRemoteId, thread.id)

      // The literal id pair doesn't match (newKey !== oldKey), so only the identity-fallback
      // conjunct can catch this — proving the (link, display_name) extension, not the
      // pre-existing byId path.
      expect(() => requireNoEngagedPactWithPeer(raw, local, newKey, 'dup-peer')).toThrowError(
        expect.objectContaining({ code: 'pact_exists_with_peer' })
      )
    })

    it('does not false-positive across different links with the same display_name', () => {
      const d = freshDb()
      const raw = rawDb(d)
      const local = seedAgent(d, 'caller6')
      const remoteIdA = 'agt_0000000000b1'
      const remoteIdB = 'agt_0000000000b2'
      seedRemoteAgent(d, {
        environmentId: 'linkA',
        remoteAgentId: remoteIdA,
        displayName: 'same-name'
      })
      seedRemoteAgent(d, {
        environmentId: 'linkB',
        remoteAgentId: remoteIdB,
        displayName: 'same-name'
      })
      const keyA = renderFederatedPartyKey({ linkDeviceId: 'linkA', remoteAgentId: remoteIdA })
      const keyB = renderFederatedPartyKey({ linkDeviceId: 'linkB', remoteAgentId: remoteIdB })

      const { thread } = d.createThread({
        subject: 's',
        createdByAgentId: local,
        participants: [{ participantKey: local, agentId: local }]
      })
      raw
        .prepare(
          `UPDATE threads SET pact_state = 'engaged', pact_proposer_agent_id = ?,
             pact_with_agent_id = ?, pact_turn_agent_id = ?, pact_peer_agent_id = ? WHERE id = ?`
        )
        .run(local, keyA, local, remoteIdA, thread.id)

      expect(() => requireNoEngagedPactWithPeer(raw, local, keyB, 'same-name')).not.toThrow()
    })
  })
})
