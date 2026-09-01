// S10-8 review fix (blocker: quarantine does not cross the link at read time). Regression for
// the LIVE PROOF in the finding: a cross-host peer question has no local `agents` row for its
// asker (sender_agent_id is NULL by construction — remote agents never live in `agents`), so the
// pre-fix `liveMessageSqlClause`/`filterLiveMessageRows` always passed it through regardless of
// `remote_agents.remote_quarantined`/`local_quarantined`. These tests exercise the real
// `OrchestrationDb` write path (`createPeerQuestion`, the same helper
// orchestration-federated-peer-ask.ts calls) and the real read path (`getUnreadMessages`,
// `filterLiveMessageRows`'s own caller) rather than re-deriving the SQL by hand.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb, PEER_RUN_ID } from './db'
import { filterLiveMessageRows } from './message-visibility-filter'

// OrchestrationDb keeps its raw handle private; filterLiveMessageRows needs it directly (it is
// the row-materialized read path's own entry point, not exposed as an OrchestrationDb method) —
// same access pattern orchestration-federated-peer-ask.test.ts's findPendingPeerQuestion uses.
function rawHandle(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV_ID = 'dev_peer_link_1'
const REMOTE_AGENT_ID = 'agt_f76cc37e67d9'

describe('cross-host quarantine at read time (S10-8 review fix)', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  function setupRecipientAndCrossHostMessage(): { toHandle: string; toAgentId: string } {
    db = new OrchestrationDb(':memory:')
    const recipient = db.upsertAgentByPaneSuffix({
      displayName: 'recipient',
      role: null,
      hostId: 'local',
      paneKey: 'tab:recipient-pane',
      terminalHandle: 'term_recipient',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_recipient',
      originHostId: 'local'
    })
    if (recipient.outcome === 'name_taken') {
      throw new Error('unexpected name collision in fixture')
    }
    const toAgentId = recipient.agent.id
    const toHandle = `agent:${toAgentId}`
    const askerHandle = `remote:${ENV_ID}:${REMOTE_AGENT_ID}`
    const { thread } = db.createThread({
      subject: 'cross-host question',
      createdByAgentId: null,
      origin: 'question',
      participants: [
        { participantKey: askerHandle, agentId: null, handle: askerHandle, role: 'owner' },
        { participantKey: toAgentId, agentId: toAgentId, handle: toHandle, role: 'member' }
      ]
    })
    const created = db.createPeerQuestion({
      runId: PEER_RUN_ID,
      threadId: thread.id,
      askerHandle,
      toAgentId,
      toHandle,
      question: 'CROSSHOST poison from quarantined agent',
      infraAllowlist: []
    })
    if (created.outcome === 'refused') {
      throw new Error('unexpected gate refusal in fixture')
    }
    db.upsertRemoteAgent({
      environmentId: ENV_ID,
      environmentName: ENV_ID,
      linkKind: 'paired_device',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'quarantined-remote',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    return { toHandle, toAgentId }
  }

  it('withholds via getUnreadMessages once the origin host asserts the sender quarantined (remote_quarantined)', () => {
    const { toHandle } = setupRecipientAndCrossHostMessage()
    expect(db.getUnreadMessages(toHandle)).toHaveLength(1)

    db.upsertRemoteAgent({
      environmentId: ENV_ID,
      environmentName: ENV_ID,
      linkKind: 'paired_device',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'quarantined-remote',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: true
    })

    expect(db.getUnreadMessages(toHandle)).toHaveLength(0)
  })

  it('withholds via getUnreadMessages once this host locally quarantines the remote sender (local_quarantined)', () => {
    const { toHandle } = setupRecipientAndCrossHostMessage()
    expect(db.getUnreadMessages(toHandle)).toHaveLength(1)

    db.setLocalRemoteAgentQuarantine({
      environmentId: ENV_ID,
      remoteAgentId: REMOTE_AGENT_ID,
      quarantined: true,
      reasonCode: 'operator_quarantine'
    })

    expect(db.getUnreadMessages(toHandle)).toHaveLength(0)
  })

  it('filterLiveMessageRows (the row-materialized read path) withholds the same message and counts it', () => {
    const { toHandle } = setupRecipientAndCrossHostMessage()
    const before = db.getUnreadMessages(toHandle)
    expect(before).toHaveLength(1)

    db.setLocalRemoteAgentQuarantine({
      environmentId: ENV_ID,
      remoteAgentId: REMOTE_AGENT_ID,
      quarantined: true,
      reasonCode: null
    })

    // Re-materialize the SAME already-fetched row by id (mirrors a frozen delivery batch) — the
    // filter re-reads current quarantine state rather than trusting the stale in-memory row.
    const { messages, omitted } = filterLiveMessageRows(rawHandle(db), before)
    expect(messages).toHaveLength(0)
    expect(omitted.withheld).toBe(1)
  })

  it('a message from a NEVER-quarantined remote sender is unaffected (no false-positive withholding)', () => {
    const { toHandle } = setupRecipientAndCrossHostMessage()
    expect(db.getUnreadMessages(toHandle)).toHaveLength(1)
  })

  // S10-15 D5 Rule 3 / breaker finding 7's read-time companion: a message stored under the
  // paired_device row's handle must be withheld once the operator locally quarantines the SAME
  // peer agent's environment-kind row — this is the containment hole a naive second keying
  // opens, and the reason the local_quarantined union exists.
  it('a message under the paired_device handle is withheld once the same peer agent is locally quarantined on its OTHER (environment) row', () => {
    const { toHandle } = setupRecipientAndCrossHostMessage()
    expect(db.getUnreadMessages(toHandle)).toHaveLength(1)

    // The same remote_agent_id, mirrored a second time under an 'environment' link — the only
    // addressable kind (D5 Rule 2) and the row an operator would actually quarantine.
    db.upsertRemoteAgent({
      environmentId: 'env_saved_dual',
      environmentName: 'saved-environment',
      linkKind: 'environment',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'quarantined-remote',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })

    db.setLocalRemoteAgentQuarantine({
      remoteAgentId: REMOTE_AGENT_ID,
      quarantined: true,
      reasonCode: 'operator_review',
      allLinks: true
    })

    expect(db.getUnreadMessages(toHandle)).toHaveLength(0)
  })
})
