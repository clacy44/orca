// S10-3 pact spec — shared refusal/lookup plumbing used by pact-propose-accept.ts,
// pact-lifecycle.ts, pact-step.ts and pact-queries.ts. Split out per the max-lines ratchet.
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { getAgentById, writeAgentAudit } from './agent-directory'
import type { AgentRow, ThreadRow } from './types'
import type { PactStepKind } from './pact-types'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function pactWaiterHandle(agentId: string): string {
  return `agent:${agentId}`
}

export type PactActorContext = {
  callerAgentId: string
  callerPaneKey: string | null
  callerHostId: string
}

export function requireThread(db: Database.Database, threadId: string): ThreadRow {
  const thread = db
    .prepare('SELECT * FROM threads WHERE id = ? AND purged_at IS NULL')
    .get(threadId) as ThreadRow | undefined
  if (!thread) {
    throw new OrchestrationError('not_found', `Thread ${threadId} was not found.`)
  }
  return thread
}

export function requireThreadParticipant(
  db: Database.Database,
  threadId: string,
  agentId: string
): void {
  const row = db
    .prepare(
      `SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_key = ? AND left_at IS NULL`
    )
    .get(threadId, agentId)
  if (!row) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: you are not a participant of thread ${threadId}.`,
      { nextSteps: ['orca agents threads'] }
    )
  }
}

// Authority for step/pause/release/decline/accept: only the pact's two named parties, never a
// third thread member (AUTHORITY §).
export function requirePactParticipant(thread: ThreadRow, agentId: string): void {
  if (thread.pact_proposer_agent_id !== agentId && thread.pact_with_agent_id !== agentId) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: you are not a participant of the pact on ${thread.id}.`,
      { nextSteps: [`orca agents pact --show ${thread.id}`] }
    )
  }
}

export function otherPactParticipant(thread: ThreadRow, agentId: string): string {
  return thread.pact_proposer_agent_id === agentId
    ? (thread.pact_with_agent_id as string)
    : (thread.pact_proposer_agent_id as string)
}

export function requireAccountablePeer(
  db: Database.Database,
  callerAgentId: string,
  peerAgentId: string
): AgentRow {
  if (peerAgentId.includes('@')) {
    throw new OrchestrationError(
      'pact_not_federated',
      `Refused: pacts are host-local; ${peerAgentId} names a different host. Coordinate without a pact using orca agents ask.`,
      { nextSteps: ['orca agents ask'] }
    )
  }
  // Major fix (S10-3b review, RISK 3): a pact needs two accountable participants — a pact with
  // yourself engages with turn = self, otherPactParticipant() returns self, and every `step`
  // hands the turn right back, so getTurnsHeldBy(self) is permanently non-empty and K24's
  // host-wide turn guard refuses this agent's every `wait` park, on every thread, forever.
  // Refused before the lookup below so a typo'd `--with <own name>` cannot even resolve.
  if (peerAgentId === callerAgentId) {
    throw new OrchestrationError(
      'pact_self',
      'Refused: a pact needs two accountable participants — you cannot propose a pact with yourself. ' +
        'Coordinate without a pact using orca agents ask.',
      { nextSteps: ['orca agents ask'] }
    )
  }
  const peer = getAgentById(db, peerAgentId)
  if (!peer) {
    throw new OrchestrationError('agent_unknown', `Agent ${peerAgentId} was not found.`, {
      nextSteps: ['orca agents find "<plain English description>"', 'orca agents list']
    })
  }
  if (peer.quarantined === 1) {
    throw new OrchestrationError(
      'agent_quarantined',
      `Refused: a pact needs two accountable participants and ${peer.display_name} is quarantined. ` +
        `Lift it (orca agents quarantine ${peer.display_name} --lift) or coordinate without a pact using orca agents ask.`,
      { nextSteps: [`orca agents quarantine ${peer.display_name} --lift`, 'orca agents ask'] }
    )
  }
  return peer
}

export function requireSensitiveMembership(
  db: Database.Database,
  thread: ThreadRow,
  peerAgentId: string,
  peerDisplayName: string
): void {
  if (thread.sensitive !== 1) {
    return
  }
  const row = db
    .prepare(
      `SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_key = ? AND left_at IS NULL`
    )
    .get(thread.id, peerAgentId)
  if (!row) {
    throw new OrchestrationError(
      'sensitive_thread_no_pact',
      `Refused: ${thread.id} is a sensitive thread and ${peerDisplayName} is not a participant. ` +
        `A pact cannot add one - invite them (orca agents invite --thread ${thread.id} --agent ${peerDisplayName}) ` +
        'or open a non-sensitive thread for the coordination.',
      { nextSteps: [`orca agents invite --thread ${thread.id} --agent ${peerDisplayName}`] }
    )
  }
}

function pactProgress(thread: ThreadRow): string {
  return thread.pact_steps_total !== null
    ? `${thread.pact_ordinal}/${thread.pact_steps_total}`
    : `${thread.pact_ordinal} (open)`
}

export function requireUnclaimedPact(thread: ThreadRow): void {
  if (thread.pact_state !== null && thread.pact_state !== 'released') {
    throw new OrchestrationError(
      'pact_exists',
      `Refused: ${thread.id} already has a pact (${thread.pact_state}, ${pactProgress(thread)}). ` +
        `Read it (orca agents pact --show ${thread.id}); a released pact can be proposed on again.`,
      { nextSteps: [`orca agents pact --show ${thread.id}`] }
    )
  }
}

// Symmetric (rev 3): matches either id in either column, 'proposed' or 'engaged'.
export function getEngagedPactWith(
  db: Database.Database,
  agentId: string,
  peerAgentId: string
): ThreadRow | undefined {
  return db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state IN ('proposed','engaged')
       AND ((pact_proposer_agent_id = ? AND pact_with_agent_id = ?)
         OR (pact_proposer_agent_id = ? AND pact_with_agent_id = ?))`
    )
    .get(agentId, peerAgentId, peerAgentId, agentId) as ThreadRow | undefined
}

export function requireNoEngagedPactWithPeer(
  db: Database.Database,
  agentId: string,
  peerAgentId: string,
  peerDisplayName: string
): void {
  const existing = getEngagedPactWith(db, agentId, peerAgentId)
  if (existing) {
    throw new OrchestrationError(
      'pact_exists_with_peer',
      `Refused: you already have a ${existing.pact_state} pact with ${peerDisplayName} on ${existing.id}. ` +
        `One pact per pair at a time - release or finish ${existing.id} first (orca agents pact --show ${existing.id}), then propose here.`,
      { nextSteps: [`orca agents pact --show ${existing.id}`] }
    )
  }
}

export function requireEngaged(thread: ThreadRow): void {
  if (thread.pact_state !== 'engaged') {
    throw new OrchestrationError(
      'pact_not_engaged',
      `Refused: ${thread.id} has no engaged pact (${thread.pact_state ?? 'none'}).`,
      { nextSteps: [`orca agents pact --show ${thread.id}`] }
    )
  }
}

// Major fix (S10-3b review): AUTHORITY § — "a quarantined participant may not step." Read at
// step time (quarantine is a read-time filter, same discipline as CONTAINMENT's ledger
// withholding) so a step made before a quarantine still stands but no new one lands after.
export function requireCallerNotQuarantined(
  db: Database.Database,
  agentId: string,
  threadId: string
): void {
  const agent = getAgentById(db, agentId)
  if (agent?.quarantined === 1) {
    throw new OrchestrationError(
      'agent_quarantined',
      `Refused: ${agent.display_name} is quarantined and a quarantined participant may not step. ` +
        `Lift it (orca agents quarantine ${agent.display_name} --lift) or release the pact ` +
        `(orca agents pact --release --on ${threadId}).`,
      {
        nextSteps: [
          `orca agents quarantine ${agent.display_name} --lift`,
          `orca agents pact --release --on ${threadId}`
        ]
      }
    )
  }
}

export function requirePaused(thread: ThreadRow): void {
  if (thread.pact_paused_at !== null) {
    throw new OrchestrationError(
      'pact_paused',
      `Refused: this pact is paused (${thread.pact_pause_reason}). ` +
        `Resume it (orca agents pact --resume --on ${thread.id}) or release it (orca agents pact --release --on ${thread.id}).`,
      {
        nextSteps: [
          `orca agents pact --resume --on ${thread.id}`,
          `orca agents pact --release --on ${thread.id}`
        ]
      }
    )
  }
}

export type InsertPactStepRowParams = {
  threadId: string
  ordinal: number
  kind: PactStepKind
  actorAgentId: string | null
  actorPaneKey: string | null
  actorHostId: string | null
  messageId: string | null
  summary: string | null
  turnAfterAgentId: string | null
  reasonCode: string | null
}

// pact_era (blocker fix, S10-3b review): stamped from threads.pact_era at write time, never
// passed in by callers — every proposePact/acceptPact/appendPactStep/etc. call already runs
// inside the row's own BEGIN IMMEDIATE after the era (re-)propose bump, so this read always
// sees the era the row is actually being written under. idx_pact_step_ordinal keys on it so a
// re-propose's ordinal 1 never collides with a still-present prior era's ordinal 1 (ruling 2:
// the ledger is append-only, so the prior era's rows are never gone).
export function insertPactStepRow(db: Database.Database, params: InsertPactStepRowParams): void {
  const eraRow = db.prepare('SELECT pact_era FROM threads WHERE id = ?').get(params.threadId) as
    | { pact_era: number }
    | undefined
  db.prepare(
    `INSERT INTO pact_steps
       (thread_id, pact_era, ordinal, kind, actor_agent_id, actor_pane_key, actor_host_id,
        message_id, summary, summary_sha256, turn_after_agent_id, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.threadId,
    eraRow?.pact_era ?? 0,
    params.ordinal,
    params.kind,
    params.actorAgentId,
    params.actorPaneKey,
    params.actorHostId,
    params.messageId,
    params.summary,
    sha256Hex(params.summary ?? ''),
    params.turnAfterAgentId,
    params.reasonCode
  )
}

export function auditPact(
  db: Database.Database,
  params: {
    agentId: string | null
    actorPaneKey: string | null
    actorHostId: string | null
    verb: string
    outcome: string
    reasonCode?: string | null
  }
): void {
  writeAgentAudit(db, {
    agentId: params.agentId,
    actorPaneKey: params.actorPaneKey,
    actorHostId: params.actorHostId,
    verb: params.verb,
    outcome: params.outcome,
    reasonCode: params.reasonCode ?? null
  })
}
