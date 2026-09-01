// S10-15 D2/D3/ruling 2/ruling 3(b): the shared inbound-identity importer, extracted byte-
// identically out of orchestration-federated-peer-ask.ts, plus its ruling-2 (peer-fingerprint
// binding) and ruling-3(b) (per-link cap) amendments.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb, REMOTE_AGENTS_PER_LINK_CAP } from './db'
import {
  buildFederatedSenderIdentity,
  importFederatedSenderIdentity
} from './federated-sender-identity'

describe('buildFederatedSenderIdentity', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('returns undefined for an unknown agent id', () => {
    db = new OrchestrationDb(':memory:')
    expect(buildFederatedSenderIdentity(db, 'agt_deadbeef0000')).toBeUndefined()
  })

  it('carries quarantined: true for a quarantined row (never hardcoded false)', () => {
    db = new OrchestrationDb(':memory:')
    const registered = db.upsertAgentByPaneSuffix({
      displayName: 'asker',
      role: null,
      hostId: 'local',
      paneKey: 'tab:asker-pane',
      terminalHandle: 'term_asker',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_asker',
      originHostId: 'local'
    })
    if (registered.outcome === 'name_taken') {
      throw new Error('unexpected name collision in fixture')
    }
    db.setAgentQuarantine({ id: registered.agent.id, quarantined: true, reasonCode: 'review' })
    const identity = buildFederatedSenderIdentity(db, registered.agent.id)
    expect(identity).toMatchObject({ id: registered.agent.id, quarantined: true })
  })
})

describe('importFederatedSenderIdentity — refactor-fidelity table (D2 test 1)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  const LINK = 'dev_link_1'
  const FP = 'fp_link_1'

  it('id_shape: bad id shape refuses invalid_argument with the exact literal', () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'not-a-real-id', displayName: 'ghost' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('invalid')
    if (result.outcome !== 'invalid') {
      throw new Error('unreachable')
    }
    expect(result.reason).toBe('id_shape')
    expect(result.error.code).toBe('invalid_argument')
    expect(result.error.message).toBe('The relayed sender id is not a valid agent directory id.')
    expect((result.error.data as { nextSteps: string[] }).nextSteps).toEqual([
      'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
    ])
  })

  it('local_collision: an id colliding with a local agents row refuses invalid_argument', () => {
    db = new OrchestrationDb(':memory:')
    const registered = db.upsertAgentByPaneSuffix({
      displayName: 'trusted-lead',
      role: null,
      hostId: 'local',
      paneKey: 'tab:local-pane',
      terminalHandle: 'term_local',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_local',
      originHostId: 'local'
    })
    if (registered.outcome === 'name_taken') {
      throw new Error('unexpected name collision')
    }
    const result = importFederatedSenderIdentity(db, {
      identity: { id: registered.agent.id, displayName: 'trusted-lead' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('invalid')
    if (result.outcome !== 'invalid') {
      throw new Error('unreachable')
    }
    expect(result.reason).toBe('local_collision')
    expect(result.error.code).toBe('invalid_argument')
    expect(result.error.message).toBe(
      'The relayed sender id collides with an agent already registered on this host.'
    )
    expect((result.error.data as { nextSteps: string[] }).nextSteps).toEqual([
      'verify the paired link is a genuine remote peer, not a loop back to this same host'
    ])
  })

  it('display_name: an unaddressable display name refuses invalid_argument', () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000003', displayName: '_' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('invalid')
    if (result.outcome !== 'invalid') {
      throw new Error('unreachable')
    }
    expect(result.reason).toBe('display_name')
    expect(result.error.code).toBe('invalid_argument')
    expect(result.error.message).toBe('The relayed sender display name is not addressable.')
  })

  it('local_quarantined: refuses agent_quarantined and upsertRemoteAgent still ran first (last_seen_at advanced) — D2 test 2', () => {
    db = new OrchestrationDb(':memory:')
    const first = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(first.outcome).toBe('imported')
    db.setLocalRemoteAgentQuarantine({
      environmentId: LINK,
      remoteAgentId: 'agt_000000000001',
      quarantined: true,
      reasonCode: 'operator_review'
    })
    const before = db
      .listRemoteAgents({ environmentId: LINK, includeQuarantined: true })
      .find((r) => r.remote_agent_id === 'agt_000000000001')!
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('quarantined')
    if (result.outcome !== 'quarantined') {
      throw new Error('unreachable')
    }
    expect(result.scope).toBe('local')
    expect(result.error.code).toBe('agent_quarantined')
    expect(result.error.message).toBe(
      `peer-one@${LINK} is quarantined on this host and cannot ask.`
    )
    const after = db
      .listRemoteAgents({ environmentId: LINK, includeQuarantined: true })
      .find((r) => r.remote_agent_id === 'agt_000000000001')!
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.last_seen_at).getTime()
    )
  })

  it('remote_quarantined: refuses agent_quarantined with the origin-host message', () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000002', displayName: 'ghost', quarantined: true },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('quarantined')
    if (result.outcome !== 'quarantined') {
      throw new Error('unreachable')
    }
    expect(result.scope).toBe('remote')
    expect(result.error.code).toBe('agent_quarantined')
    expect(result.error.message).toBe(
      `ghost@${LINK} is quarantined on its origin host and cannot ask.`
    )
  })

  // S10-15 review m-5/m-6: the shared refusal text hardcoded "cannot ask" even when the caller
  // was federatedSend (the SEND path) — verb is now caller-supplied, default 'ask' preserving
  // federatedAsk's existing wording byte-for-byte.
  it('verb: "send" renders "cannot send" for a locally-quarantined sender (m-5/m-6)', () => {
    db = new OrchestrationDb(':memory:')
    importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000005', displayName: 'peer-five' },
      linkKey: LINK,
      peerFingerprint: FP,
      verb: 'send'
    })
    db.setLocalRemoteAgentQuarantine({
      environmentId: LINK,
      remoteAgentId: 'agt_000000000005',
      quarantined: true,
      reasonCode: 'operator_review'
    })
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000005', displayName: 'peer-five' },
      linkKey: LINK,
      peerFingerprint: FP,
      verb: 'send'
    })
    expect(result.outcome).toBe('quarantined')
    if (result.outcome !== 'quarantined') {
      throw new Error('unreachable')
    }
    expect(result.error.message).toBe(
      `peer-five@${LINK} is quarantined on this host and cannot send.`
    )
  })

  it('verb: "send" renders "cannot send" for a remote-quarantined sender (m-5/m-6)', () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000006', displayName: 'ghost-send', quarantined: true },
      linkKey: LINK,
      peerFingerprint: FP,
      verb: 'send'
    })
    expect(result.outcome).toBe('quarantined')
    if (result.outcome !== 'quarantined') {
      throw new Error('unreachable')
    }
    expect(result.error.message).toBe(
      `ghost-send@${LINK} is quarantined on its origin host and cannot send.`
    )
  })

  it("host: 'local' (any case) never renders — D1 amendment means host is never sent or read; environment_name always falls back to the link key (D2 test 3)", () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000004', displayName: 'sneaky' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('imported')
    if (result.outcome !== 'imported') {
      throw new Error('unreachable')
    }
    expect(result.hostLabel).toBe('')
    expect(result.row.environment_name).not.toBe('local')
    expect(result.row.environment_name).toBe(LINK)
  })

  it('absent identity returns outcome "absent"', () => {
    db = new OrchestrationDb(':memory:')
    expect(
      importFederatedSenderIdentity(db, { identity: undefined, linkKey: LINK, peerFingerprint: FP })
    ).toEqual({ outcome: 'absent' })
  })

  it('a clean import mints askerHandle = remote:<linkKey>:<remoteAgentId> and link_kind=paired_device', () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000005', displayName: 'peer-five' },
      linkKey: LINK,
      peerFingerprint: FP
    })
    expect(result.outcome).toBe('imported')
    if (result.outcome !== 'imported') {
      throw new Error('unreachable')
    }
    expect(result.askerHandle).toBe(`remote:${LINK}:agt_000000000005`)
    expect(result.row.link_kind).toBe('paired_device')
    expect(result.row.peer_fingerprint).toBe(FP)
  })
})

describe('S10-15 ruling 2: peer-fingerprint <-> link binding', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('first use binds the fingerprint to the link (TOFU)', () => {
    db = new OrchestrationDb(':memory:')
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: 'link_a',
      peerFingerprint: 'fp_a'
    })
    expect(result.outcome).toBe('imported')
    expect(db.getBoundPeerFingerprintForLink('link_a')).toBe('fp_a')
  })

  it('same-link changed fingerprint is refused (link_changed)', () => {
    db = new OrchestrationDb(':memory:')
    importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: 'link_a',
      peerFingerprint: 'fp_a'
    })
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000002', displayName: 'peer-two' },
      linkKey: 'link_a',
      peerFingerprint: 'fp_a_rotated'
    })
    expect(result.outcome).toBe('fingerprint_conflict')
    if (result.outcome !== 'fingerprint_conflict') {
      throw new Error('unreachable')
    }
    expect(result.scope).toBe('link_changed')
    // No new row written for the refused identity.
    expect(db.hasRemoteAgent('link_a', 'agt_000000000002')).toBe(false)
  })

  it('cross-link duplicate fingerprint is refused (cross_link_duplicate)', () => {
    db = new OrchestrationDb(':memory:')
    importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: 'link_a',
      peerFingerprint: 'fp_shared'
    })
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000002', displayName: 'peer-two' },
      linkKey: 'link_b',
      peerFingerprint: 'fp_shared'
    })
    expect(result.outcome).toBe('fingerprint_conflict')
    if (result.outcome !== 'fingerprint_conflict') {
      throw new Error('unreachable')
    }
    expect(result.scope).toBe('cross_link_duplicate')
    expect(db.hasRemoteAgent('link_b', 'agt_000000000002')).toBe(false)
  })

  it('the SAME fingerprint on the SAME link across repeated contacts is never refused', () => {
    db = new OrchestrationDb(':memory:')
    importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: 'link_a',
      peerFingerprint: 'fp_a'
    })
    const second = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000001', displayName: 'peer-one' },
      linkKey: 'link_a',
      peerFingerprint: 'fp_a'
    })
    expect(second.outcome).toBe('imported')
  })
})

describe('S10-15 ruling 3(b): REMOTE_AGENTS_PER_LINK_CAP', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('the 65th DISTINCT remote agent on one link refuses the mirror write; mail/ask still proceeds (capped, not thrown)', () => {
    db = new OrchestrationDb(':memory:')
    const LINK = 'flood_link'
    for (let i = 0; i < REMOTE_AGENTS_PER_LINK_CAP; i++) {
      const id = `agt_${i.toString(16).padStart(12, '0')}`
      const result = importFederatedSenderIdentity(db, {
        identity: { id, displayName: `peer-${i}` },
        linkKey: LINK,
        peerFingerprint: 'fp_flood'
      })
      expect(result.outcome).toBe('imported')
    }
    expect(db.countRemoteAgentsForLink(LINK)).toBe(REMOTE_AGENTS_PER_LINK_CAP)

    const overflowId = `agt_${REMOTE_AGENTS_PER_LINK_CAP.toString(16).padStart(12, '0')}`
    const capped = importFederatedSenderIdentity(db, {
      identity: { id: overflowId, displayName: 'flood-agent' },
      linkKey: LINK,
      peerFingerprint: 'fp_flood'
    })
    expect(capped.outcome).toBe('capped')
    if (capped.outcome !== 'capped') {
      throw new Error('unreachable')
    }
    // The mirror write was refused: no new row, count unchanged.
    expect(db.hasRemoteAgent(LINK, overflowId)).toBe(false)
    expect(db.countRemoteAgentsForLink(LINK)).toBe(REMOTE_AGENTS_PER_LINK_CAP)
    // But the caller still gets a usable askerHandle — the ask/mail is never blocked by the cap.
    expect(capped.askerHandle).toBe(`remote:${LINK}:${overflowId}`)
  })

  it('a flood never evicts the legitimate row (no eviction-by-recency)', () => {
    db = new OrchestrationDb(':memory:')
    const LINK = 'flood_link_2'
    const legitimate = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_11ee11ee1100', displayName: 'legit-peer' },
      linkKey: LINK,
      peerFingerprint: 'fp_flood2'
    })
    expect(legitimate.outcome).toBe('imported')
    for (let i = 1; i < REMOTE_AGENTS_PER_LINK_CAP; i++) {
      const id = `agt_${i.toString(16).padStart(12, '0')}`
      importFederatedSenderIdentity(db, {
        identity: { id, displayName: `peer-${i}` },
        linkKey: LINK,
        peerFingerprint: 'fp_flood2'
      })
    }
    // One more distinct id past the cap.
    importFederatedSenderIdentity(db, {
      identity: { id: 'agt_0ff10ff10ff1', displayName: 'overflow' },
      linkKey: LINK,
      peerFingerprint: 'fp_flood2'
    })
    expect(db.hasRemoteAgent(LINK, 'agt_11ee11ee1100')).toBe(true)
  })

  it('an UPDATE to an already-mirrored row never counts against, or is blocked by, the cap', () => {
    db = new OrchestrationDb(':memory:')
    const LINK = 'update_link'
    for (let i = 0; i < REMOTE_AGENTS_PER_LINK_CAP; i++) {
      const id = `agt_${i.toString(16).padStart(12, '0')}`
      importFederatedSenderIdentity(db, {
        identity: { id, displayName: `peer-${i}` },
        linkKey: LINK,
        peerFingerprint: 'fp_update'
      })
    }
    // Re-contact from the FIRST agent again — an update, not a new distinct row.
    const result = importFederatedSenderIdentity(db, {
      identity: { id: 'agt_000000000000', displayName: 'peer-0-renamed' },
      linkKey: LINK,
      peerFingerprint: 'fp_update'
    })
    expect(result.outcome).toBe('imported')
    expect(db.countRemoteAgentsForLink(LINK)).toBe(REMOTE_AGENTS_PER_LINK_CAP)
  })
})
