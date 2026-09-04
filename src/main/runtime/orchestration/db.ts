/* eslint-disable max-lines -- Why: the orchestration DB keeps schema creation, message CRUD, task DAG resolution, and dispatch context management in one class so transactional invariants (e.g. promoteReadyTasks running inside the same writer as updateTaskStatus) are enforced by locality. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  WorkerReportOutcome,
  WorkerReportSettlement,
  RunRow,
  DeliveryRow,
  DeliveryStatus,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  LegacyMailReceiptRow,
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState,
  LegacyWorkerTerminalRecoveryRow,
  FederatedDispatchRow,
  RemoteDispatchAttachmentRow,
  FederationRelayDirection,
  FederationRelayItemRow,
  AgentRow,
  AgentState,
  AgentOriginKind,
  MailboxDeliveryRow,
  MailboxDeliveryStatus,
  AgentAuditRow,
  AgentRateRow,
  ThreadRow,
  ThreadParticipantRow,
  ThreadState
} from './types'
import type { RemoteAgentRow, RemoteAgentLinkKind } from './remote-agent-directory-types'
import type { RelaySeenRow, RelaySeenOutcome } from './federation-relay-seen-types'
import { AUTHENTICATED_TRANSPORT_FALLBACK } from '../principal-link-fingerprint-binding'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { OrchestrationError } from './orchestration-error'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import {
  upsertAgentByPaneSuffix,
  getAgentById as getAgentByIdImpl,
  getAgentByName as getAgentByNameImpl,
  listAgents as listAgentsImpl,
  writeAgentAudit as writeAgentAuditImpl,
  type UpsertAgentByPaneSuffixParams,
  type UpsertAgentByPaneSuffixResult,
  type ListAgentsParams,
  type ListAgentsResult,
  type WriteAgentAuditParams
} from './agent-directory'
import {
  refreshAgentLiveness as refreshAgentLivenessImpl,
  setAgentQuarantine as setAgentQuarantineImpl,
  type RefreshAgentLivenessParams,
  type SetAgentQuarantineParams
} from './agent-liveness-classification'
import { findSoleOrphanedIdentityCandidate } from './agent-pane-rebind'
import {
  catchUpThreadSuccession as catchUpThreadSuccessionImpl,
  type ThreadSuccessionOutcome,
  type UninheritedPredecessorMailOutcome
} from './agent-thread-succession'
import {
  getAgentByIdIncludingTombstoned as getAgentByIdIncludingTombstonedImpl,
  retireAgent as retireAgentImpl,
  type RetireAgentResult
} from './agent-retire'
import {
  checkAndBumpRate as checkAndBumpRateImpl,
  type CheckAndBumpRateParams,
  type RateLimitResult
} from './agent-rate-limit'
import {
  getPeerLinkBinding as getPeerLinkBindingImpl,
  listPeerLinkBindings as listPeerLinkBindingsImpl,
  putPeerLinkBinding as putPeerLinkBindingImpl,
  contestPeerLinkBinding as contestPeerLinkBindingImpl,
  revokePeerLinkBinding as revokePeerLinkBindingImpl,
  unrevokePeerLinkBinding as unrevokePeerLinkBindingImpl,
  resolvePeerLinkBindingContest as resolvePeerLinkBindingContestImpl,
  findBindingsByEnvironment as findBindingsByEnvironmentImpl,
  findBindingCandidateByKeyFingerprint as findBindingCandidateByKeyFingerprintImpl,
  type PeerLinkBindingRow,
  type ContestFirstWinner
} from './link-binding-store'
import {
  A2_DROP_AND_RECREATE_TABLES,
  REPLY_OUTBOX_REPAIR_REJECTED_CODE
} from './link-binding-constants'
import {
  getBindingAttempt as getBindingAttemptImpl,
  listBindingAttempts as listBindingAttemptsImpl,
  putBindingAttempt as putBindingAttemptImpl,
  settleBindingAttempt as settleBindingAttemptImpl,
  putLinkAdvisory as putLinkAdvisoryImpl,
  clearLinkAdvisory as clearLinkAdvisoryImpl,
  bumpMisrouteAdvisories as bumpMisrouteAdvisoriesImpl,
  type BindingAttemptRow,
  type BindingAttemptSettle,
  type LinkAdvisory
} from './link-binding-attempts-store'
import {
  getScanFact as getScanFactImpl,
  listScanFacts as listScanFactsImpl,
  listScanFactLinkIds as listScanFactLinkIdsImpl,
  putScanFact as putScanFactImpl,
  listConfirmObservations as listConfirmObservationsImpl,
  listConfirmObservationLinkIds as listConfirmObservationLinkIdsImpl,
  putConfirmObservation as putConfirmObservationImpl,
  isPeerLinkQuarantined as isPeerLinkQuarantinedImpl,
  getContainment as getContainmentImpl,
  listContainment as listContainmentImpl,
  putContainment as putContainmentImpl,
  liftContainment as liftContainmentImpl,
  deleteBindingsAndAttemptsNotIn as deleteBindingsAndAttemptsNotInImpl,
  deleteBindingsAndAttemptsIn as deleteBindingsAndAttemptsInImpl,
  type ScanFactRow,
  type ConfirmObservationRow,
  type ContainmentRow
} from './link-binding-observations-store'
import {
  enqueueReplyOutbox as enqueueReplyOutboxImpl,
  getReplyOutboxItem as getReplyOutboxItemImpl,
  listReplyOutbox as listReplyOutboxImpl,
  countPendingReplyOutbox as countPendingReplyOutboxImpl,
  cancelQueuedReplyOutbox as cancelQueuedReplyOutboxImpl,
  kickReplyOutboxForLink as kickReplyOutboxForLinkImpl,
  getReplyOutboxItemByLocalMessageId as getReplyOutboxItemByLocalMessageIdImpl,
  markReplyOutboxNotified as markReplyOutboxNotifiedImpl,
  markReplyOutboxDispositionNotice as markReplyOutboxDispositionNoticeImpl,
  replyOutboxLinkLastDispositionNotifiedAt as replyOutboxLinkLastDispositionNotifiedAtImpl,
  nextReplyOutboxWakeAt as nextReplyOutboxWakeAtImpl,
  type EnqueueReplyOutboxParams,
  type ReplyOutboxRow
} from './reply-outbox-store'
import {
  listReplyOutboxHealthRows as listReplyOutboxHealthRowsImpl,
  type ReplyOutboxHealthRow
} from './reply-outbox-health-rows'
import {
  reclaimExpiredReplyOutboxLeases as reclaimExpiredReplyOutboxLeasesImpl,
  claimNextReplyOutboxItem as claimNextReplyOutboxItemImpl,
  settleReplyOutboxItem as settleReplyOutboxItemImpl,
  holdReplyOutboxItem as holdReplyOutboxItemImpl,
  holdReplyOutboxItemLocalEvidence as holdReplyOutboxItemLocalEvidenceImpl,
  holdReplyOutboxItemCollision as holdReplyOutboxItemCollisionImpl,
  retryReplyOutboxItem as retryReplyOutboxItemImpl,
  retargetReplyOutboxItem as retargetReplyOutboxItemImpl,
  replyOutboxLinkLastAdvisoryNotifiedAt as replyOutboxLinkLastAdvisoryNotifiedAtImpl,
  type ReplyOutboxSettle
} from './reply-outbox-lifecycle'
import {
  getOrCreateMailboxDelivery as getOrCreateMailboxDeliveryImpl,
  acknowledgeMailboxDelivery as acknowledgeMailboxDeliveryImpl,
  type GetOrCreateMailboxDeliveryParams,
  type GetOrCreateMailboxDeliveryResult,
  type AcknowledgeMailboxDeliveryResult
} from './peer-mailbox-deliveries'
import type { ThreadSinceCursor } from './thread-replay-since-filter'
import {
  getAgentByPaneKey as getAgentByPaneKeyImpl,
  upsertDerivedAgentForPane as upsertDerivedAgentForPaneImpl,
  pruneStaleDerivedAgents as pruneStaleDerivedAgentsImpl,
  type UpsertDerivedAgentForPaneParams
} from './derived-agent-rows'
import {
  insertGatedMessage as insertGatedMessageImpl,
  payloadValueForGate,
  type InsertGatedMessageParams,
  type InsertGatedMessageResult
} from './message-gate-writer'
import { gateVerdictRefusalError } from './gate-refusal-error'
import { loadInfraAllowlist } from './infra-allowlist'
import {
  filterLiveMessageRows,
  liveMessageSqlClause,
  remoteSenderQuarantinedSqlClause
} from './message-visibility-filter'
import {
  createThread as createThreadImpl,
  getThread as getThreadImpl,
  listThreadsForParticipant as listThreadsForParticipantImpl,
  upsertThreadParticipant as upsertThreadParticipantImpl,
  leaveThread as leaveThreadImpl,
  bumpThreadOnMessage as bumpThreadOnMessageImpl,
  setThreadState as setThreadStateImpl,
  setThreadPact as setThreadPactImpl,
  markThreadRead as markThreadReadImpl,
  getThreadMessagesSince as getThreadMessagesSinceImpl,
  listThreadParticipants as listThreadParticipantsImpl,
  isThreadParticipant as isThreadParticipantImpl,
  type CreateThreadParams,
  type ListThreadsForParticipantParams,
  type UpsertThreadParticipantParams,
  type SetThreadPactParams,
  type GetThreadMessagesSinceOmitted
} from './thread-directory'
import {
  purgeMessage as purgeMessageImpl,
  purgeThread as purgeThreadImpl,
  listMessagesByAuthor as listMessagesByAuthorImpl,
  type PurgeMessageParams,
  type PurgeMessageResult,
  type PurgeThreadParams,
  type PurgeThreadResult,
  type ListMessagesByAuthorParams
} from './message-purge'
import {
  createPeerQuestion as createPeerQuestionImpl,
  answerPeerQuestion as answerPeerQuestionImpl,
  type CreatePeerQuestionParams,
  type CreatePeerQuestionResult,
  type AnswerPeerQuestionParams,
  type AnswerPeerQuestionResult
} from './peer-question'
import {
  proposePact as proposePactImpl,
  acceptPact as acceptPactImpl,
  declinePact as declinePactImpl,
  type ProposePactParams,
  type AcceptPactParams,
  type DeclinePactParams
} from './pact-propose-accept'
import {
  pausePact as pausePactImpl,
  resumePactOrRequest as resumePactOrRequestImpl,
  releasePact as releasePactImpl,
  autoPausePactsForAgent as autoPausePactsForAgentImpl,
  autoPausePactOnThread as autoPausePactOnThreadImpl,
  type PausePactParams,
  type ResumePactParams,
  type ResumePactOutcome,
  type ReleasePactParams,
  type AutoPauseOutcome
} from './pact-lifecycle'
import {
  appendPactStep as appendPactStepImpl,
  type AppendPactStepParams,
  type AppendPactStepResult
} from './pact-step'
import { getEngagedPactWith as getEngagedPactWithImpl } from './pact-shared'
import {
  getPactState as getPactStateImpl,
  getTurnsHeldBy as getTurnsHeldByImpl,
  getPactLedger as getPactLedgerImpl,
  getIncomingUnansweredProposal as getIncomingUnansweredProposalImpl,
  type GetPactLedgerParams
} from './pact-queries'
import type { PactLedgerResult, PactPauseReason } from './pact-types'
import {
  findOrCreatePeerThread as findOrCreatePeerThreadImpl,
  type FindOrCreatePeerThreadParams,
  type FindOrCreatePeerThreadResult
} from './peer-thread-mint'
import type { DispatchInputEvidence } from './dispatch-input-evidence'
import type { DispatchInputObservationTargetRow } from './dispatch-input-observation'
import type { DispatchLivenessCandidateRow } from './dispatch-liveness-window'
import {
  federationSyncHealthFromRow,
  type FederationSyncHealth,
  type FederationSyncHealthRow
} from './federation-sync-health'
import {
  deriveWorkerTerminalListState,
  WORKER_SETTLED_STATES,
  type WorkerTerminalResourceRow,
  type WorkerTerminalArchiveRow,
  type WorkerTerminalArchiveStatus,
  type WorkerTerminalListState,
  type WorkerTerminalOwnershipState,
  type WorkerTerminalRetainedReason
} from './worker-terminal-ownership'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from './context-only-dispatch-release'
import {
  ensureMutationReceiptCapacity,
  migrateMutationReceiptCapacity
} from './mutation-receipt-capacity'
import {
  PEER_ATTACHMENT_RETENTION_MS,
  PEER_ATTACHMENTS_RETAINED_PER_LINK
} from '../peer-profile-constants'

// Why: leaf UUID is the remint-stable pane identity (tab half changes on break-out); exact match covers legacy/unparseable keys.
// S10-19 m11: exported so a peer-owned-pane lookup outside this module can use the same equivalence.
export function isEquivalentPaneKey(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  const aLeaf = parsePaneKey(a)?.leafId
  const bLeaf = parsePaneKey(b)?.leafId
  return Boolean(aLeaf && bLeaf && aLeaf === bLeaf)
}

function parseWorkerTerminalPriorOwnerIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed
      : null
  } catch {
    return null
  }
}

// Why: indexable pre-filter for isEquivalentPaneKey — equal strings and equal leaves both share the
// text after the first ':', so this narrows candidates without deciding equivalence itself.
const RUN_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1)"
const DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1)"

function paneKeyMatchSuffix(paneKey: string): string {
  const colon = paneKey.indexOf(':')
  return colon === -1 ? paneKey : paneKey.slice(colon + 1)
}

export type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  TaskStatus,
  DispatchStatus,
  GateStatus,
  CoordinatorStatus,
  MessageRow,
  TaskRow,
  DispatchContextRow,
  DecisionGateRow,
  CoordinatorRun,
  WorkerReportOutcome,
  WorkerReportSettlement,
  RunRow,
  DeliveryRow,
  DeliveryStatus,
  LegacyAdoptionRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow,
  LegacyMailReceiptRow,
  QuestionRow,
  QuestionStatus,
  MutationReceiptRow,
  MutationState,
  WorkerDispatchRow,
  WorkerDispatchState,
  AgentRow,
  AgentState,
  AgentOriginKind,
  MailboxDeliveryRow,
  MailboxDeliveryStatus,
  AgentAuditRow,
  AgentRateRow
}
export type {
  UpsertAgentByPaneSuffixParams,
  UpsertAgentByPaneSuffixResult,
  ListAgentsParams,
  ListAgentsResult,
  RefreshAgentLivenessParams,
  SetAgentQuarantineParams,
  WriteAgentAuditParams,
  CheckAndBumpRateParams,
  RateLimitResult,
  GetOrCreateMailboxDeliveryParams,
  GetOrCreateMailboxDeliveryResult,
  AcknowledgeMailboxDeliveryResult
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function hashDispatchCapability(capability: string): string {
  return createHash('sha256').update(capability).digest('hex')
}

function addLifecycleRejectionMarker(payload: string | null, code: string, reason: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = payload ? JSON.parse(payload) : {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // Authority reconciliation only reaches this path with object payloads.
  }
  return JSON.stringify({
    ...parsed,
    _orcaLifecycleRejection: { code, reason }
  })
}

function hasLifecycleRejectionMarker(payload: string | null): boolean {
  try {
    const value: unknown = JSON.parse(payload ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const marker = (value as Record<string, unknown>)._orcaLifecycleRejection
    return Boolean(
      marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      typeof (marker as Record<string, unknown>).code === 'string' &&
      typeof (marker as Record<string, unknown>).reason === 'string'
    )
  } catch {
    return false
  }
}

const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

function exposeUtcTimestamp(timestamp: string | null): string | null {
  if (!timestamp || !SQLITE_UTC_TIMESTAMP_RE.test(timestamp)) {
    return timestamp
  }
  return `${timestamp.replace(' ', 'T')}Z`
}

function exposeMessageTimestamps(message: MessageRow): MessageRow {
  // Why: SQLite stores UTC as timezone-less space format for SQL ordering, but RPC/CLI consumers need an explicit offset.
  return {
    ...message,
    created_at: exposeUtcTimestamp(message.created_at) ?? message.created_at,
    delivered_at: exposeUtcTimestamp(message.delivered_at)
  }
}

function exposeMessageListTimestamps(messages: MessageRow[]): MessageRow[] {
  return messages.map(exposeMessageTimestamps)
}

function exposeRunTimestamps(run: RunRow): RunRow {
  return {
    ...run,
    created_at: exposeUtcTimestamp(run.created_at) ?? run.created_at,
    updated_at: exposeUtcTimestamp(run.updated_at) ?? run.updated_at
  }
}

function encodeRunListCursor(run: RunRow): string {
  const cursor: RunListCursor = { createdAt: run.created_at, id: run.id }
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeRunListCursor(value: string): RunListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as RunListCursor).createdAt !== 'string' ||
      typeof (parsed as RunListCursor).id !== 'string'
    ) {
      throw new Error('invalid cursor shape')
    }
    return parsed as RunListCursor
  } catch {
    throw new OrchestrationError('cursor_invalid', 'The Run list cursor is invalid.')
  }
}

function exposeDeliveryTimestamps(delivery: DeliveryRow): DeliveryRow {
  return {
    ...delivery,
    created_at: exposeUtcTimestamp(delivery.created_at) ?? delivery.created_at,
    acknowledged_at: exposeUtcTimestamp(delivery.acknowledged_at)
  }
}

function exposeQuestionTimestamps(question: QuestionRow): QuestionRow {
  return {
    ...question,
    created_at: exposeUtcTimestamp(question.created_at) ?? question.created_at,
    answered_at: exposeUtcTimestamp(question.answered_at),
    closed_at: exposeUtcTimestamp(question.closed_at)
  }
}

function normalizeLegacyQuestionText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function normalizeLegacyQuestionOptions(options: unknown): string {
  if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
    return '[]'
  }
  return JSON.stringify(options.map((option) => option.trim()))
}

function legacyMessageMatchesQuestion(
  message: MessageRow,
  question: string,
  options: string[],
  recipientHandles: readonly string[]
): boolean {
  if (
    !recipientHandles.includes(message.to_handle) ||
    normalizeLegacyQuestionText(message.body) !== normalizeLegacyQuestionText(question)
  ) {
    return false
  }
  try {
    const payload = JSON.parse(message.payload ?? '{}') as { options?: unknown }
    return (
      normalizeLegacyQuestionOptions(payload.options) === normalizeLegacyQuestionOptions(options)
    )
  } catch {
    return false
  }
}

export const LEGACY_RUN_ID = ORCHESTRATION_LEGACY_RUN_ID
// Sentinel Run for peer agent mail (S10-1, A4): `agent:<id>` sends bind here instead of
// defaulting to LEGACY_RUN_ID, so a recipient's `check` sees the row instead of hitting the
// legacy-read-only fence. Not a coordinator Run — orchestration.runUse refuses it (bindRun below).
export const PEER_RUN_ID = 'run_peer_local'

// S10-4 ruling 5: the fingerprint every tokenless caller collapses onto (matches
// `authenticatedCallerFingerprint`'s fallback, rpc/orchestration-mutation-executor.ts) — never
// bindable as a federation home peer. See createRemoteDispatchAttachment below.
const UNAUTHENTICATED_LANE_CALLER_FINGERPRINT = createHash('sha256')
  .update(AUTHENTICATED_TRANSPORT_FALLBACK)
  .digest('hex')

// S10-8 R2: same "authenticated_transport fallback must never qualify" rule, exported so the
// cross-host agent-relay RPCs (orchestration-federated-peer-ask.ts) can refuse it too — a second
// caller of the exact fingerprint createRemoteDispatchAttachment already refuses, not a new rule.
export function isUnauthenticatedLaneCallerFingerprint(fingerprint: string | undefined): boolean {
  return !fingerprint || fingerprint === UNAUTHENTICATED_LANE_CALLER_FINGERPRINT
}

// v33 (S10-1): agent directory + durable peer mailbox deliveries + provenance audit/rate limiting.
// Reused verbatim by both createTables() (fresh installs) and migrate()'s `current < 33` block
// (existing installs) so the two can never drift — every statement is IF NOT EXISTS/idempotent.
const AGENT_DIRECTORY_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS agents (
        id                        TEXT PRIMARY KEY,
        display_name              TEXT NOT NULL,
        role                      TEXT,
        host_id                   TEXT NOT NULL DEFAULT 'local',
        pane_key                  TEXT,
        terminal_handle           TEXT,
        process_incarnation       TEXT,
        worktree_id               TEXT,
        worktree_path             TEXT,
        branch                    TEXT,
        title                     TEXT,
        agent_label               TEXT,
        state                     TEXT NOT NULL DEFAULT 'idle'
          CHECK(state IN ('live', 'idle', 'gone')),
        derived                   INTEGER NOT NULL DEFAULT 0,
        quarantined               INTEGER NOT NULL DEFAULT 0,
        quarantine_reason_code    TEXT,
        quarantined_at            TEXT,
        tombstoned_at             TEXT,
        origin_kind               TEXT NOT NULL
          CHECK(origin_kind IN ('pane', 'paired_runtime', 'derived')),
        origin_pane_key           TEXT,
        origin_handle             TEXT,
        origin_host_id            TEXT NOT NULL,
        origin_paired_device_id   TEXT,
        origin_at                 TEXT NOT NULL DEFAULT (datetime('now')),
        registered_at             TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name
        ON agents(host_id, display_name) WHERE tombstoned_at IS NULL;
      -- suffix match, not equality: tabId changes when a pane moves tabs (same precedent as
      -- idx_dispatch_assignee_pane_leaf / idx_runs_coordinator_pane_leaf above).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pane_suffix
        ON agents(host_id, substr(pane_key, instr(pane_key, ':') + 1))
        WHERE pane_key IS NOT NULL AND tombstoned_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_agents_state
        ON agents(state, quarantined) WHERE tombstoned_at IS NULL;

      CREATE TRIGGER IF NOT EXISTS trg_agents_origin_immutable
      BEFORE UPDATE ON agents
      WHEN OLD.id <> NEW.id
        OR OLD.origin_kind <> NEW.origin_kind
        OR IFNULL(OLD.origin_pane_key, '') <> IFNULL(NEW.origin_pane_key, '')
        OR OLD.origin_host_id <> NEW.origin_host_id
        OR OLD.origin_at <> NEW.origin_at
        OR OLD.registered_at <> NEW.registered_at
      BEGIN
        SELECT RAISE(ABORT, 'agent provenance is immutable');
      END;

      CREATE TABLE IF NOT EXISTS mailbox_deliveries (
        id                TEXT PRIMARY KEY,
        mailbox_handle    TEXT NOT NULL,
        message_ids       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'outstanding'
          CHECK(status IN ('outstanding', 'acknowledged')),
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at   TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_deliveries_one_outstanding
        ON mailbox_deliveries(mailbox_handle) WHERE status = 'outstanding';

      CREATE TABLE IF NOT EXISTS agent_audit (
        seq               INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id          TEXT,
        actor_pane_key    TEXT,
        actor_host_id     TEXT,
        verb              TEXT NOT NULL,
        outcome           TEXT NOT NULL,
        reason_code       TEXT,
        at                TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TRIGGER IF NOT EXISTS trg_agent_audit_no_update
      BEFORE UPDATE ON agent_audit
      BEGIN
        SELECT RAISE(ABORT, 'agent_audit is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_agent_audit_no_delete
      BEFORE DELETE ON agent_audit
      BEGIN
        SELECT RAISE(ABORT, 'agent_audit is append-only');
      END;

      CREATE TABLE IF NOT EXISTS agent_rate (
        subject_key   TEXT NOT NULL,
        verb          TEXT NOT NULL,
        window_start  TEXT NOT NULL,
        count         INTEGER NOT NULL,
        PRIMARY KEY(subject_key, verb, window_start)
      );
`

// v34 (S10-2): durable threads, thread participants, and the gate refusal audit trail — tables
// and triggers only, no data. Reused by both createTables() (every open, idempotent via IF NOT
// EXISTS, same discipline as AGENT_DIRECTORY_SCHEMA_SQL above) and migrate()'s `current < 34`
// block. The messages/question_threads column additions are baked into their own CREATE TABLE
// definitions (fresh installs) and ALTERed under `current < 34` (existing installs), matching
// how v33's sender_agent_id landed. The backfill (THREAD_DIRECTORY_BACKFILL_SQL below) is
// deliberately NOT part of this constant: it reads `question_threads`, which createTables()'s
// own exec runs before that table exists (question_threads is minted only inside migrate()'s
// `current < 8` block) — running it here would throw "no such table" on every fresh install.
const THREAD_DIRECTORY_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        created_by_agent_id TEXT,
        origin TEXT NOT NULL DEFAULT 'peer' CHECK(origin IN ('peer','question','fanout','legacy')),
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','paused','closed')),
        sensitive INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_at TEXT,
        last_message_id TEXT,
        last_message_sequence INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        pact_with_agent_id TEXT,
        pact_state TEXT CHECK(pact_state IS NULL OR pact_state IN ('proposed','engaged','released')),
        pact_turn_agent_id TEXT,
        pact_at TEXT,
        -- v35 (S10-3 pact spec, additive only — ruling 1: pact_state's CHECK is frozen at 3
        -- values forever, so paused is a flag (pact_paused_at), never a 4th state).
        pact_proposer_agent_id TEXT,
        pact_steps_total INTEGER,                 -- NULL = --open
        pact_ordinal INTEGER NOT NULL DEFAULT 0,   -- last committed step; reset to 0 on re-propose
        -- pact_era (blocker fix, S10-3b review): bumped on every propose. pact_steps.ordinal
        -- resets to 0 on re-propose but the ledger is append-only (ruling 2), so a released
        -- pact's era-1 step rows are never removed; idx_pact_step_ordinal below is keyed on
        -- (thread_id, pact_era, ordinal), never (thread_id, ordinal) alone, or a re-propose's
        -- ordinal 1 collides with the still-present era-1 ordinal 1 row.
        pact_era INTEGER NOT NULL DEFAULT 0,
        pact_paused_at TEXT,
        pact_pause_reason TEXT                     -- enum code ONLY, never free text (CONTAINMENT)
          CHECK(pact_pause_reason IS NULL OR pact_pause_reason IN
                ('counterpart_gone','counterpart_left','counterpart_quarantined',
                 'thread_paused','thread_closed','operator')),
        purged_at TEXT,
        purge_reason TEXT,
        purged_by_agent_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_threads_recent ON threads(state, last_message_at) WHERE purged_at IS NULL;

      -- pact_steps: v35 append-only ledger (ruling 2 — its own table, not a view over messages,
      -- so a step survives purge). No dependency on threads' new columns, so safe to create
      -- unconditionally here (unlike idx_pact_pair_live/trg_pact_turn_membership below, which DO
      -- reference threads.pact_proposer_agent_id and must wait for that column to exist on an
      -- upgrading DB — see createPactSchemaIndexesIfPossible).
      CREATE TABLE IF NOT EXISTS pact_steps (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,                  -- 0 for non-step kinds; 1..n for step
        -- pact_era (blocker fix): the thread's pact_era at write time — every row this era was
        -- written under, stamped by insertPactStepRow from threads.pact_era. Not part of any
        -- CHECK; only idx_pact_step_ordinal below reads it.
        pact_era INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL CHECK(kind IN ('propose','accept','decline','step',
                                          'pause','resume_request','resume','release')),
        -- no who-paused column: the pausing side is the latest 'pause' row's actor_agent_id
        -- (NULL = host/operator), and a resume is pending when a 'resume_request' follows it
        -- with no 'resume' after it.
        actor_agent_id TEXT,                       -- the attested caller; never params.from
        actor_pane_key TEXT, actor_host_id TEXT,    -- NULL only on host/operator rows
        message_id TEXT,                            -- the step-complete message; NULL otherwise
        summary TEXT,                                -- sanitized, <=120, single line; NULL once purged
        summary_sha256 TEXT NOT NULL,                -- of the sanitized text; survives purge
        summary_purged_at TEXT,
        turn_after_agent_id TEXT,                    -- whose turn this row produced
        reason_code TEXT,                            -- pause/release/decline only; enum, no free text
        at TEXT NOT NULL DEFAULT (datetime('now')),
        -- table-level CHECK must trail every column def (SQLite grammar) — see F6.
        CHECK(actor_agent_id IS NOT NULL OR kind IN ('pause','resume'))
      );
      -- (thread_id, pact_era, ordinal), not (thread_id, ordinal) alone (blocker fix): a
      -- re-propose after release starts a new era at ordinal 1 while the released era's own
      -- ordinal-1 step row is still in this append-only table (ruling 2) — without the era
      -- column the two collide and every step after a re-propose throws a raw UNIQUE violation.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pact_step_ordinal
        ON pact_steps(thread_id, pact_era, ordinal) WHERE kind = 'step';
      CREATE INDEX IF NOT EXISTS idx_pact_steps_thread ON pact_steps(thread_id, seq);

      CREATE TRIGGER IF NOT EXISTS trg_pact_steps_no_delete
      BEFORE DELETE ON pact_steps
      BEGIN
        SELECT RAISE(ABORT, 'pact ledger is append-only');
      END;

      -- The one permitted transition is a purge: summary NULL<-value with summary_purged_at
      -- value<-NULL, every other column unchanged. Written as an explicit inequality list, like
      -- trg_messages_purge_final above — any other UPDATE (including one that touches nothing
      -- ledger-relevant) aborts, because this table is never touched except by that one purge.
      CREATE TRIGGER IF NOT EXISTS trg_pact_steps_append_only
      BEFORE UPDATE ON pact_steps
      WHEN NEW.seq <> OLD.seq
        OR NEW.thread_id <> OLD.thread_id
        OR NEW.ordinal <> OLD.ordinal
        OR NEW.kind <> OLD.kind
        OR IFNULL(NEW.actor_agent_id, '') <> IFNULL(OLD.actor_agent_id, '')
        OR IFNULL(NEW.actor_pane_key, '') <> IFNULL(OLD.actor_pane_key, '')
        OR IFNULL(NEW.actor_host_id, '') <> IFNULL(OLD.actor_host_id, '')
        OR IFNULL(NEW.message_id, '') <> IFNULL(OLD.message_id, '')
        OR NEW.summary_sha256 <> OLD.summary_sha256
        OR IFNULL(NEW.turn_after_agent_id, '') <> IFNULL(OLD.turn_after_agent_id, '')
        OR IFNULL(NEW.reason_code, '') <> IFNULL(OLD.reason_code, '')
        OR NEW.at <> OLD.at
        OR NOT (NEW.summary IS NULL AND OLD.summary IS NOT NULL
                AND OLD.summary_purged_at IS NULL AND NEW.summary_purged_at IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'pact ledger is append-only');
      END;

      CREATE TABLE IF NOT EXISTS thread_participants (
        thread_id TEXT NOT NULL,
        participant_key TEXT NOT NULL,
        agent_id TEXT,
        handle TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
        joined_at TEXT NOT NULL DEFAULT (datetime('now')),
        left_at TEXT,
        invited_by_agent_id TEXT,
        invite_state TEXT CHECK(invite_state IS NULL OR invite_state IN ('pending','accepted','declined')),
        last_read_sequence INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(thread_id, participant_key)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_participants_agent
        ON thread_participants(participant_key) WHERE left_at IS NULL;

      CREATE TABLE IF NOT EXISTS gate_refusals (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_agent_id TEXT,
        actor_pane_key TEXT,
        actor_host_id TEXT,
        verb TEXT NOT NULL,
        rule_ids TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        body_sha256 TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        subject_sha256 TEXT NOT NULL,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_threads_provenance_immutable
      BEFORE UPDATE ON threads
      WHEN OLD.id <> NEW.id
        OR OLD.created_at <> NEW.created_at
        OR IFNULL(OLD.created_by_agent_id, '') <> IFNULL(NEW.created_by_agent_id, '')
        OR OLD.origin <> NEW.origin
        OR (OLD.sensitive = 1 AND NEW.sensitive = 0)
      BEGIN
        SELECT RAISE(ABORT, 'thread provenance is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_gate_refusals_no_update
      BEFORE UPDATE ON gate_refusals
      BEGIN
        SELECT RAISE(ABORT, 'gate_refusals is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_gate_refusals_no_delete
      BEFORE DELETE ON gate_refusals
      BEGIN
        SELECT RAISE(ABORT, 'gate_refusals is append-only');
      END;

      -- Pulled forward from the S10-4 ruling (agent-coordination-s10-4-federation-spec.md:18,
      -- :91-94): 'paired_runtime' stays in the CHECK for wire compat (a rebuild is forbidden,
      -- S10-1 test M3) but is refused at insert/update time — no code path mints one yet, and
      -- closing the door now is cheaper than an S10-1 RISKS correction later.
      CREATE TRIGGER IF NOT EXISTS trg_agents_no_foreign_origin
      BEFORE INSERT ON agents
      WHEN NEW.origin_kind NOT IN ('pane', 'derived')
      BEGIN
        SELECT RAISE(ABORT, 'foreign agents live in remote_agents');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_agents_no_foreign_origin_update
      BEFORE UPDATE ON agents
      WHEN NEW.origin_kind NOT IN ('pane', 'derived')
      BEGIN
        SELECT RAISE(ABORT, 'foreign agents live in remote_agents');
      END;
`

// Separate from THREAD_DIRECTORY_SCHEMA_SQL (not folded into it): its WHEN clause references
// messages.purged_at, so creating it unconditionally in createTables() would succeed (SQLite
// does not validate a trigger's column references until it fires) but then abort the very next
// UPDATE an EARLIER migrate() version block runs against a pre-v34 `messages` table that does
// not have the column yet — "no such column: OLD.purged_at". Guarded by the same
// hasColumn('messages', 'purged_at') check as the indexes below.
const MESSAGES_PURGE_TRIGGER_SQL = `
      CREATE TRIGGER IF NOT EXISTS trg_messages_purge_final
      BEFORE UPDATE ON messages
      WHEN OLD.purged_at IS NOT NULL
        AND (NEW.purged_at IS NULL OR NEW.body <> '' OR NEW.subject <> '[purged]' OR IFNULL(NEW.payload, '') <> '')
      BEGIN
        SELECT RAISE(ABORT, 'purge is final');
      END;
`

// Separate from THREAD_DIRECTORY_SCHEMA_SQL for the same reason as MESSAGES_PURGE_TRIGGER_SQL
// above: both reference threads.pact_proposer_agent_id/pact_with_agent_id, which an existing
// pre-v35 DB's `threads` table lacks until migrate()'s `current < 35` ALTERs run, and
// createTables() execs THREAD_DIRECTORY_SCHEMA_SQL unconditionally BEFORE migrate() on every
// open — an unconditional CREATE INDEX here would throw "no such column" against that DB.
// Guarded by hasColumn('threads', 'pact_proposer_agent_id') in
// createPactSchemaIndexesIfPossible below, same discipline as createThreadDirectoryIndexesIfPossible.
const PACT_PAIR_LIVE_SQL = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pact_pair_live ON threads(
        MIN(pact_proposer_agent_id, pact_with_agent_id), MAX(pact_proposer_agent_id, pact_with_agent_id))
        WHERE pact_state IN ('proposed','engaged');

      -- Load-bearing half of P4' (deadlock proof): in the database, so no handler edit can
      -- weaken it. An engaged pact's turn must always be held by one of its two participants.
      CREATE TRIGGER IF NOT EXISTS trg_pact_turn_membership
      BEFORE UPDATE ON threads
      WHEN NEW.pact_state = 'engaged' AND (
        NEW.pact_turn_agent_id IS NULL
        OR NEW.pact_turn_agent_id NOT IN (IFNULL(NEW.pact_proposer_agent_id, ''), IFNULL(NEW.pact_with_agent_id, ''))
      )
      BEGIN
        SELECT RAISE(ABORT, 'an engaged pact needs a turn held by a participant');
      END;
`

// v36 (S10-4 rulings 1/2): remote_agents (mirrored peer-agent claims, NEVER a row in `agents` —
// the local table's origin_kind CHECK/triggers above already refuse a foreign origin_kind) and
// relay_seen (durable per-item federation import outcome, keyed the same way this tree's
// federated-dispatch relay already keys sequence: dispatchId+sequence, not a new link_id — no
// agent_links table exists in this tree and S10-4's scope here does not add one). No column
// dependency on anything created later, so — unlike PACT_PAIR_LIVE_SQL above — this runs
// unconditionally in createTables() same as AGENT_DIRECTORY_SCHEMA_SQL/THREAD_DIRECTORY_SCHEMA_SQL.
//
// relink-generation fix (post-ruling-1 review): dispatchId+sequence alone is NOT unique across
// a relink epoch — relinkFederatedEnvironment (ruling 5) zeroes federated_dispatches's
// to_home_imported_sequence, so the peer replays sequence 1 in the new epoch and would silently
// collide (INSERT OR IGNORE) with whatever sequence 1 recorded before the relink, refusals
// included. relay_seen's key grows a `generation` column, matching federated_dispatches's new
// relink_generation counter above — see recordRelaySeen/importFederatedRelayItem.
// S10-16 (rulings 8/10/11/14/17): the PROVEN correspondence between an inbound paired link and one
// saved outbound environment. A row exists only after a completed possession + channel-membership
// + peer-key proof (link-binding-proof.ts) performed BY THIS HOST. Nothing here is ever written
// from a peer-asserted body field, and nothing here is written by the confirm handler (R7.5) —
// one writer per row, always this host's own verifier. `state='contested'` has exactly ONE writer,
// R11.3, and no wire code from any peer can reach it (INV-P-012). Keyed by a device id only THIS
// host mints, so the table is not peer-growable. Timestamps are epoch ms (R14.1), deliberately
// unlike the older tables' datetime('now') — the sweeper orders on them.
//
// C2 amendment (i), Ruling 23(a): `peer_link_attempts.last_advisory_notified_at` is NOT created —
// the design v6 DDL's column is dropped; see the chair briefing §0 decision 3 and Ruling 23(a).
// C2 amendment (ii), Ruling 23(d): `peer_link_scan_facts.outcome`'s CHECK is UNCHANGED (seven
// members, no `duplicate_environment`) — the credential collapse writes no scan fact (§3 P-3).
const S10_16_LINK_BINDING_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS peer_link_bindings (
        link_device_id         TEXT PRIMARY KEY,
        environment_id         TEXT NOT NULL,
        bound_endpoint_id      TEXT NOT NULL,
        bound_pairing_revision INTEGER NOT NULL,
        link_credential_fp     TEXT NOT NULL,
        peer_credential_fp     TEXT NOT NULL,
        peer_key_fingerprint   TEXT NOT NULL,
        grant_class            TEXT NOT NULL DEFAULT 'legacy_coalesced'
                                 CHECK(grant_class IN ('minted', 'legacy_coalesced')),
        scan_completeness      TEXT NOT NULL DEFAULT 'partial'
                                 CHECK(scan_completeness IN ('complete', 'partial')),
        proof_protocol         TEXT NOT NULL,
        state                  TEXT NOT NULL DEFAULT 'confirmed'
                                 CHECK(state IN ('confirmed', 'contested', 'revoked')),
        detail                 TEXT,
        contest_incident_id    TEXT,
        proved_at              INTEGER NOT NULL,
        last_verified_at       INTEGER NOT NULL,
        contested_at           INTEGER,
        revoked_at             INTEGER
      );
      -- DELIBERATELY NOT UNIQUE on environment_id — a re-pair leaves the OLD link row live
      -- (device-registry.ts's rotatePendingDevice keeps every row with lastSeenAt !== 0), so many
      -- links may legitimately name one environment; the LINK side is 1:1 (the PRIMARY KEY above),
      -- and inbound ambiguity is handled by R11's contest, not by a constraint.
      CREATE INDEX IF NOT EXISTS idx_peer_link_bindings_env ON peer_link_bindings(environment_id);

      -- Durable schedule/backoff/health per link. Peer-ungrowable for the same reason.
      -- last_outcome has exactly ONE writer — this host's own prover round settle (R14.2) — so
      -- peer-triggered signals live in last_advisory instead, never overwriting the operator's
      -- own last classification.
      CREATE TABLE IF NOT EXISTS peer_link_attempts (
        link_device_id        TEXT PRIMARY KEY,
        last_attempt_at       INTEGER,
        last_round_at         INTEGER,
        last_full_round_at    INTEGER,
        last_outcome          TEXT NOT NULL DEFAULT 'pending'
          CHECK(last_outcome IN ('pending','proven','unpaired','unpaired_parked','peer_duplicate',
                                 'duplicate_environment','multi_grant','contested','unreachable',
                                 'unsupported','unavailable','protocol_violation','quarantined',
                                 'revoked','excluded')),
        last_detail           TEXT,
        last_advisory              TEXT,
        last_advisory_at           INTEGER,
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        consecutive_no_winner INTEGER NOT NULL DEFAULT 0,
        misroute_advisories   INTEGER NOT NULL DEFAULT 0,
        next_attempt_after    INTEGER
      );

      -- R12: the per-(link, environment) fact, with the two pins AND the TTL that bound it. SINGLE
      -- WRITER: this host's own verifier round. 'peer_confirmed' is NOT an outcome here.
      CREATE TABLE IF NOT EXISTS peer_link_scan_facts (
        link_device_id               TEXT NOT NULL,
        environment_id               TEXT NOT NULL,
        outcome                      TEXT NOT NULL
          CHECK(outcome IN ('no_match','proven','peer_duplicate','protocol_violation',
                            'unsupported','unavailable','unreachable')),
        environment_pairing_revision INTEGER NOT NULL,
        link_credential_fp           TEXT NOT NULL,
        detail                       TEXT,
        observed_at                  INTEGER NOT NULL,
        PRIMARY KEY (link_device_id, environment_id)
      );

      -- Ruling 17(g): confirm-triggered observations, ADVISORY ONLY. Separate table so a
      -- peer-triggered write can never overwrite the verifier's definitive facts. The ONLY table
      -- in this slice a peer's call causes a row in — bounded per link, included in link-forget.
      CREATE TABLE IF NOT EXISTS peer_link_confirm_observations (
        link_device_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK(kind IN ('peer_confirmed','local_duplicate')),
        detail         TEXT,
        observed_at    INTEGER NOT NULL,
        PRIMARY KEY (link_device_id, environment_id, kind)
      );

      -- Ruling 10 + Ruling 14(c) + R12.3: durable LOCAL OPERATOR INTENT about a subject. One table
      -- for three actions because all three are the same thing — a local, audited, liftable
      -- decision that must survive resetAll and that no peer may ever write.
      CREATE TABLE IF NOT EXISTS peer_link_containment (
        subject_kind TEXT NOT NULL CHECK(subject_kind IN ('link','environment')),
        subject_id   TEXT NOT NULL,
        action       TEXT NOT NULL CHECK(action IN ('quarantine','scan_exclude','accept_legacy')),
        reason_code  TEXT,
        reason_text  TEXT,
        detail       TEXT,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER,
        lifted_at    INTEGER,
        PRIMARY KEY (subject_kind, subject_id, action)
      );

      -- Ruling 14(e): the DURABLE reply relay. A reply to a foreign-origin message is committed
      -- here in the same transaction as the audit row and markAsRead. Ordering is per ROUTE —
      -- (link_device_id, environment_id, bound_pairing_revision) — not per link alone.
      CREATE TABLE IF NOT EXISTS peer_reply_outbox (
        id                       TEXT PRIMARY KEY,
        seq                      INTEGER NOT NULL,
        local_message_id         TEXT NOT NULL UNIQUE,
        link_device_id           TEXT NOT NULL,
        environment_id           TEXT NOT NULL,
        bound_pairing_revision   INTEGER NOT NULL,
        peer_credential_fp       TEXT NOT NULL,
        peer_key_fingerprint     TEXT NOT NULL,
        in_reply_to_message_id   TEXT NOT NULL,
        peer_agent_id            TEXT NOT NULL,
        peer_thread_id           TEXT,
        local_thread_id          TEXT,
        notice_run_id            TEXT,
        notice_pane_key          TEXT,
        payload                  TEXT NOT NULL,
        byte_count               INTEGER NOT NULL,
        state                    TEXT NOT NULL DEFAULT 'queued'
          CHECK(state IN ('queued','sending','delivered','refused','abandoned','cancelled')),
        lease_expires_at         INTEGER,
        attempts                 INTEGER NOT NULL DEFAULT 0,
        consecutive_failures     INTEGER NOT NULL DEFAULT 0,
        hold_count               INTEGER NOT NULL DEFAULT 0,
        first_held_at            INTEGER,
        last_attempt_at          INTEGER,
        next_attempt_after       INTEGER,
        last_error_code          TEXT,
        last_error               TEXT,
        peer_message_id          TEXT,
        peer_reply_thread_id     TEXT,
        created_at               INTEGER NOT NULL,
        settled_at               INTEGER,
        notified_at              INTEGER,
        -- Ruling 26 Addendum 3(aa): the disposition-notice edge keys on the last NOTIFIED
        -- condition, not on last_error_code (which holds also write). Written ONLY by the notice
        -- choke (fireReplyRelayNotice); holds never touch it.
        last_notified_condition  TEXT,
        -- Ruling 26 Addendum 4(ii): stamped in the SAME write as last_notified_condition — the
        -- persisted half of the disposition family's per-link R19.3 interval (MAX(last_notified_at)
        -- WHERE link_device_id = ?), replacing the in-memory Map C5d shared with the R20.2
        -- advisory. Guarded to queued/sending rows (jj) — a settled row is never mutated.
        last_notified_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_peer_reply_outbox_pending
        ON peer_reply_outbox(link_device_id, environment_id, bound_pairing_revision, state,
                             next_attempt_after, seq);
`

const S10_4_FEDERATION_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS remote_agents (
        environment_id          TEXT NOT NULL,   -- local link key (D5: paired_device = pairedDeviceId, environment = KnownRuntimeEnvironment.id)
        environment_name        TEXT NOT NULL,   -- provenance only, for printing; never an address
        -- S10-15 D5: which key space environment_id lives in. Only 'environment' rows are ever
        -- addressable (db.listAddressableRemoteAgents) — 'paired_device' rows are inbound-only
        -- provenance/containment, never a send target.
        link_kind                TEXT NOT NULL DEFAULT 'paired_device'
          CHECK(link_kind IN ('paired_device', 'environment')),
        remote_agent_id         TEXT NOT NULL,   -- the peer's own agents.id
        display_name            TEXT NOT NULL,
        role                    TEXT,
        state                   TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('live', 'idle', 'gone')),
        derived                 INTEGER NOT NULL DEFAULT 0,
        remote_quarantined      INTEGER NOT NULL DEFAULT 0,  -- asserted by the origin host
        local_quarantined       INTEGER NOT NULL DEFAULT 0,  -- this host's own defensive act
        quarantine_reason_code  TEXT,
        -- S10-15 ruling 2: the link's own authenticated fingerprint, bound to environment_id on
        -- first contact (TOFU) — never a peer-body-asserted value.
        peer_fingerprint        TEXT,
        last_seen_at            TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(environment_id, remote_agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_remote_agents_name ON remote_agents(display_name);
      -- D5 Rule 3's local-quarantine union query needs this.
      CREATE INDEX IF NOT EXISTS idx_remote_agents_peer ON remote_agents(remote_agent_id);

      -- A remote-asserted lift must never clear a local defensive quarantine (mirrors the
      -- correction s10-4-federation-spec.md notes the trust draft's version missed): a
      -- legitimate LOCAL lift (remote_quarantined unchanged) still passes.
      CREATE TRIGGER IF NOT EXISTS trg_remote_lift_scope
      BEFORE UPDATE ON remote_agents
      WHEN OLD.local_quarantined = 1 AND NEW.local_quarantined = 0
        AND NEW.remote_quarantined <> OLD.remote_quarantined
      BEGIN
        SELECT RAISE(ABORT, 'a remote lift cannot clear a local quarantine');
      END;

      CREATE TABLE IF NOT EXISTS relay_seen (
        dispatch_id   TEXT NOT NULL,
        sequence      INTEGER NOT NULL,
        -- federated_dispatches.relink_generation at the time this row was recorded (0 for a
        -- link that has never been relinked). Part of the PK: see relink-generation fix note
        -- above this table's schema block.
        generation    INTEGER NOT NULL DEFAULT 0,
        message_id    TEXT NOT NULL,
        outcome       TEXT NOT NULL CHECK(outcome IN ('imported', 'refused', 'duplicate')),
        rule_ids      TEXT,   -- JSON array of gate rule ids; only set when outcome = 'refused'
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(dispatch_id, sequence, generation)
      );
      CREATE TRIGGER IF NOT EXISTS trg_relay_seen_no_update
      BEFORE UPDATE ON relay_seen
      BEGIN
        SELECT RAISE(ABORT, 'relay_seen is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_relay_seen_no_delete
      BEFORE DELETE ON relay_seen
      BEGIN
        SELECT RAISE(ABORT, 'relay_seen is append-only');
      END;
`

// Runs only inside migrate()'s `current < 34` block, after `question_threads` is guaranteed to
// exist (created at `current < 8`, earlier in the same migration transaction for a fresh
// install). Idempotent (INSERT OR IGNORE) and a no-op against an empty `messages` table.
// Legacy subjects are the fixed literal, never derived from `messages.subject` (s10-2-spec.md:97
// — those rows predate the write-side sanitizer, so promoting them would import unsanitized
// author text into a new render surface).
const THREAD_DIRECTORY_BACKFILL_SQL = `
      INSERT OR IGNORE INTO threads (id, subject, origin, state, created_at, last_message_at,
          last_message_sequence, message_count)
        SELECT m.thread_id, '(legacy thread)',
          CASE WHEN EXISTS(SELECT 1 FROM question_threads q WHERE q.message_id = m.thread_id) THEN 'question'
               WHEN COUNT(DISTINCT m.to_handle) > 2 THEN 'fanout' ELSE 'legacy' END,
          CASE WHEN COUNT(DISTINCT m.to_handle) > 2 THEN 'closed' ELSE 'open' END,
          MIN(m.created_at), MAX(m.created_at), MAX(m.sequence), COUNT(*)
        FROM messages m WHERE m.thread_id IS NOT NULL GROUP BY m.thread_id;
      INSERT OR IGNORE INTO thread_participants (thread_id, participant_key, handle)
        SELECT thread_id, from_handle, from_handle FROM messages WHERE thread_id IS NOT NULL
        UNION SELECT thread_id, to_handle, to_handle FROM messages WHERE thread_id IS NOT NULL;
`

export const LEGACY_CONTRACT_VERSION = 0
export const CURRENT_CONTRACT_VERSION = ORCHESTRATION_CONTRACT_VERSION

export type RunListPage = {
  runs: RunRow[]
  nextCursor: string | null
}

export type TaskRuntimeLineageRow = TaskRow & {
  creator_dispatch_id: string | null
  creator_dispatch_run_id: string | null
  creator_dispatch_pane_key: string | null
  creator_dispatch_process_incarnation: string | null
}

type RunListCursor = {
  createdAt: string
  id: string
}

// Schema versions: v2 'heartbeat'+last_heartbeat_at, v3 delivered_at, v4 task-creator terminal, v5 task_title/display_name, v6 pane identity, v7 lightweight Runs, v8 crash-safe Run deliveries, v9 durable question threads, v10 Dispatch capabilities, v11 durable mutation receipts, v12 composed worker state, v18 post-v6 version-skew repair, v19 adopted legacy Runs and compatibility receipts, v20 legacy question backfill, v21 legacy scheduler-loss provenance, v22 dispatch assignee lookup, v23 worker terminal resource ownership, v24 creator-incarnation authority, v25 active Dispatch handle lookup, v26 indexed mutation receipt capacity, v27 durable federation acknowledgments, v28 blocked-worker liveness exemption, v29 dispatch liveness breach fence, v30 dispatch input evidence and post-ready observation fence, v31 persisted federation relay health, v32 recipient pane key on messages (bare-handle re-mint fallback), v33 agent directory + mailbox deliveries + audit/rate tables + message sender provenance (S10-1), v34 durable threads + thread_participants + gate_refusals + message purge/gate columns + message payload_kind pact-step discriminator column + question_threads peer-ask columns + agents.origin_kind tightening (S10-2a), v35 lock-step pact columns on threads (pact_proposer_agent_id/pact_steps_total/pact_ordinal/pact_paused_at/pact_pause_reason) + pact_steps append-only ledger + idx_pact_pair_live + trg_pact_turn_membership (S10-3), v36 remote_agents (mirrored peer-agent claims, never a row in `agents`) + relay_seen (durable per-item federation import outcome, incl. outcome='refused') (S10-4 rulings 1/2), v37 remote_agents.link_kind (D5 addressability keying) + remote_agents.peer_fingerprint (ruling 2 TOFU binding) + idx_remote_agents_peer (S10-15), v38 messages.peer_link_device_id/peer_agent_id/peer_thread_id/peer_relayed_at (cross-host send/reply provenance, chair ruling 7 — no messages.peer_fingerprint: R9's automatic route resolution was cut) + F7a stranded-name-addressed-row repair (S10-15 F1/F2), v39 remote_dispatch_attachments.blocked_reason/blocked_at/blocked_consumed_at/handle_bound_at/agent_exited_at + idx_rda_terminal_handle + 'agent_exited' state (CHECK rebuild) + peer_run_grants table (S10-19 peer access profile, chair rulings 20/22/24), v40 peer_link_bindings + peer_link_attempts + peer_link_scan_facts + peer_link_confirm_observations + peer_link_containment + peer_reply_outbox tables (S10-16 secure link binding, chair rulings 8/10/11/14/17/18g/23).
const SCHEMA_VERSION = 40

// S10-15 ruling 3(b): the per-link cap on DISTINCT mirrored peer agents — past this, a further
// NEW remote agent id refuses the mirror write (never the mail/ask itself) with a typed
// disposition + audit. No eviction-by-recency: a flood of distinct bogus ids must never evict
// the legitimate row.
export const REMOTE_AGENTS_PER_LINK_CAP = 64

// S10-19 (Ruling 24(e) / attacker 5 / ops BL-3): the ONE settled-state list for
// remote_dispatch_attachments.state. beginRemoteAttachmentStop (below) and
// orchestration-federation-control.ts's federationStop handler must agree on exactly this set —
// 'agent_exited' included, so federationStop on an already-exited row returns alreadySettled
// instead of throwing dispatch_inactive.
export const PEER_ATTACHMENT_SETTLED_STATES = [
  'succeeded',
  'failed',
  'stopped',
  'abandoned',
  'agent_exited'
] as const

function hardenOrchestrationDatabaseFiles(dbPath: (string & {}) | ':memory:'): void {
  if (dbPath === ':memory:' || process.platform === 'win32') {
    // Why: Windows protects these files through Orca's current-user-only userData DACL; POSIX mode bits are inert there.
    return
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) {
      chmodSync(path, 0o600)
    }
  }
}

export class OrchestrationDb {
  private db: Database.Database

  // Why: the orchestration DB is created lazily for ALL users, but only the
  // small minority who dispatch work ever have dispatch_contexts rows. The
  // renderer graph publish rebuilds orchestration context on every 16ms tick
  // (buildAgentOrchestrationByPaneKey), issuing 2 queries per terminal. Cache
  // emptiness so the non-orchestration majority short-circuits the whole
  // per-terminal fan-out. Only createDispatchContext flips this false→true.
  private hasAnyDispatchContextsCache: boolean | undefined

  // GATE § h3 (s10-2-spec.md:150): loaded once here, not per-call — see infra-allowlist.ts.
  private readonly infraAllowlist: readonly string[]

  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.createTables()
    this.migrate()
    hardenOrchestrationDatabaseFiles(dbPath)
    this.infraAllowlist = loadInfraAllowlist(dbPath)
  }

  // Unshipped-v35 pact_era repair (S10-3b verify blocker): a DB stamped v35 by an earlier copy
  // of this same UNSHIPPED migration (no artifact ever carried v35) has threads/pact_steps
  // WITHOUT pact_era — and createTables()'s own idx_pact_step_ordinal SQL references the column,
  // so the open crashes before migrate() could repair anything. Runs first, version-agnostic:
  // only a pre-fix-v35 DB can have either table existing without the column; everything else
  // no-ops on two cheap probes.
  private repairUnshippedV35PactEra(): void {
    const hasTable = (t: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !==
      undefined
    if (hasTable('threads') && !this.hasColumn('threads', 'pact_era')) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN pact_era INTEGER NOT NULL DEFAULT 0`)
    }
    if (hasTable('pact_steps') && !this.hasColumn('pact_steps', 'pact_era')) {
      this.db.exec(`ALTER TABLE pact_steps ADD COLUMN pact_era INTEGER NOT NULL DEFAULT 0`)
      // createTables()'s CREATE UNIQUE INDEX IF NOT EXISTS re-creates it era-keyed right after.
      this.db.exec(`DROP INDEX IF EXISTS idx_pact_step_ordinal`)
    }
  }

  // Unshipped-v36 relink-generation repair (S10-4 verify major, same shape as the v35 pact_era
  // one directly above): a DB stamped v36 by a pre-fix copy of this same UNSHIPPED migration
  // never re-enters migrate()'s `current < 36` block, so its relay_seen keeps the 2-column PK
  // and federated_dispatches lacks relink_generation — every federated relay import then dies.
  // Guarded on user_version >= 36 so a pre-v36 DB still takes migrate()'s atomic path.
  private repairUnshippedV36RelinkGeneration(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    if (storedVersion < 36) {
      return
    }
    if (!this.hasColumn('federated_dispatches', 'relink_generation')) {
      this.db.exec(
        'ALTER TABLE federated_dispatches ADD COLUMN relink_generation INTEGER NOT NULL DEFAULT 0'
      )
    }
    if (!this.hasColumn('relay_seen', 'generation')) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS trg_relay_seen_no_update;
        DROP TRIGGER IF EXISTS trg_relay_seen_no_delete;
        ALTER TABLE relay_seen RENAME TO relay_seen_pre_generation;
        CREATE TABLE relay_seen (
          dispatch_id   TEXT NOT NULL,
          sequence      INTEGER NOT NULL,
          generation    INTEGER NOT NULL DEFAULT 0,
          message_id    TEXT NOT NULL,
          outcome       TEXT NOT NULL CHECK(outcome IN ('imported', 'refused', 'duplicate')),
          rule_ids      TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY(dispatch_id, sequence, generation)
        );
        INSERT INTO relay_seen (dispatch_id, sequence, generation, message_id, outcome, rule_ids, created_at)
          SELECT dispatch_id, sequence, 0, message_id, outcome, rule_ids, created_at
          FROM relay_seen_pre_generation;
        DROP TABLE relay_seen_pre_generation;
        CREATE TRIGGER trg_relay_seen_no_update
        BEFORE UPDATE ON relay_seen
        BEGIN
          SELECT RAISE(ABORT, 'relay_seen is append-only');
        END;
        CREATE TRIGGER trg_relay_seen_no_delete
        BEFORE DELETE ON relay_seen
        BEGIN
          SELECT RAISE(ABORT, 'relay_seen is append-only');
        END;
      `)
    }
  }

  // Unshipped-v37 remote_agents identity repair (S10-15 breaker finding 22, same shape as the
  // v35/v36 repairs above): a DB stamped v37 by a pre-fix copy of this same UNSHIPPED migration
  // never re-enters migrate()'s `current < 37` block. Guarded on user_version >= 37 so a pre-v37
  // DB still takes migrate()'s atomic path — AND, per finding 22, on a `hasTable('remote_agents')`
  // probe first: unlike v36's repair (whose storedVersion >= 36 guard alone guarantees the table
  // exists), a refactor of this ordering is one step away from an ALTER on a missing table, so
  // this repair does not lean on that assumption.
  private repairUnshippedV37RemoteAgentIdentity(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    if (storedVersion < 37) {
      return
    }
    const hasTable = (t: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !==
      undefined
    if (!hasTable('remote_agents')) {
      return
    }
    if (!this.hasColumn('remote_agents', 'link_kind')) {
      // Ruling 31(c): same silent-backfill log as the migrate() v37 step above, for a store an
      // earlier unshipped copy of this migration stamped v37 without ever running that step.
      const remoteAgentCount = (
        this.db.prepare('SELECT COUNT(*) AS n FROM remote_agents').get() as { n: number }
      ).n
      this.db.exec(
        `ALTER TABLE remote_agents ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'paired_device'`
      )
      if (remoteAgentCount > 0) {
        console.warn('[orchestration] remote_agents link_kind back-filled', {
          count: remoteAgentCount
        })
      }
    }
    if (!this.hasColumn('remote_agents', 'peer_fingerprint')) {
      this.db.exec(`ALTER TABLE remote_agents ADD COLUMN peer_fingerprint TEXT`)
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_remote_agents_peer ON remote_agents(remote_agent_id);`
    )
  }

  // Unshipped-v38 repair (same shape as v35/v36/v37 above): a DB stamped v38 by a pre-fix copy of
  // this same UNSHIPPED migration never re-enters migrate()'s `current < 38` block. Guarded on
  // user_version >= 38, plus a hasTable probe (finding 22's discipline) before any ALTER.
  private repairUnshippedV38PeerRouting(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    if (storedVersion < 38) {
      return
    }
    const hasTable = (t: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !==
      undefined
    if (!hasTable('messages')) {
      return
    }
    for (const column of [
      'peer_link_device_id',
      'peer_agent_id',
      'peer_thread_id',
      'peer_relayed_at'
    ]) {
      if (!this.hasColumn('messages', column)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`)
      }
    }
    // S10-15 verifier F3: same unshipped-repair discipline for question_threads.expires_at —
    // hasTable probed separately since it is a different table than messages.
    if (hasTable('question_threads') && !this.hasColumn('question_threads', 'expires_at')) {
      this.db.exec(`ALTER TABLE question_threads ADD COLUMN expires_at TEXT`)
    }
    // S10-15 review m-3: an unshipped-v38 DB never re-enters migrate()'s `current < 38` block
    // either — the F7a data repair that block performs must also run here, or a DB stamped v38
    // by an earlier build of this branch keeps its stranded rows forever.
    this.repointStrandedDisplayNameAddressedMessages()
  }

  // Ruling 31(b) unshipped-v39 repair (same shape as v35/v36/v37/v38 above): a DB already stamped
  // v39/v40 by a pre-fix copy of this branch never re-enters migrate()'s `current < 39` block, so
  // it would never get the install-day retention floor and every pre-existing settled row would
  // be evaluated against the unmodified 7-day predicate on the very next prune tick. Guarded on
  // user_version >= 39 (INV-P-016: no v39/v40 artifact is installed anywhere, so this table may
  // still ride the v39 step) plus a hasTable probe, same discipline as every repair above. F7:
  // in practice this method's own INSERT OR IGNORE is also a guaranteed no-op — createTables()
  // calls this repair before it runs the unconditional CREATE TABLE IF NOT EXISTS +
  // INSERT OR IGNORE for this table (see that site's comment), which stamps first on every open.
  private repairUnshippedV39AttachmentRetentionFloor(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    if (storedVersion < 39) {
      return
    }
    const hasTable = (t: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !==
      undefined
    if (!hasTable('peer_attachment_retention_floor')) {
      this.db.exec(`
        CREATE TABLE peer_attachment_retention_floor (
          id       INTEGER PRIMARY KEY CHECK(id = 1),
          floor_at TEXT NOT NULL
        );
      `)
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO peer_attachment_retention_floor (id, floor_at) VALUES (1, datetime('now'))`
      )
      .run()
  }

  // R14.4: unshipped-v40 repair, called first in createTables() after repairUnshippedV38PeerRouting
  // (S10-19 needs none of its own — its v39 columns are simple nullable TEXT, added inline). Guard
  // on user_version >= 40 AND a hasTable probe — a pure new-table migration needs no repair against
  // a SHIPPED older build; this exists because v40 is unshipped, so an in-review shape change to a
  // table an earlier copy of this migration already created would otherwise never be applied.
  //
  // NEVER DROPPED (peer_link_bindings, peer_link_containment, peer_reply_outbox): missing columns
  // added nullable; a row whose NOT NULL invariant cannot be back-filled is marked fail-closed
  // (revoked / abandoned) with an audit row — never deleted. `revoked_at` is the load-bearing half
  // of the binding mark (R10-A's candidate filter and R15's routing predicate both key on the
  // COLUMN, not `state`) — if the `state` CHECK a pre-review build wrote rejects 'revoked', the
  // UPDATE is caught and `revoked_at` alone is stamped (no CHECK constrains it).
  //
  // DROP-AND-RECREATE (peer_link_attempts, peer_link_scan_facts, peer_link_confirm_observations):
  // genuinely re-derivable state — probe every expected column, DROP + re-create from the same
  // const if any is missing.
  private repairUnshippedV40LinkBinding(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    if (storedVersion < 40) {
      return
    }
    const hasTable = (t: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !==
      undefined
    const now = Date.now()

    if (hasTable('peer_link_bindings')) {
      const columns: [string, string][] = [
        ['environment_id', 'TEXT'],
        ['bound_endpoint_id', 'TEXT'],
        ['bound_pairing_revision', 'INTEGER'],
        ['link_credential_fp', 'TEXT'],
        ['peer_credential_fp', 'TEXT'],
        ['peer_key_fingerprint', 'TEXT'],
        ['grant_class', 'TEXT'],
        ['scan_completeness', 'TEXT'],
        ['proof_protocol', 'TEXT'],
        // Ruling 19 P3 / R14.4: NOT a `DEFAULT 'confirmed'` — a back-filled column must never
        // supply the routable value. Plain nullable TEXT, like every other column in this list;
        // the incomplete-row probe below fails closed on a NULL state exactly like any other
        // missing NOT NULL column.
        ['state', 'TEXT'],
        ['detail', 'TEXT'],
        ['contest_incident_id', 'TEXT'],
        ['proved_at', 'INTEGER'],
        ['last_verified_at', 'INTEGER'],
        ['contested_at', 'INTEGER'],
        ['revoked_at', 'INTEGER']
      ]
      let addedColumn = false
      for (const [column, type] of columns) {
        if (!this.hasColumn('peer_link_bindings', column)) {
          this.db.exec(`ALTER TABLE peer_link_bindings ADD COLUMN ${column} ${type}`)
          addedColumn = true
        }
      }
      if (addedColumn) {
        // F6/R14.4: every NOT NULL column of peer_link_bindings the fresh v40 DDL requires, not
        // just the eight that predate the ALTER loop above. `state` is checked against the valid
        // word set (not merely NULL) so an unrecognized back-filled value fails closed the same
        // as a missing one.
        const incomplete = this.db
          .prepare(
            `SELECT link_device_id FROM peer_link_bindings
              WHERE environment_id IS NULL OR bound_endpoint_id IS NULL
                 OR link_credential_fp IS NULL OR peer_credential_fp IS NULL
                 OR peer_key_fingerprint IS NULL OR proof_protocol IS NULL
                 OR proved_at IS NULL OR last_verified_at IS NULL
                 OR state IS NULL OR state NOT IN ('confirmed', 'contested', 'revoked')
                 OR bound_pairing_revision IS NULL OR grant_class IS NULL
                 OR scan_completeness IS NULL`
          )
          .all() as { link_device_id: string }[]
        for (const row of incomplete) {
          try {
            this.db
              .prepare(
                `UPDATE peer_link_bindings SET state = 'revoked', revoked_at = ? WHERE link_device_id = ?`
              )
              .run(now, row.link_device_id)
          } catch {
            // A pre-review build's `state` CHECK may reject 'revoked' — fail closed on the column
            // R10-A/R15 actually read, which no CHECK constrains.
            this.db
              .prepare(`UPDATE peer_link_bindings SET revoked_at = ? WHERE link_device_id = ?`)
              .run(now, row.link_device_id)
          }
          this.writeAgentAudit({
            agentId: null,
            actorPaneKey: null,
            // F8: name the link the repair acted on — 'local' left every row indistinguishable.
            actorHostId: row.link_device_id,
            verb: 'link_binding_unshipped_v40_repair',
            outcome: 'revoked',
            reasonCode: 'incomplete_row_fail_closed'
          })
        }
      }
    }

    if (hasTable('peer_link_containment')) {
      const columns: [string, string][] = [
        ['reason_code', 'TEXT'],
        ['reason_text', 'TEXT'],
        ['detail', 'TEXT'],
        ['created_at', 'INTEGER'],
        ['expires_at', 'INTEGER'],
        ['lifted_at', 'INTEGER']
      ]
      for (const [column, type] of columns) {
        if (!this.hasColumn('peer_link_containment', column)) {
          this.db.exec(`ALTER TABLE peer_link_containment ADD COLUMN ${column} ${type}`)
        }
      }
    }

    if (hasTable('peer_reply_outbox')) {
      const columns: [string, string][] = [
        ['seq', 'INTEGER'],
        ['local_message_id', 'TEXT'],
        ['link_device_id', 'TEXT'],
        ['environment_id', 'TEXT'],
        ['bound_pairing_revision', 'INTEGER'],
        ['peer_credential_fp', 'TEXT'],
        ['peer_key_fingerprint', 'TEXT'],
        ['in_reply_to_message_id', 'TEXT'],
        ['peer_agent_id', 'TEXT'],
        ['peer_thread_id', 'TEXT'],
        ['local_thread_id', 'TEXT'],
        ['notice_run_id', 'TEXT'],
        ['notice_pane_key', 'TEXT'],
        ['payload', 'TEXT'],
        ['byte_count', 'INTEGER'],
        ['state', "TEXT NOT NULL DEFAULT 'queued'"],
        ['lease_expires_at', 'INTEGER'],
        ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
        ['consecutive_failures', 'INTEGER NOT NULL DEFAULT 0'],
        ['hold_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['first_held_at', 'INTEGER'],
        ['last_attempt_at', 'INTEGER'],
        ['next_attempt_after', 'INTEGER'],
        ['last_error_code', 'TEXT'],
        ['last_error', 'TEXT'],
        ['peer_message_id', 'TEXT'],
        ['peer_reply_thread_id', 'TEXT'],
        ['created_at', 'INTEGER'],
        ['settled_at', 'INTEGER'],
        ['notified_at', 'INTEGER'],
        // Ruling 26 Addendum 3(aa): unshipped-repair path for the new notice-edge column (S10-16
        // C5d) — never a schema-version bump.
        ['last_notified_condition', 'TEXT'],
        // Ruling 26 Addendum 4(ii): same unshipped-repair pattern, one commit later (S10-16 C5e)
        // — never a schema-version bump. Re-triggers the fail-closed repair sweep below once on
        // every existing v40 database (harmless, one-time — (ll)).
        ['last_notified_at', 'INTEGER']
      ]
      let addedColumn = false
      for (const [column, type] of columns) {
        if (!this.hasColumn('peer_reply_outbox', column)) {
          this.db.exec(`ALTER TABLE peer_reply_outbox ADD COLUMN ${column} ${type}`)
          addedColumn = true
        }
      }
      if (addedColumn) {
        const incomplete = this.db
          .prepare(
            `SELECT id FROM peer_reply_outbox
              WHERE link_device_id IS NULL OR environment_id IS NULL OR peer_agent_id IS NULL
                 OR payload IS NULL OR local_message_id IS NULL`
          )
          .all() as { id: string }[]
        for (const row of incomplete) {
          // Ruling 28(j)/ML-5: `settled_at != NULL` is now terminal for the claim, the kick, the
          // per-link cap and health (reply-outbox-store.ts) — the far-future
          // `next_attempt_after` hack this fallback used before that was true is no longer
          // needed, and is dropped so a repaired row's `next_attempt_after` cannot outlive the
          // predicate it once had to defeat.
          let usedFallback = false
          try {
            this.db
              .prepare(
                `UPDATE peer_reply_outbox
                    SET state = 'abandoned', settled_at = ?, last_error_code = 'incomplete_row_fail_closed'
                  WHERE id = ?`
              )
              .run(now, row.id)
          } catch {
            // F7/Ruling 28(j): mirror the binding branch's fallback — a pre-review build's
            // `state` CHECK may reject 'abandoned'; fall back to the columns no CHECK constrains
            // (settled_at / last_error_code) so the row still stops being claimable via
            // settled_at alone. The code is REPLY_OUTBOX_REPAIR_REJECTED_CODE, distinct from the
            // primary path's 'incomplete_row_fail_closed' — a row here was rejected AT the
            // repair, not merely found incomplete by it.
            usedFallback = true
            this.db
              .prepare(
                `UPDATE peer_reply_outbox
                    SET settled_at = ?, last_error_code = ?
                  WHERE id = ?`
              )
              .run(now, REPLY_OUTBOX_REPAIR_REJECTED_CODE, row.id)
          }
          this.writeAgentAudit({
            agentId: null,
            actorPaneKey: null,
            // F8: name the outbox row the repair acted on — 'local' left every row indistinguishable.
            actorHostId: row.id,
            verb: 'link_binding_unshipped_v40_repair',
            outcome: 'abandoned',
            reasonCode: usedFallback
              ? REPLY_OUTBOX_REPAIR_REJECTED_CODE
              : 'incomplete_row_fail_closed'
          })
        }
      }
    }

    // F9/MOD2/L-9/X3: the drop-and-recreate table SET is driven from THE REGISTER
    // (A2_DROP_AND_RECREATE_TABLES) — this loop's `table` values are no longer a second
    // hard-coded copy of that list. The column maps stay local (they are per-table probe detail,
    // not one of the register's own owned facts) but are keyed by the same names.
    const dropAndRecreateColumns: Record<(typeof A2_DROP_AND_RECREATE_TABLES)[number], string[]> = {
      peer_link_attempts: [
        'link_device_id',
        'last_outcome',
        'consecutive_failures',
        'consecutive_no_winner',
        'misroute_advisories'
      ],
      peer_link_scan_facts: [
        'link_device_id',
        'environment_id',
        'outcome',
        'environment_pairing_revision',
        'link_credential_fp',
        'observed_at'
      ],
      peer_link_confirm_observations: ['link_device_id', 'environment_id', 'kind', 'observed_at']
    }
    for (const table of A2_DROP_AND_RECREATE_TABLES) {
      const columns = dropAndRecreateColumns[table]
      if (!hasTable(table)) {
        continue
      }
      const missing = columns.some((column) => !this.hasColumn(table, column))
      if (missing) {
        this.db.exec(`DROP TABLE ${table}`)
      }
    }
    // Re-creates any dropped table above from the single source of truth.
    this.db.exec(S10_16_LINK_BINDING_SCHEMA_SQL)
  }

  // S10-15 review m-2: scoped to host_id and capped at one match — deterministic today only
  // because host_id is the constant 'local' for every row this DB ever writes; defense in depth
  // against a future multi-host-per-db writer, and keeps the scalar subquery from ever throwing
  // "more than one row returned" if that invariant is ever loosened. Idempotent: re-running finds
  // nothing left to repoint once every stranded row has been.
  private repointStrandedDisplayNameAddressedMessages(): void {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET to_handle = 'agent:' || (
           SELECT a.id FROM agents a
           WHERE a.display_name = messages.to_handle AND a.tombstoned_at IS NULL AND a.host_id = 'local'
           LIMIT 1
         )
         WHERE recipient_pane_key IS NULL
           AND read = 0
           AND EXISTS (
             SELECT 1 FROM agents a
             WHERE a.display_name = messages.to_handle AND a.tombstoned_at IS NULL AND a.host_id = 'local'
           )`
      )
      .run()
    // Ruling 31(c): this rewrite (F7a) was previously silent — log the row count once, no
    // message content, whenever it actually repoints something. Idempotent: a later call finds
    // nothing left to repoint and logs nothing.
    if (result.changes > 0) {
      console.warn('[orchestration] stranded display-name-addressed messages repointed', {
        count: result.changes
      })
    }
  }

  private createTables(): void {
    this.repairUnshippedV35PactEra()
    this.repairUnshippedV36RelinkGeneration()
    this.repairUnshippedV37RemoteAgentIdentity()
    this.repairUnshippedV38PeerRouting()
    this.repairUnshippedV39AttachmentRetentionFloor()
    this.repairUnshippedV40LinkBinding()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                    TEXT PRIMARY KEY,
        objective             TEXT NOT NULL,
        home_database         TEXT NOT NULL DEFAULT 'this_database',
        coordinator_handle    TEXT,
        coordinator_pane_key  TEXT,
        consumer_generation   INTEGER NOT NULL DEFAULT 0,
        legacy                INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT NOT NULL,
        run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
          CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
        from_handle   TEXT NOT NULL,
        to_handle     TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'status'
          CHECK(type IN (
            'status', 'dispatch', 'worker_done', 'merge_ready',
            'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
          )),
        priority      TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('normal', 'high', 'urgent')),
        thread_id     TEXT,
        payload       TEXT,
        read          INTEGER NOT NULL DEFAULT 0,
        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at  TEXT,
        sender_pane_key TEXT,
        recipient_pane_key TEXT,
        sender_agent_id TEXT,
        purged_at TEXT,
        purge_reason TEXT,
        purged_by_agent_id TEXT,
        gate_flags TEXT,
        thread_sequence INTEGER,
        -- payload_kind (v34, S10-2/pact rev 7): a dedicated discriminator column for the
        -- pact-step kind. The JSON payload.kind namespace is already used by runtime
        -- notifications (input_not_consumed / liveness_breach / relay_unreachable), so the
        -- pact-step discriminator gets its own column instead of overloading that namespace;
        -- callers can never set it (see insertGatedMessage's payload_kind_reserved refusal).
        payload_kind TEXT,
        -- v38 (S10-15, chair ruling 7): cross-host send/reply provenance. peer_link_device_id is
        -- set ONLY on an inbound-imported row (the "authored remotely" discriminator, never on an
        -- outbound relay's local mirror); peer_agent_id/peer_thread_id are the counterpart's own
        -- directory/thread ids; peer_relayed_at is set once a peer accepted an outbound relay. No
        -- peer_fingerprint column: R9's automatic fingerprint->environment route resolution was
        -- cut (Task 0 escalation, ruling 7) — it carried no routing assurance without it anyway.
        peer_link_device_id TEXT,
        peer_agent_id TEXT,
        peer_thread_id TEXT,
        peer_relayed_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
      CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

      CREATE TABLE IF NOT EXISTS deliveries (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL,
        consumer_generation   INTEGER NOT NULL,
        message_ids           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'outstanding'
          CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at       TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
        ON deliveries(run_id) WHERE status = 'outstanding';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);

      CREATE TABLE IF NOT EXISTS mutation_receipts (
        caller_fingerprint  TEXT NOT NULL,
        request_id          TEXT NOT NULL,
        method              TEXT NOT NULL,
        payload_hash        TEXT NOT NULL,
        state               TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending', 'completed')),
        receipt             TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (caller_fingerprint, request_id)
      );

      CREATE TABLE IF NOT EXISTS worker_dispatches (
        dispatch_id            TEXT PRIMARY KEY,
        runtime_epoch          TEXT,
        state                  TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned'
          )),
        stage                  TEXT NOT NULL DEFAULT 'accepted',
        worktree_id            TEXT,
        agent_terminal_handle  TEXT,
        setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
        effects                TEXT NOT NULL DEFAULT '[]',
        residual_resources     TEXT NOT NULL DEFAULT '[]',
        start_options          TEXT NOT NULL DEFAULT '{}',
        input_evidence         TEXT,
        input_observed_at      TEXT,
        last_error             TEXT,
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS worker_terminal_resources (
        id                       TEXT PRIMARY KEY,
        origin_dispatch_id       TEXT NOT NULL,
        owner_dispatch_id        TEXT NOT NULL,
        prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
        worktree_id              TEXT,
        terminal_handle          TEXT NOT NULL,
        pane_key                 TEXT,
        process_incarnation      TEXT,
        host_scope               TEXT,
        ownership_state          TEXT NOT NULL DEFAULT 'owned'
          CHECK(ownership_state IN ('owned', 'transferred', 'user_owned', 'external', 'released')),
        release_state            TEXT NOT NULL DEFAULT 'not_requested'
          CHECK(release_state IN (
            'not_requested', 'retained', 'requested', 'releasing', 'released', 'unknown'
          )),
        retained_reason          TEXT,
        release_requested_at     TEXT,
        release_completed_at     TEXT,
        release_error            TEXT,
        archive_source           TEXT,
        archive_status           TEXT,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_terminal_resources_owner
        ON worker_terminal_resources(owner_dispatch_id);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_handle
        ON worker_terminal_resources(terminal_handle);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_pane
        ON worker_terminal_resources(pane_key);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_identity
        ON worker_terminal_resources(process_incarnation, host_scope);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_release
        ON worker_terminal_resources(release_state);

      CREATE TABLE IF NOT EXISTS worker_terminal_archives (
        dispatch_id   TEXT PRIMARY KEY,
        resource_id   TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail')),
        content       TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS federated_dispatches (
        dispatch_id             TEXT PRIMARY KEY,
        environment_id          TEXT NOT NULL,
        environment_name        TEXT NOT NULL,
        peer_fingerprint        TEXT NOT NULL,
        remote_runtime_epoch    TEXT,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        remote_worktree_id      TEXT,
        remote_terminal_handle  TEXT,
        to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
        to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
        -- Bumped by relinkFederatedEnvironment (S10-4 ruling 5) each time this dispatch's
        -- cursors are zeroed for a reimaged/reinstalled peer. relay_seen's PK includes this so
        -- a post-relink sequence 1 lands as a NEW row instead of colliding (INSERT OR IGNORE)
        -- with whatever sequence 1 recorded before the relink.
        relink_generation       INTEGER NOT NULL DEFAULT 0,
        last_sync_at            TEXT,
        last_error              TEXT,
        consecutive_failures    INTEGER NOT NULL DEFAULT 0,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
        dispatch_id             TEXT PRIMARY KEY,
        task_id                 TEXT NOT NULL,
        home_peer_fingerprint   TEXT NOT NULL,
        protocol_version        INTEGER NOT NULL DEFAULT 1,
        runtime_epoch           TEXT NOT NULL,
        capability_hash         TEXT,
        pane_key                TEXT,
        process_incarnation     TEXT,
        state                   TEXT NOT NULL DEFAULT 'starting'
          CHECK(state IN (
            'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
            'stopping', 'stop_unknown', 'stopped', 'abandoned', 'agent_exited'
          )),
        stage                   TEXT NOT NULL DEFAULT 'accepted',
        worktree_id             TEXT,
        terminal_handle         TEXT,
        setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
        effects                 TEXT NOT NULL DEFAULT '[]',
        residual_resources      TEXT NOT NULL DEFAULT '[]',
        to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
        last_error              TEXT,
        -- v39 (S10-19): peer-owned-pane close/prune bookkeeping. blocked_* serialize the
        -- prompt-answer choke's single-shot reservation; handle_bound_at / agent_exited_at are
        -- INV-P-013's close ordering facts (agent_exited_at is the only durable exit fact).
        blocked_reason          TEXT,
        blocked_at              TEXT,
        blocked_consumed_at     TEXT,
        handle_bound_at         TEXT,
        agent_exited_at         TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rda_terminal_handle
        ON remote_dispatch_attachments(terminal_handle);

      -- Ruling 31(b): install-day retention floor for pruneSettledRemoteAttachments. F7:
      -- createTables() runs before migrate() on every open (db.ts open()), so THIS is the one
      -- site that actually stamps it — for a fresh store (no pre-existing row is ever evaluated)
      -- and for an upgraded store alike (INSERT OR IGNORE against PRIMARY KEY CHECK(id=1) makes
      -- it idempotent). The v39 migration step's INSERT OR IGNORE and
      -- repairUnshippedV39AttachmentRetentionFloor's INSERT OR IGNORE are both guaranteed no-ops.
      CREATE TABLE IF NOT EXISTS peer_attachment_retention_floor (
        id       INTEGER PRIMARY KEY CHECK(id = 1),
        floor_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO peer_attachment_retention_floor (id, floor_at) VALUES (1, datetime('now'));

      -- v39 (S10-19): peer run-mailbox sharing grants. Created empty; the reader is behind
      -- peerRunMailboxScoped:false, and the operator writer is not built by this slice
      -- (§G.1 of the S10-19 implementation plan — chair decision pending).
      CREATE TABLE IF NOT EXISTS peer_run_grants (
        run_id                  TEXT NOT NULL,
        peer_link_device_id     TEXT NOT NULL,
        granted_at              TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, peer_link_device_id)
      );

      CREATE TABLE IF NOT EXISTS federation_relay_items (
        dispatch_id   TEXT NOT NULL,
        direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
        sequence      INTEGER NOT NULL,
        message_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        byte_count    INTEGER NOT NULL,
        acked_at      TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (dispatch_id, direction, sequence),
        UNIQUE (dispatch_id, direction, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
        ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

      CREATE TABLE IF NOT EXISTS remote_questions (
        message_id        TEXT PRIMARY KEY,
        dispatch_id       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id TEXT,
        answer_body       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
        ON remote_questions(dispatch_id, status);

      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        parent_id     TEXT,
        created_by_terminal_handle TEXT,
        created_by_pane_key TEXT,
        created_by_process_incarnation TEXT,
        created_by_run_generation INTEGER,
        task_title    TEXT,
        display_name  TEXT,
        spec          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN (
            'pending', 'ready', 'dispatched',
            'completed', 'failed', 'blocked'
          )),
        deps          TEXT NOT NULL DEFAULT '[]',
        result        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE IF NOT EXISTS dispatch_contexts (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        task_id             TEXT NOT NULL,
        contract_version    INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION},
        launch_token_hash   TEXT,
        assignee_handle     TEXT,
        assignee_pane_key   TEXT,
        capability_hash     TEXT,
        process_incarnation TEXT,
        capability_revoked_at TEXT,
        status              TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_failure        TEXT,
        dispatched_at       TEXT,
        completed_at        TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at   TEXT,
        blocked_since       TEXT,
        liveness_breached_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);
      CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

      CREATE TABLE IF NOT EXISTS decision_gates (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
        task_id       TEXT NOT NULL,
        question      TEXT NOT NULL,
        options       TEXT NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'resolved', 'timeout')),
        resolution    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
      CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

      CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane_leaf
        ON runs(${RUN_PANE_KEY_MATCH_SUFFIX_SQL})
        WHERE coordinator_pane_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS coordinator_runs (
        id                  TEXT PRIMARY KEY,
        spec                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'completed', 'failed')),
        coordinator_handle  TEXT NOT NULL,
        poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT,
        scheduler_lost_at   TEXT
      );

      ${AGENT_DIRECTORY_SCHEMA_SQL}
      ${THREAD_DIRECTORY_SCHEMA_SQL}
      ${S10_4_FEDERATION_SCHEMA_SQL}
      ${S10_16_LINK_BINDING_SCHEMA_SQL}
    `)
    this.createUndeliveredInboxIndexIfPossible()
    this.createThreadDirectoryIndexesIfPossible()
    this.createPactSchemaIndexesIfPossible()
  }

  // Why: CREATE TABLE IF NOT EXISTS won't alter existing DBs; migrate in a txn that bumps user_version only on success (atomic all-or-nothing).
  private migrate(): void {
    const storedVersion = this.db.pragma('user_version', { simple: true }) as number
    const current = resolveOrchestrationMigrationStartVersion(
      this.db,
      storedVersion,
      SCHEMA_VERSION
    )
    if (current >= SCHEMA_VERSION) {
      return
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // v1 → v2: SQLite can't ALTER a CHECK, so rebuild messages to allow 'heartbeat'; fold in v3's delivered_at to skip a second rebuild.
      if (current < 2) {
        if (!this.hasColumn('dispatch_contexts', 'last_heartbeat_at')) {
          this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN last_heartbeat_at TEXT`)
        }

        if (!this.messagesTypeCheckAllowsHeartbeat()) {
          // Why: recreate indexes here — DROP TABLE drops them; createTables re-runs only next startup, so skipping full-scans until restart.
          this.db.exec(`
            CREATE TABLE messages_new (
              id            TEXT NOT NULL,
              from_handle   TEXT NOT NULL,
              to_handle     TEXT NOT NULL,
              subject       TEXT NOT NULL,
              body          TEXT NOT NULL DEFAULT '',
              type          TEXT NOT NULL DEFAULT 'status'
                CHECK(type IN (
                  'status', 'dispatch', 'worker_done', 'merge_ready',
                  'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
                )),
              priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK(priority IN ('normal', 'high', 'urgent')),
              thread_id     TEXT,
              payload       TEXT,
              read          INTEGER NOT NULL DEFAULT 0,
              sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              delivered_at  TEXT
            );
            INSERT INTO messages_new (
              id, from_handle, to_handle, subject, body, type, priority,
              thread_id, payload, read, sequence, created_at
            )
            SELECT
              id, from_handle, to_handle, subject, body, type, priority,
              thread_id, payload, read, sequence, created_at
            FROM messages;
            DROP TABLE messages;
            ALTER TABLE messages_new RENAME TO messages;

            CREATE UNIQUE INDEX idx_messages_id ON messages(id);
            CREATE INDEX idx_inbox ON messages(to_handle, read);
            CREATE INDEX idx_messages_undelivered_inbox
              ON messages(to_handle, read, delivered_at, sequence);
            CREATE INDEX idx_thread ON messages(thread_id);
          `)
        }
      }

      // v2 → v3: add messages.delivered_at. hasColumn probe skips DBs that already got it via the v1→v2 rebuild (else a dup-column error aborts the txn).
      if (current < 3) {
        if (!this.hasColumn('messages', 'delivered_at')) {
          this.db.exec(`ALTER TABLE messages ADD COLUMN delivered_at TEXT`)
        }
      }
      if (current < 4) {
        if (!this.hasColumn('tasks', 'created_by_terminal_handle')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN created_by_terminal_handle TEXT`)
        }
      }
      if (current < 5) {
        if (!this.hasColumn('tasks', 'task_title')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN task_title TEXT`)
        }
        if (!this.hasColumn('tasks', 'display_name')) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN display_name TEXT`)
        }
      }
      if (current < 6) {
        if (!this.hasColumn('dispatch_contexts', 'assignee_pane_key')) {
          this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN assignee_pane_key TEXT`)
        }
        if (!this.hasColumn('messages', 'sender_pane_key')) {
          this.db.exec(`ALTER TABLE messages ADD COLUMN sender_pane_key TEXT`)
        }
      }
      if (current < 7) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO runs (
               id, objective, home_database, consumer_generation, legacy
             ) VALUES (?, ?, 'this_database', 0, 1)`
          )
          .run(LEGACY_RUN_ID, 'Legacy orchestration state (inspect only)')
        for (const table of ['messages', 'tasks', 'dispatch_contexts', 'decision_gates']) {
          if (!this.hasColumn(table, 'run_id')) {
            this.db.exec(
              `ALTER TABLE ${table} ADD COLUMN run_id TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}'`
            )
          }
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_messages_run_sequence ON messages(run_id, sequence);
          CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_dispatch_run_status ON dispatch_contexts(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_gates_run_status ON decision_gates(run_id, status);
          CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane ON runs(coordinator_pane_key);
        `)
      }
      if (current < 8) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS deliveries (
            id                    TEXT PRIMARY KEY,
            run_id                TEXT NOT NULL,
            consumer_generation   INTEGER NOT NULL,
            message_ids           TEXT NOT NULL,
            status                TEXT NOT NULL DEFAULT 'outstanding'
              CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
            created_at            TEXT NOT NULL DEFAULT (datetime('now')),
            acknowledged_at       TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
            ON deliveries(run_id) WHERE status = 'outstanding';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);

      CREATE TABLE IF NOT EXISTS question_threads (
        message_id                TEXT PRIMARY KEY,
        run_id                    TEXT NOT NULL,
        dispatch_id               TEXT NOT NULL,
        asker_handle              TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'answered', 'closed')),
        answer_message_id         TEXT,
        answer_body               TEXT,
        answered_by_generation    INTEGER,
        created_at                TEXT NOT NULL DEFAULT (datetime('now')),
        answered_at               TEXT,
        closed_at                 TEXT,
        to_agent_id               TEXT,
        answered_by_agent_id      TEXT,
        answer_body_sha256        TEXT,
        answer_purged_at          TEXT,
        thread_key                TEXT,
        expires_at                TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_questions_dispatch_status
        ON question_threads(dispatch_id, status);
        `)
      }
      if (current < 9 && !this.messagesTypeCheckAllowsQuestion()) {
        this.db.exec(`
          CREATE TABLE messages_new (
            id              TEXT NOT NULL,
            run_id          TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
            from_handle     TEXT NOT NULL,
            to_handle       TEXT NOT NULL,
            subject         TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            type            TEXT NOT NULL DEFAULT 'status'
              CHECK(type IN (
                'status', 'dispatch', 'worker_done', 'merge_ready',
                'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
              )),
            priority        TEXT NOT NULL DEFAULT 'normal'
              CHECK(priority IN ('normal', 'high', 'urgent')),
            thread_id       TEXT,
            payload         TEXT,
            read            INTEGER NOT NULL DEFAULT 0,
            sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at    TEXT,
            sender_pane_key TEXT
          );
          INSERT INTO messages_new (
            id, run_id, from_handle, to_handle, subject, body, type, priority,
            thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
          )
          SELECT
            id, run_id, from_handle, to_handle, subject, body, type, priority,
            thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
          FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;

          CREATE UNIQUE INDEX idx_messages_id ON messages(id);
          CREATE INDEX idx_inbox ON messages(to_handle, read);
          CREATE INDEX idx_thread ON messages(thread_id);
          CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence);
          CREATE INDEX idx_messages_undelivered_inbox
            ON messages(to_handle, read, delivered_at, sequence);
        `)
      }
      if (current < 10) {
        if (!this.hasColumn('dispatch_contexts', 'capability_hash')) {
          this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN capability_hash TEXT')
        }
        if (!this.hasColumn('dispatch_contexts', 'process_incarnation')) {
          this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN process_incarnation TEXT')
        }
        if (!this.hasColumn('dispatch_contexts', 'capability_revoked_at')) {
          this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN capability_revoked_at TEXT')
        }
      }
      if (current < 11) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mutation_receipts (
            caller_fingerprint  TEXT NOT NULL,
            request_id          TEXT NOT NULL,
            method              TEXT NOT NULL,
            payload_hash        TEXT NOT NULL,
            state               TEXT NOT NULL DEFAULT 'pending'
              CHECK(state IN ('pending', 'completed')),
            receipt             TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (caller_fingerprint, request_id)
          );
        `)
      }
      if (current < 12) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS worker_dispatches (
            dispatch_id            TEXT PRIMARY KEY,
            runtime_epoch          TEXT,
            state                  TEXT NOT NULL DEFAULT 'starting'
              CHECK(state IN (
                'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
                'stopping', 'stop_unknown', 'stopped', 'abandoned'
              )),
            stage                  TEXT NOT NULL DEFAULT 'accepted',
            worktree_id            TEXT,
            agent_terminal_handle  TEXT,
            setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
            effects                TEXT NOT NULL DEFAULT '[]',
            residual_resources     TEXT NOT NULL DEFAULT '[]',
            start_options          TEXT NOT NULL DEFAULT '{}',
            last_error             TEXT,
            created_at             TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `)
      }
      if (current < 13 && !this.hasColumn('worker_dispatches', 'runtime_epoch')) {
        this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN runtime_epoch TEXT')
      }
      if (current < 14) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS federated_dispatches (
            dispatch_id             TEXT PRIMARY KEY,
            environment_id          TEXT NOT NULL,
            environment_name        TEXT NOT NULL,
            peer_fingerprint        TEXT NOT NULL,
            remote_runtime_epoch    TEXT,
            protocol_version        INTEGER NOT NULL DEFAULT 1,
            remote_worktree_id      TEXT,
            remote_terminal_handle  TEXT,
            to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
            to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
            dispatch_id             TEXT PRIMARY KEY,
            task_id                 TEXT NOT NULL,
            home_peer_fingerprint   TEXT NOT NULL,
            protocol_version        INTEGER NOT NULL DEFAULT 1,
            runtime_epoch           TEXT NOT NULL,
            capability_hash         TEXT,
            pane_key                TEXT,
            process_incarnation     TEXT,
            state                   TEXT NOT NULL DEFAULT 'starting'
              CHECK(state IN (
                'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
                'stopping', 'stop_unknown', 'stopped', 'abandoned'
              )),
            stage                   TEXT NOT NULL DEFAULT 'accepted',
            worktree_id             TEXT,
            terminal_handle         TEXT,
            setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
            effects                 TEXT NOT NULL DEFAULT '[]',
            residual_resources      TEXT NOT NULL DEFAULT '[]',
            to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
            last_error              TEXT,
            created_at              TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `)
      }
      if (current < 15) {
        if (!this.hasColumn('federated_dispatches', 'to_home_imported_sequence')) {
          this.db.exec(
            'ALTER TABLE federated_dispatches ADD COLUMN to_home_imported_sequence INTEGER NOT NULL DEFAULT 0'
          )
        }
        if (!this.hasColumn('remote_dispatch_attachments', 'to_worker_imported_sequence')) {
          this.db.exec(
            'ALTER TABLE remote_dispatch_attachments ADD COLUMN to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0'
          )
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS federation_relay_items (
            dispatch_id   TEXT NOT NULL,
            direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
            sequence      INTEGER NOT NULL,
            message_id    TEXT NOT NULL,
            kind          TEXT NOT NULL,
            payload       TEXT NOT NULL,
            byte_count    INTEGER NOT NULL,
            acked_at      TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (dispatch_id, direction, sequence),
            UNIQUE (dispatch_id, direction, message_id)
          );
          CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
            ON federation_relay_items(dispatch_id, direction, acked_at, sequence);
        `)
      }
      if (current < 16) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS remote_questions (
            message_id        TEXT PRIMARY KEY,
            dispatch_id       TEXT NOT NULL,
            status            TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'answered', 'closed')),
            answer_message_id TEXT,
            answer_body       TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            answered_at       TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
            ON remote_questions(dispatch_id, status);
        `)
      }
      if (current < 17 && !this.hasColumn('remote_dispatch_attachments', 'protocol_version')) {
        this.db.exec(
          'ALTER TABLE remote_dispatch_attachments ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1'
        )
      }
      if (current < 19) {
        this.migrateLegacyContractStorage()
      }
      if (current < 20) {
        this.backfillLegacyQuestionThreads()
      }
      if (current < 21) {
        this.migrateLegacySchedulerLossProvenance()
      }
      if (current < 22) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle
            ON dispatch_contexts(assignee_handle);
        `)
      }
      if (current < 23) {
        this.backfillWorkerTerminalResources()
      }
      if (current < 24) {
        if (!this.hasColumn('tasks', 'created_by_pane_key')) {
          this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_pane_key TEXT')
        }
        if (!this.hasColumn('tasks', 'created_by_process_incarnation')) {
          this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_process_incarnation TEXT')
        }
        if (!this.hasColumn('tasks', 'created_by_run_generation')) {
          this.db.exec('ALTER TABLE tasks ADD COLUMN created_by_run_generation INTEGER')
        }
      }
      if (current < 25) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dispatch_active_assignee_handle
            ON dispatch_contexts(assignee_handle)
            WHERE assignee_handle IS NOT NULL AND status IN ('pending', 'dispatched');
        `)
      }
      if (current < 26) {
        migrateMutationReceiptCapacity(this.db)
      }
      if (
        current < 27 &&
        !this.hasColumn('federated_dispatches', 'to_home_acknowledged_sequence')
      ) {
        this.db.exec(
          'ALTER TABLE federated_dispatches ADD COLUMN to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0'
        )
      }
      if (current < 28 && !this.hasColumn('dispatch_contexts', 'blocked_since')) {
        this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN blocked_since TEXT')
      }
      if (current < 29 && !this.hasColumn('dispatch_contexts', 'liveness_breached_at')) {
        this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN liveness_breached_at TEXT')
      }
      if (current < 30 && !this.hasColumn('worker_dispatches', 'input_evidence')) {
        this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN input_evidence TEXT')
      }
      if (current < 30 && !this.hasColumn('worker_dispatches', 'input_observed_at')) {
        this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN input_observed_at TEXT')
      }
      if (current < 31) {
        if (!this.hasColumn('federated_dispatches', 'last_sync_at')) {
          this.db.exec('ALTER TABLE federated_dispatches ADD COLUMN last_sync_at TEXT')
        }
        if (!this.hasColumn('federated_dispatches', 'last_error')) {
          this.db.exec('ALTER TABLE federated_dispatches ADD COLUMN last_error TEXT')
        }
        if (!this.hasColumn('federated_dispatches', 'consecutive_failures')) {
          this.db.exec(
            'ALTER TABLE federated_dispatches ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0'
          )
        }
      }
      // v31 → v32: a bare peer handle carries no mailbox row, so the durable
      // re-mint address (BUG 6) has to live on the message itself.
      if (current < 32 && !this.hasColumn('messages', 'recipient_pane_key')) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN recipient_pane_key TEXT`)
      }
      // v32 → v33 (S10-1): agent directory, durable mailbox_deliveries, provenance audit/rate
      // tables, and message author provenance for S10-3 purge/quarantine.
      if (current < 33) {
        if (!this.hasColumn('messages', 'sender_agent_id')) {
          this.db.exec(`ALTER TABLE messages ADD COLUMN sender_agent_id TEXT`)
        }
        this.db.exec(AGENT_DIRECTORY_SCHEMA_SQL)
        this.db
          .prepare(
            `INSERT OR IGNORE INTO runs (
               id, objective, home_database, consumer_generation, legacy
             ) VALUES (?, ?, 'this_database', 0, 0)`
          )
          .run(PEER_RUN_ID, 'Peer agent mail (S10)')
      }
      // v33 -> v34 (S10-2): durable threads, gate refusal audit, purge tombstone columns on
      // messages, the payload_kind pact-step discriminator column on messages, peer-question
      // binding columns on question_threads. `question_threads` only
      // ever gets created above (`current < 8`), never in createTables() — the same is true
      // here: THREAD_DIRECTORY_SCHEMA_SQL's backfill reads `question_threads`, so it must run
      // after that block, which sequential `if (current < N)` execution within one migrate()
      // call already guarantees for both a fresh install (current starts at 0) and an upgrade.
      if (current < 34) {
        for (const column of [
          ['purged_at', 'TEXT'],
          ['purge_reason', 'TEXT'],
          ['purged_by_agent_id', 'TEXT'],
          ['gate_flags', 'TEXT'],
          ['thread_sequence', 'INTEGER'],
          // payload_kind (pact rev 7): dedicated pact-step discriminator column, additive and
          // separate from the JSON payload.kind namespace already used by runtime
          // notifications (input_not_consumed / liveness_breach / relay_unreachable). Callers
          // can never set it directly; see insertGatedMessage's payload_kind_reserved refusal.
          ['payload_kind', 'TEXT']
        ] as const) {
          if (!this.hasColumn('messages', column[0])) {
            this.db.exec(`ALTER TABLE messages ADD COLUMN ${column[0]} ${column[1]}`)
          }
        }
        for (const column of [
          ['to_agent_id', 'TEXT'],
          ['answered_by_agent_id', 'TEXT'],
          ['answer_body_sha256', 'TEXT'],
          ['answer_purged_at', 'TEXT'],
          ['thread_key', 'TEXT']
        ] as const) {
          if (!this.hasColumn('question_threads', column[0])) {
            this.db.exec(`ALTER TABLE question_threads ADD COLUMN ${column[0]} ${column[1]}`)
          }
        }
        this.db.exec(THREAD_DIRECTORY_SCHEMA_SQL)
        this.createThreadDirectoryIndexesIfPossible()
        this.db.exec(THREAD_DIRECTORY_BACKFILL_SQL)
      }
      // v34 -> v35 (S10-3 pact spec): additive-only ALTERs on `threads`; pact_steps itself was
      // already created above (THREAD_DIRECTORY_SCHEMA_SQL, no dependency on these columns, run
      // unconditionally by createTables() before migrate() even starts). idx_pact_pair_live and
      // trg_pact_turn_membership need the columns below to exist first, hence the explicit
      // second call here (createTables()'s earlier call was a guarded no-op against this DB).
      if (current < 35) {
        for (const [column, ddl] of [
          ['pact_proposer_agent_id', 'TEXT'],
          ['pact_steps_total', 'INTEGER'],
          ['pact_ordinal', 'INTEGER NOT NULL DEFAULT 0'],
          ['pact_era', 'INTEGER NOT NULL DEFAULT 0'],
          ['pact_paused_at', 'TEXT'],
          [
            'pact_pause_reason',
            `TEXT CHECK(pact_pause_reason IS NULL OR pact_pause_reason IN ` +
              `('counterpart_gone','counterpart_left','counterpart_quarantined','thread_paused','thread_closed','operator'))`
          ]
        ] as const) {
          if (!this.hasColumn('threads', column)) {
            this.db.exec(`ALTER TABLE threads ADD COLUMN ${column} ${ddl}`)
          }
        }
        // Blocker fix (S10-3b review): pact_steps itself was already created above via
        // THREAD_DIRECTORY_SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS`, which is a no-op against a
        // DB that already ran an earlier (pre-fix) copy of this same unshipped v35 — such a DB's
        // pact_steps lacks pact_era and idx_pact_step_ordinal still lacks the era column, so
        // "IF NOT EXISTS" alone would leave the ordinal-collision bug in place. Patch both.
        if (!this.hasColumn('pact_steps', 'pact_era')) {
          this.db.exec(`ALTER TABLE pact_steps ADD COLUMN pact_era INTEGER NOT NULL DEFAULT 0`)
          this.db.exec(`DROP INDEX IF EXISTS idx_pact_step_ordinal`)
          this.db.exec(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_pact_step_ordinal
               ON pact_steps(thread_id, pact_era, ordinal) WHERE kind = 'step'`
          )
        }
        this.createPactSchemaIndexesIfPossible()
      }
      // v35 -> v36 (S10-4 rulings 1/2): remote_agents + relay_seen. Neither table has a column
      // dependency on anything created later, so createTables() already created both
      // unconditionally earlier in this same open (same idempotent discipline as
      // AGENT_DIRECTORY_SCHEMA_SQL's `current < 33` re-exec above) — re-run here too so an
      // upgrading DB's version bump and its schema land inside the same atomic migration
      // transaction.
      if (current < 36) {
        this.db.exec(S10_4_FEDERATION_SCHEMA_SQL)
        // relink-generation fix (post-ruling-1 review), same "unshipped version, patch in
        // place" discipline as pact_era's `current < 35` block above: federated_dispatches
        // predates relink_generation whenever the table was created by an EARLIER migrate()
        // block (v14, or a dev DB that already ran a pre-fix copy of this same unshipped v36),
        // since S10_4_FEDERATION_SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS` above is then a
        // no-op. ALTER unconditionally covers both: a genuinely fresh createTables() run
        // already has the column (created inline), so this is a guarded no-op there.
        if (!this.hasColumn('federated_dispatches', 'relink_generation')) {
          this.db.exec(
            'ALTER TABLE federated_dispatches ADD COLUMN relink_generation INTEGER NOT NULL DEFAULT 0'
          )
        }
        // relay_seen's PK cannot be widened via ALTER — only a dev DB that already created the
        // table under a pre-fix copy of this same unshipped v36 (relay_seen's own header
        // above) hits this; a fresh createTables() run already has the 3-column PK inline, so
        // this whole block is a no-op there. Rows are back-filled at generation 0, the same
        // epoch they were always recorded under (no relink had run yet on any DB old enough to
        // need this patch).
        if (!this.hasColumn('relay_seen', 'generation')) {
          this.db.exec(`
            DROP TRIGGER IF EXISTS trg_relay_seen_no_update;
            DROP TRIGGER IF EXISTS trg_relay_seen_no_delete;
            ALTER TABLE relay_seen RENAME TO relay_seen_pre_generation;
            CREATE TABLE relay_seen (
              dispatch_id   TEXT NOT NULL,
              sequence      INTEGER NOT NULL,
              generation    INTEGER NOT NULL DEFAULT 0,
              message_id    TEXT NOT NULL,
              outcome       TEXT NOT NULL CHECK(outcome IN ('imported', 'refused', 'duplicate')),
              rule_ids      TEXT,
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY(dispatch_id, sequence, generation)
            );
            INSERT INTO relay_seen (dispatch_id, sequence, generation, message_id, outcome, rule_ids, created_at)
              SELECT dispatch_id, sequence, 0, message_id, outcome, rule_ids, created_at
              FROM relay_seen_pre_generation;
            DROP TABLE relay_seen_pre_generation;
            CREATE TRIGGER trg_relay_seen_no_update
            BEFORE UPDATE ON relay_seen
            BEGIN
              SELECT RAISE(ABORT, 'relay_seen is append-only');
            END;
            CREATE TRIGGER trg_relay_seen_no_delete
            BEFORE DELETE ON relay_seen
            BEGIN
              SELECT RAISE(ABORT, 'relay_seen is append-only');
            END;
          `)
        }
      }
      // v36 -> v37 (S10-15 D5 + ruling 2): remote_agents gains link_kind + peer_fingerprint.
      // hasColumn-guarded so a fresh createTables() run (already has both inline, above) is a
      // no-op here — same "version bump and schema land in the same atomic migration" discipline
      // as the v36 block just above.
      if (current < 37) {
        if (!this.hasColumn('remote_agents', 'link_kind')) {
          // Ruling 31(c): the ALTER's DEFAULT back-fills every existing row silently — log the
          // count once, at migration time, before the column exists to filter by.
          const remoteAgentCount = (
            this.db.prepare('SELECT COUNT(*) AS n FROM remote_agents').get() as { n: number }
          ).n
          this.db.exec(
            `ALTER TABLE remote_agents ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'paired_device'`
          )
          if (remoteAgentCount > 0) {
            console.warn('[orchestration] remote_agents link_kind back-filled', {
              count: remoteAgentCount
            })
          }
        }
        if (!this.hasColumn('remote_agents', 'peer_fingerprint')) {
          this.db.exec(`ALTER TABLE remote_agents ADD COLUMN peer_fingerprint TEXT`)
        }
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS idx_remote_agents_peer ON remote_agents(remote_agent_id);`
        )
      }
      // v37 -> v38 (S10-15, chair ruling 7): messages gains cross-host provenance columns; no
      // peer_fingerprint (R9 cut). hasColumn-guarded so a fresh createTables() run (already has
      // these inline, above) is a no-op here.
      if (current < 38) {
        for (const column of [
          'peer_link_device_id',
          'peer_agent_id',
          'peer_thread_id',
          'peer_relayed_at'
        ]) {
          if (!this.hasColumn('messages', column)) {
            this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`)
          }
        }
        // S10-15 verifier F3: per-ask expiry (Ruling 5's own bound, not the coarse
        // max-clamp+grace sweep) — question_threads predates this column (minted only inside
        // migrate()'s current<9 block, never in createTables()), so this is a genuine ALTER, not
        // a fresh-DB no-op.
        if (!this.hasColumn('question_threads', 'expires_at')) {
          this.db.exec(`ALTER TABLE question_threads ADD COLUMN expires_at TEXT`)
        }
        // F7a data repair: a pre-S10-15 send/reply to a display-name-shaped recipient with no
        // directory hit fell through to the bare-handle path (isBarePeerHandle,
        // stale-handle-resolution.ts) and stored the raw name in to_handle instead of
        // `agent:<id>` — stranding it once that agent registers. Re-point ONLY the exact shape:
        // an unread, pane-unresolved row whose to_handle equals a currently-registered agent's
        // display_name exactly (never a substring/LIKE match, and never a row already delivered
        // to a pane or already read, which a live bare-handle send/reply legitimately produces).
        this.repointStrandedDisplayNameAddressedMessages()
      }
      // v38 -> v39 (S10-19, chair rulings 20/22/24): peer-owned-pane close/prune bookkeeping
      // columns on remote_dispatch_attachments, the 'agent_exited' state (its own CHECK rebuild
      // — SQLite can't ALTER a CHECK), and the (empty, reader-gated) peer_run_grants table.
      // hasColumn-guarded so a fresh createTables() run (already has these inline, above) is a
      // no-op here — same discipline as every migration block above.
      if (current < 39) {
        for (const column of [
          'blocked_reason',
          'blocked_at',
          'blocked_consumed_at',
          'handle_bound_at',
          'agent_exited_at'
        ]) {
          if (!this.hasColumn('remote_dispatch_attachments', column)) {
            this.db.exec(`ALTER TABLE remote_dispatch_attachments ADD COLUMN ${column} TEXT`)
          }
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_rda_terminal_handle
            ON remote_dispatch_attachments(terminal_handle);
          CREATE TABLE IF NOT EXISTS peer_run_grants (
            run_id                  TEXT NOT NULL,
            peer_link_device_id     TEXT NOT NULL,
            granted_at              TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (run_id, peer_link_device_id)
          );
          -- Ruling 31(b): install-day retention floor, so every pre-existing settled row gets a
          -- full retention window counted from THIS upgrade rather than its own (long-past)
          -- updated_at. F7: this INSERT OR IGNORE is a guaranteed no-op in practice — createTables()
          -- runs before migrate() on every open and already stamps the floor first (see the
          -- CREATE TABLE comment above); kept for defense-in-depth against a future ordering change.
          CREATE TABLE IF NOT EXISTS peer_attachment_retention_floor (
            id       INTEGER PRIMARY KEY CHECK(id = 1),
            floor_at TEXT NOT NULL
          );
          INSERT OR IGNORE INTO peer_attachment_retention_floor (id, floor_at) VALUES (1, datetime('now'));
        `)
        if (!this.remoteDispatchAttachmentsCheckAllowsAgentExited()) {
          this.db.exec(`
            CREATE TABLE remote_dispatch_attachments_new (
              dispatch_id             TEXT PRIMARY KEY,
              task_id                 TEXT NOT NULL,
              home_peer_fingerprint   TEXT NOT NULL,
              protocol_version        INTEGER NOT NULL DEFAULT 1,
              runtime_epoch           TEXT NOT NULL,
              capability_hash         TEXT,
              pane_key                TEXT,
              process_incarnation     TEXT,
              state                   TEXT NOT NULL DEFAULT 'starting'
                CHECK(state IN (
                  'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
                  'stopping', 'stop_unknown', 'stopped', 'abandoned', 'agent_exited'
                )),
              stage                   TEXT NOT NULL DEFAULT 'accepted',
              worktree_id             TEXT,
              terminal_handle         TEXT,
              setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
              effects                 TEXT NOT NULL DEFAULT '[]',
              residual_resources      TEXT NOT NULL DEFAULT '[]',
              to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
              last_error              TEXT,
              blocked_reason          TEXT,
              blocked_at              TEXT,
              blocked_consumed_at     TEXT,
              handle_bound_at         TEXT,
              agent_exited_at         TEXT,
              created_at              TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO remote_dispatch_attachments_new (
              dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch,
              capability_hash, pane_key, process_incarnation, state, stage, worktree_id,
              terminal_handle, setup_state, effects, residual_resources,
              to_worker_imported_sequence, last_error, blocked_reason, blocked_at,
              blocked_consumed_at, handle_bound_at, agent_exited_at, created_at, updated_at
            )
            SELECT
              dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch,
              capability_hash, pane_key, process_incarnation, state, stage, worktree_id,
              terminal_handle, setup_state, effects, residual_resources,
              to_worker_imported_sequence, last_error, blocked_reason, blocked_at,
              blocked_consumed_at, handle_bound_at, agent_exited_at, created_at, updated_at
            FROM remote_dispatch_attachments;
            DROP TABLE remote_dispatch_attachments;
            ALTER TABLE remote_dispatch_attachments_new RENAME TO remote_dispatch_attachments;

            CREATE INDEX IF NOT EXISTS idx_rda_terminal_handle
              ON remote_dispatch_attachments(terminal_handle);
          `)
        }
      }
      // v39 -> v40 (S10-16 rulings 8/10/11/14/17/18g): peer_link_bindings + peer_link_attempts +
      // peer_link_scan_facts + peer_link_confirm_observations + peer_link_containment +
      // peer_reply_outbox. Tables only, no ALTER — createTables() already ran this exact
      // CREATE TABLE IF NOT EXISTS text, so this is a no-op on a fresh DB and creates the tables
      // on an upgraded one. Same "version bump and schema land in one atomic migration"
      // discipline as v37/v38/v39.
      if (current < 40) {
        this.db.exec(S10_16_LINK_BINDING_SCHEMA_SQL)
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_pane_leaf
          ON dispatch_contexts(${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL})
          WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');
      `)
      this.createUndeliveredInboxIndexIfPossible()

      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private migrateLegacyContractStorage(): void {
    if (!this.hasColumn('dispatch_contexts', 'contract_version')) {
      this.db.exec(
        `ALTER TABLE dispatch_contexts
         ADD COLUMN contract_version INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION}`
      )
    }
    if (!this.hasColumn('dispatch_contexts', 'launch_token_hash')) {
      this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN launch_token_hash TEXT')
    }
    if (!this.hasColumn('messages', 'delivery_contract')) {
      this.db.exec(
        `ALTER TABLE messages
         ADD COLUMN delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
         CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only'))`
      )
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_delivery_contract
        ON messages(run_id, delivery_contract, to_handle, read, sequence);

      CREATE TABLE IF NOT EXISTS legacy_adoptions (
        source_run_id        TEXT PRIMARY KEY,
        adopted_run_id       TEXT UNIQUE NOT NULL,
        scheduler_state_lost INTEGER NOT NULL,
        adopted_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS legacy_compatibility_principals (
        id                  TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL,
        dispatch_id         TEXT,
        role                TEXT NOT NULL CHECK(role IN ('worker', 'coordinator')),
        host_scope          TEXT NOT NULL,
        terminal_handle     TEXT NOT NULL,
        pane_key            TEXT NOT NULL,
        launch_token_hash   TEXT NOT NULL,
        process_incarnation TEXT,
        status              TEXT NOT NULL
          CHECK(status IN ('committed', 'settled', 'revoked')),
        CHECK(
          (role = 'worker' AND dispatch_id IS NOT NULL) OR
          (role = 'coordinator' AND dispatch_id IS NULL)
        ),
        UNIQUE(role, run_id, dispatch_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_principal_coordinator
        ON legacy_compatibility_principals(run_id)
        WHERE role = 'coordinator';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_principal_dispatch
        ON legacy_compatibility_principals(dispatch_id)
        WHERE role = 'worker';

      CREATE TABLE IF NOT EXISTS legacy_operation_receipts (
        principal_id   TEXT NOT NULL,
        operation_key  TEXT NOT NULL,
        method         TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        effect_id      TEXT NOT NULL,
        response_json  TEXT NOT NULL,
        completed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(principal_id, operation_key)
      );

      CREATE TABLE IF NOT EXISTS legacy_mail_receipts (
        principal_id    TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY(principal_id, message_id)
      );
    `)

    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET contract_version = ?
         WHERE run_id = ? AND capability_hash IS NULL`
      )
      .run(LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID)
    this.classifyLegacyMessageContracts(LEGACY_RUN_ID, false)
    this.ensureLegacySchedulerLossColumn()
    this.adoptLegacyRunIfNeeded()
  }

  private classifyLegacyMessageContracts(runId: string, adoptedOnly: boolean): void {
    const contractFilter = adoptedOnly
      ? " AND delivery_contract IN ('legacy_direct', 'audit_only')"
      : ''
    this.db
      .prepare(
        `UPDATE messages SET delivery_contract = 'legacy_direct'
         WHERE run_id = ?${contractFilter}`
      )
      .run(runId)
    const rows = this.db
      .prepare(`SELECT id, payload FROM messages WHERE run_id = ?${contractFilter}`)
      .all(runId) as { id: string; payload: string | null }[]
    const markAuditOnly = this.db.prepare(
      "UPDATE messages SET delivery_contract = 'audit_only' WHERE id = ? AND run_id = ?"
    )
    for (const row of rows) {
      if (hasLifecycleRejectionMarker(row.payload)) {
        markAuditOnly.run(row.id, runId)
      }
    }
  }

  private migrateLegacySchedulerLossProvenance(): void {
    this.ensureLegacySchedulerLossColumn()
    this.adoptLegacyRunIfNeeded()
    const adoption = this.getLegacyAdoption()
    if (adoption) {
      this.classifyLegacyMessageContracts(adoption.adopted_run_id, true)
    }
  }

  private ensureLegacySchedulerLossColumn(): void {
    if (!this.hasColumn('coordinator_runs', 'scheduler_lost_at')) {
      this.db.exec('ALTER TABLE coordinator_runs ADD COLUMN scheduler_lost_at TEXT')
    }
  }

  private backfillLegacyQuestionThreads(): void {
    const messages = this.db
      .prepare(
        `SELECT id, run_id, from_handle, to_handle, payload, created_at, sequence
         FROM messages
         WHERE type = 'decision_gate'
           AND delivery_contract IN ('legacy_direct', 'current_delivery')
         ORDER BY sequence`
      )
      .all() as {
      id: string
      run_id: string
      from_handle: string
      to_handle: string
      payload: string | null
      created_at: string
      sequence: number
    }[]
    const getDispatch = this.db.prepare(
      'SELECT id, run_id, task_id FROM dispatch_contexts WHERE id = ? AND contract_version = ?'
    )
    const getDispatchesForLegacyQuestion = this.db.prepare(
      `SELECT id, run_id, task_id
       FROM dispatch_contexts
       WHERE contract_version = ? AND assignee_handle = ?
         AND (? IS NULL OR task_id = ?)
         AND created_at <= ?
         AND (completed_at IS NULL OR completed_at >= ?)
       ORDER BY rowid
       LIMIT 2`
    )
    const getAnswer = this.db.prepare(
      `SELECT id, body, created_at
       FROM messages
       WHERE run_id = ?
         AND thread_id = ?
         AND delivery_contract IN ('legacy_direct', 'current_delivery')
         AND from_handle = ?
         AND to_handle IN (?, ?)
         AND sequence > ?
       ORDER BY sequence
       LIMIT 1`
    )
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO question_threads (
         message_id, run_id, dispatch_id, asker_handle, status,
         answer_message_id, answer_body, created_at, answered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const message of messages) {
      let payload: { taskId?: unknown; dispatchId?: unknown }
      try {
        payload = JSON.parse(message.payload ?? '{}') as {
          taskId?: unknown
          dispatchId?: unknown
        }
      } catch {
        continue
      }
      const inferredDispatches =
        typeof payload.dispatchId === 'string'
          ? []
          : (getDispatchesForLegacyQuestion.all(
              LEGACY_CONTRACT_VERSION,
              message.from_handle,
              typeof payload.taskId === 'string' ? payload.taskId : null,
              typeof payload.taskId === 'string' ? payload.taskId : null,
              message.created_at,
              message.created_at
            ) as { id: string; run_id: string; task_id: string }[])
      const dispatch =
        typeof payload.dispatchId === 'string'
          ? (getDispatch.get(payload.dispatchId, LEGACY_CONTRACT_VERSION) as
              | { id: string; run_id: string; task_id: string }
              | undefined)
          : inferredDispatches.length === 1
            ? inferredDispatches[0]
            : undefined
      if (
        !dispatch ||
        (typeof payload.taskId === 'string' && payload.taskId !== dispatch.task_id) ||
        (message.run_id !== LEGACY_RUN_ID && message.run_id !== dispatch.run_id)
      ) {
        continue
      }
      const answer = getAnswer.get(
        message.run_id,
        message.id,
        message.to_handle,
        message.from_handle,
        `dispatch:${dispatch.id}`,
        message.sequence
      ) as { id: string; body: string; created_at: string } | undefined
      insert.run(
        message.id,
        dispatch.run_id,
        dispatch.id,
        message.from_handle,
        answer ? 'answered' : 'pending',
        answer?.id ?? null,
        answer?.body ?? null,
        message.created_at,
        answer?.created_at ?? null
      )
    }
    const adoption = this.getLegacyAdoption()
    const coordinator = adoption
      ? this.getLegacyCoordinatorPrincipal(adoption.adopted_run_id)
      : undefined
    if (adoption && coordinator?.status === 'revoked') {
      this.promoteLegacyCoordinatorMailForTakeover(
        adoption.adopted_run_id,
        coordinator.terminal_handle
      )
    }
  }

  private adoptLegacyRunIfNeeded(): void {
    const existing = this.db
      .prepare('SELECT * FROM legacy_adoptions WHERE source_run_id = ?')
      .get(LEGACY_RUN_ID) as LegacyAdoptionRow | undefined
    const hasGraph = this.db
      .prepare(
        `SELECT 1
         WHERE EXISTS(SELECT 1 FROM tasks WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM dispatch_contexts WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM decision_gates WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM messages WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM question_threads WHERE run_id = ?)
            OR EXISTS(SELECT 1 FROM deliveries WHERE run_id = ?)`
      )
      .get(LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID)
    if (!existing && !hasGraph) {
      return
    }

    const adoptedRunId = existing?.adopted_run_id ?? generateId('run')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (
           id, objective, home_database, consumer_generation, legacy
         ) VALUES (?, ?, 'this_database', 0, 0)`
      )
      .run(adoptedRunId, 'Recovered orchestration work from a contract update')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO legacy_adoptions (
           source_run_id, adopted_run_id, scheduler_state_lost
         ) VALUES (?, ?, 1)`
      )
      .run(LEGACY_RUN_ID, adoptedRunId)
    this.db
      .prepare(
        `UPDATE coordinator_runs
         SET status = 'failed',
             completed_at = COALESCE(
               completed_at,
               (SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?)
             ),
             scheduler_lost_at = (
               SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?
             )
         WHERE status = 'running'
           AND julianday(created_at) <= julianday((
             SELECT adopted_at FROM legacy_adoptions WHERE source_run_id = ?
           ))`
      )
      .run(LEGACY_RUN_ID, LEGACY_RUN_ID, LEGACY_RUN_ID)

    this.db
      .prepare(
        `UPDATE deliveries SET status = 'fenced'
         WHERE run_id = ? AND status = 'outstanding'`
      )
      .run(LEGACY_RUN_ID)
    for (const table of [
      'tasks',
      'dispatch_contexts',
      'decision_gates',
      'messages',
      'question_threads',
      'deliveries'
    ]) {
      this.db
        .prepare(`UPDATE ${table} SET run_id = ? WHERE run_id = ?`)
        .run(adoptedRunId, LEGACY_RUN_ID)
    }
    this.db
      .prepare(
        `UPDATE runs
         SET objective = 'Legacy orchestration state (adopted; inspect only)',
             coordinator_handle = NULL, coordinator_pane_key = NULL,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(LEGACY_RUN_ID)

    const mismatch = this.db
      .prepare(
        `WITH migration_runs(run_id) AS (VALUES (?), (?))
         SELECT 1
         WHERE EXISTS(
           SELECT 1 FROM dispatch_contexts d
           INNER JOIN tasks t ON t.id = d.task_id
           WHERE d.run_id <> t.run_id
             AND (
               d.run_id IN (SELECT run_id FROM migration_runs)
               OR t.run_id IN (SELECT run_id FROM migration_runs)
             )
         )
            OR EXISTS(
              SELECT 1 FROM decision_gates g
              INNER JOIN tasks t ON t.id = g.task_id
              WHERE g.run_id <> t.run_id
                AND (
                  g.run_id IN (SELECT run_id FROM migration_runs)
                  OR t.run_id IN (SELECT run_id FROM migration_runs)
                )
            )
            OR EXISTS(
              SELECT 1 FROM question_threads q
              INNER JOIN dispatch_contexts d ON d.id = q.dispatch_id
              WHERE q.run_id <> d.run_id
                AND (
                  q.run_id IN (SELECT run_id FROM migration_runs)
                  OR d.run_id IN (SELECT run_id FROM migration_runs)
                )
            )
            OR EXISTS(
              SELECT 1 FROM deliveries d
              INNER JOIN json_each(d.message_ids) ids
              INNER JOIN messages m ON m.id = ids.value
              WHERE d.run_id <> m.run_id
                AND (
                  d.run_id IN (SELECT run_id FROM migration_runs)
                  OR m.run_id IN (SELECT run_id FROM migration_runs)
                )
            )`
      )
      .get(LEGACY_RUN_ID, adoptedRunId)
    if (mismatch) {
      throw new Error('Legacy orchestration adoption produced inconsistent Run ownership.')
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.pragma(`table_info(${table})`) as { name: string }[]
    return rows.some((r) => r.name === column)
  }

  private createUndeliveredInboxIndexIfPossible(): void {
    if (!this.hasColumn('messages', 'delivered_at')) {
      return
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_undelivered_inbox
        ON messages(to_handle, read, delivered_at, sequence)
    `)
  }

  // Why guarded (not baked into createTables()'s messages CREATE TABLE index list): an existing
  // pre-v34 DB's `messages` table lacks `purged_at`/`thread_sequence` until migrate()'s
  // `current < 34` ALTERs run, and createTables() executes BEFORE migrate() on every open —
  // an unconditional CREATE INDEX/TRIGGER referencing those columns would throw "no such
  // column" the moment an EARLIER migrate() version block (e.g. `current < 19`) touches
  // `messages` and fires the trigger before the column exists. Same precedent as
  // createUndeliveredInboxIndexIfPossible above.
  private createThreadDirectoryIndexesIfPossible(): void {
    if (!this.hasColumn('messages', 'purged_at')) {
      return
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_live ON messages(to_handle, read) WHERE purged_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_thread_live ON messages(thread_id, sequence) WHERE purged_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_sequence
        ON messages(thread_id, thread_sequence) WHERE thread_sequence IS NOT NULL;
    `)
    this.db.exec(MESSAGES_PURGE_TRIGGER_SQL)
  }

  // Guarded per the PACT_PAIR_LIVE_SQL comment: idx_pact_pair_live/trg_pact_turn_membership
  // reference threads.pact_proposer_agent_id, absent on a pre-v35 DB until migrate()'s
  // `current < 35` ALTERs land. Called from createTables() (no-ops pre-migration) and again at
  // the end of that migration block (unguarded by then).
  private createPactSchemaIndexesIfPossible(): void {
    if (!this.hasColumn('threads', 'pact_proposer_agent_id')) {
      return
    }
    this.db.exec(PACT_PAIR_LIVE_SQL)
  }

  // Why: sqlite_master holds the table's CREATE SQL incl. the CHECK — cheapest reliable probe for whether it already allows 'heartbeat'.
  private messagesTypeCheckAllowsHeartbeat(): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string } | undefined
    return !!row && row.sql.includes("'heartbeat'")
  }

  // Why: sqlite_master holds the table's CREATE SQL incl. the CHECK — cheapest reliable probe for whether it already allows 'agent_exited'.
  private remoteDispatchAttachmentsCheckAllowsAgentExited(): boolean {
    const row = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'remote_dispatch_attachments'"
      )
      .get() as { sql: string } | undefined
    return !!row && row.sql.includes("'agent_exited'")
  }

  private messagesTypeCheckAllowsQuestion(): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string } | undefined
    return !!row && row.sql.includes("'question'")
  }

  // ── Durable mutation receipts ──

  beginMutationReceipt(params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }):
    | { disposition: 'started'; row: MutationReceiptRow }
    | { disposition: 'pending'; row: MutationReceiptRow }
    | { disposition: 'completed'; row: MutationReceiptRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.getMutationReceipt(params.callerFingerprint, params.requestId)
      if (existing) {
        if (existing.method !== params.method || existing.payload_hash !== params.payloadHash) {
          throw new OrchestrationError(
            'request_mismatch',
            `Mutation request ${params.requestId} was already used with different input.`
          )
        }
        this.db.exec('COMMIT')
        return { disposition: existing.state, row: existing }
      }
      ensureMutationReceiptCapacity(this.db)
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state
           ) VALUES (?, ?, ?, ?, 'pending')`
        )
        .run(params.callerFingerprint, params.requestId, params.method, params.payloadHash)
      const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
      this.db.exec('COMMIT')
      return { disposition: 'started', row: row as MutationReceiptRow }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completeMutationReceipt(params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
    receipt: string
  }): MutationReceiptRow {
    const result = this.db
      .prepare(
        `UPDATE mutation_receipts
         SET state = 'completed', receipt = ?, updated_at = datetime('now')
         WHERE caller_fingerprint = ? AND request_id = ? AND method = ?
           AND payload_hash = ?`
      )
      .run(
        params.receipt,
        params.callerFingerprint,
        params.requestId,
        params.method,
        params.payloadHash
      )
    const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
    if (result.changes !== 1 || !row) {
      throw new OrchestrationError(
        'request_mismatch',
        `Mutation request ${params.requestId} no longer matches its pending operation.`
      )
    }
    return row
  }

  discardPendingMutationReceipt(callerFingerprint: string, requestId: string): void {
    this.db
      .prepare(
        `DELETE FROM mutation_receipts
         WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
      )
      .run(callerFingerprint, requestId)
  }

  getMutationReceipt(callerFingerprint: string, requestId: string): MutationReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM mutation_receipts
         WHERE caller_fingerprint = ? AND request_id = ?`
      )
      .get(callerFingerprint, requestId) as MutationReceiptRow | undefined
  }

  // ── Legacy adoption and compatibility principals ──

  getLegacyAdoption(): LegacyAdoptionRow | undefined {
    return this.db
      .prepare('SELECT * FROM legacy_adoptions WHERE source_run_id = ?')
      .get(LEGACY_RUN_ID) as LegacyAdoptionRow | undefined
  }

  commitLegacyCompatibilityPrincipal(params: {
    runId: string
    dispatchId?: string
    role: LegacyPrincipalRole
    hostScope: string
    terminalHandle: string
    paneKey: string
    launchTokenHash: string
    processIncarnation?: string
  }): { principal: LegacyCompatibilityPrincipalRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const adoption = this.getLegacyAdoption()
      if (!adoption || adoption.adopted_run_id !== params.runId) {
        throw new OrchestrationError(
          'request_mismatch',
          `Run ${params.runId} is not the adopted legacy Run.`
        )
      }
      const dispatchId = params.role === 'worker' ? (params.dispatchId ?? null) : null
      let initialStatus: 'committed' | 'settled' = 'committed'
      if (params.role === 'worker') {
        const dispatch = dispatchId ? this.getDispatchContextById(dispatchId) : undefined
        if (
          !dispatch ||
          dispatch.run_id !== params.runId ||
          dispatch.contract_version !== LEGACY_CONTRACT_VERSION
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Dispatch ${dispatchId ?? '(missing)'} is not a legacy attempt in this Run.`
          )
        }
        initialStatus = ['pending', 'dispatched'].includes(dispatch.status)
          ? 'committed'
          : 'settled'
      } else if (params.dispatchId) {
        throw new OrchestrationError(
          'request_mismatch',
          'A coordinator compatibility principal cannot name a Dispatch.'
        )
      }

      const existing = this.db
        .prepare(
          `SELECT * FROM legacy_compatibility_principals
           WHERE role = ? AND run_id = ? AND dispatch_id IS ?`
        )
        .get(params.role, params.runId, dispatchId) as LegacyCompatibilityPrincipalRow | undefined
      if (existing) {
        const same =
          existing.host_scope === params.hostScope &&
          existing.terminal_handle === params.terminalHandle &&
          existing.pane_key === params.paneKey &&
          existing.launch_token_hash === params.launchTokenHash &&
          existing.process_incarnation === (params.processIncarnation ?? null)
        if (!same) {
          throw new OrchestrationError(
            'request_mismatch',
            `The ${params.role} compatibility principal is already committed to different proof.`
          )
        }
        if (existing.status === 'revoked') {
          throw new OrchestrationError(
            'legacy_read_only',
            `The ${params.role} compatibility principal has been revoked. No effects were applied.`,
            { effectsApplied: false }
          )
        }
        this.db.exec('COMMIT')
        return { principal: existing, duplicate: true }
      }
      if (
        params.role === 'coordinator' &&
        !this.resolveLegacyCoordinatorCandidate({
          runId: params.runId,
          terminalHandle: params.terminalHandle,
          paneKey: params.paneKey
        })
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'This retained legacy coordinator no longer has lifecycle authority. No effects were applied.',
          { effectsApplied: false }
        )
      }

      const id = generateId('legacy_principal')
      this.db
        .prepare(
          `INSERT INTO legacy_compatibility_principals (
             id, run_id, dispatch_id, role, host_scope, terminal_handle,
             pane_key, launch_token_hash, process_incarnation, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.runId,
          dispatchId,
          params.role,
          params.hostScope,
          params.terminalHandle,
          params.paneKey,
          params.launchTokenHash,
          params.processIncarnation ?? null,
          initialStatus
        )
      const principal = this.getLegacyCompatibilityPrincipal(id) as LegacyCompatibilityPrincipalRow
      if (principal.status === 'committed') {
        this.initializeLegacyRecoveryCohort(principal)
      }
      this.db.exec('COMMIT')
      return { principal, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getLegacyCompatibilityPrincipal(id: string): LegacyCompatibilityPrincipalRow | undefined {
    return this.db.prepare('SELECT * FROM legacy_compatibility_principals WHERE id = ?').get(id) as
      | LegacyCompatibilityPrincipalRow
      | undefined
  }

  listLegacyCompatibilityPrincipals(runId: string): LegacyCompatibilityPrincipalRow[] {
    return this.db
      .prepare(
        `SELECT * FROM legacy_compatibility_principals
         WHERE run_id = ? ORDER BY rowid`
      )
      .all(runId) as LegacyCompatibilityPrincipalRow[]
  }

  getLegacyCoordinatorPrincipal(runId: string): LegacyCompatibilityPrincipalRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM legacy_compatibility_principals
         WHERE run_id = ? AND role = 'coordinator'`
      )
      .get(runId) as LegacyCompatibilityPrincipalRow | undefined
  }

  resolveLegacyCompatibilityPrincipalByIdentity(params: {
    runId: string
    role: LegacyPrincipalRole
    terminalHandle?: string
    paneKey?: string
  }): LegacyCompatibilityPrincipalRow | undefined {
    if (!params.terminalHandle && !params.paneKey) {
      return undefined
    }
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM legacy_compatibility_principals
           WHERE run_id = ? AND role = ? AND status IN ('committed', 'settled')
           ORDER BY rowid`
        )
        .all(params.runId, params.role) as LegacyCompatibilityPrincipalRow[]
    ).filter((principal) =>
      params.paneKey
        ? isEquivalentPaneKey(principal.pane_key, params.paneKey)
        : principal.terminal_handle === params.terminalHandle
    )
    if (rows.length > 1) {
      throw new OrchestrationError(
        'operation_unknown',
        'Multiple legacy principals match this process identity.'
      )
    }
    return rows[0]
  }

  resolveLegacyWorkerCandidate(params: {
    runId?: string
    terminalHandle?: string
    paneKey?: string
    dispatchId?: string
    taskId?: string
  }): { dispatch: DispatchContextRow } | undefined {
    if (!params.runId || (!params.terminalHandle && !params.paneKey)) {
      return undefined
    }
    const rows = (
      params.dispatchId
        ? [this.getDispatchContextById(params.dispatchId)].filter(
            (row): row is DispatchContextRow => row !== undefined
          )
        : (this.db
            .prepare(
              `SELECT * FROM dispatch_contexts
               WHERE run_id = ? AND contract_version = ?
                 AND status IN ('pending', 'dispatched')
               ORDER BY rowid`
            )
            .all(params.runId, LEGACY_CONTRACT_VERSION) as DispatchContextRow[])
    ).filter(
      (dispatch) =>
        dispatch.run_id === params.runId &&
        dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
        (!params.taskId || dispatch.task_id === params.taskId) &&
        (params.paneKey
          ? Boolean(
              dispatch.assignee_pane_key &&
              isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
            )
          : dispatch.assignee_handle === params.terminalHandle)
    )
    if (rows.length > 1) {
      throw new OrchestrationError(
        'operation_unknown',
        'Multiple active legacy Dispatches match this process identity.'
      )
    }
    if (params.dispatchId && rows.length === 0) {
      const target = this.getDispatchContextById(params.dispatchId)
      if (target?.contract_version === LEGACY_CONTRACT_VERSION) {
        throw new OrchestrationError(
          'legacy_read_only',
          `Dispatch ${params.dispatchId} is retained but this process cannot prove ownership.`
        )
      }
    }
    return rows[0] ? { dispatch: rows[0] } : undefined
  }

  resolveLegacyCoordinatorCandidate(params: {
    runId: string
    terminalHandle?: string
    paneKey?: string
  }): { terminalHandle: string; paneKey: string } | undefined {
    if (!params.terminalHandle || !params.paneKey) {
      return undefined
    }
    const run = this.getRunRaw(params.runId)
    const principal = this.getLegacyCoordinatorPrincipal(params.runId)
    if (principal) {
      if (
        principal.status !== 'committed' ||
        principal.terminal_handle !== params.terminalHandle ||
        !isEquivalentPaneKey(principal.pane_key, params.paneKey) ||
        (run?.coordinator_pane_key !== null &&
          (run?.coordinator_handle !== principal.terminal_handle ||
            !isEquivalentPaneKey(run.coordinator_pane_key, principal.pane_key)))
      ) {
        return undefined
      }
      return { terminalHandle: params.terminalHandle, paneKey: params.paneKey }
    }
    // Why: the first current binding durably fences uncommitted legacy processes.
    if (
      !run ||
      run.coordinator_pane_key !== null ||
      this.getUniqueLegacyCoordinatorHandle(params.runId) !== params.terminalHandle
    ) {
      return undefined
    }
    return { terminalHandle: params.terminalHandle, paneKey: params.paneKey }
  }

  isLegacyCoordinatorHandle(runId: string, terminalHandle: string): boolean {
    const principal = this.getLegacyCoordinatorPrincipal(runId)
    if (principal) {
      return principal.terminal_handle === terminalHandle
    }
    return this.getUniqueLegacyCoordinatorHandle(runId) === terminalHandle
  }

  findLegacyWorkerCompletion(params: {
    principalId: string
    taskId: string
    recipientHandle: string
    subject: string
    body: string
    payload: string | null
  }): MessageRow | undefined {
    const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
    if (!principal || principal.role !== 'worker' || !principal.dispatch_id) {
      throw new OrchestrationError('request_mismatch', 'Legacy worker principal was not found.')
    }
    const runAddress = `run:${principal.run_id}`
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE run_id = ?
           AND (
             (delivery_contract = 'legacy_direct' AND to_handle = ?) OR
             (delivery_contract = 'current_delivery' AND to_handle = ?)
           )
           AND from_handle = ? AND type = 'worker_done'
           AND subject = ? AND body = ? AND payload IS ?
         ORDER BY sequence`
      )
      .all(
        principal.run_id,
        params.recipientHandle,
        runAddress,
        principal.terminal_handle,
        params.subject,
        params.body,
        params.payload
      ) as MessageRow[]
    const matches = rows.filter((message) => {
      try {
        const payload = JSON.parse(message.payload ?? '{}') as {
          taskId?: unknown
          dispatchId?: unknown
        }
        return payload.taskId === params.taskId && payload.dispatchId === principal.dispatch_id
      } catch {
        return false
      }
    })
    if (matches.length > 1) {
      throw new OrchestrationError(
        'operation_unknown',
        'Multiple matching legacy worker completions exist.'
      )
    }
    return matches[0] ? exposeMessageTimestamps(matches[0]) : undefined
  }

  hasPendingCurrentDelivery(runId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM messages
           WHERE run_id = ? AND to_handle = ?
             AND delivery_contract = 'current_delivery' AND read = 0
           LIMIT 1`
        )
        .get(runId, `run:${runId}`)
    )
  }

  setLegacyCompatibilityPrincipalStatus(
    id: string,
    status: 'settled' | 'revoked'
  ): LegacyCompatibilityPrincipalRow | undefined {
    this.db
      .prepare(
        `UPDATE legacy_compatibility_principals
         SET status = ?
         WHERE id = ? AND status = 'committed'`
      )
      .run(status, id)
    return this.getLegacyCompatibilityPrincipal(id)
  }

  getLegacyOperationReceipt(
    principalId: string,
    operationKey: string
  ): LegacyOperationReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM legacy_operation_receipts
         WHERE principal_id = ? AND operation_key = ?`
      )
      .get(principalId, operationKey) as LegacyOperationReceiptRow | undefined
  }

  private requireCommittedLegacyPrincipal(
    principalId: string,
    role?: LegacyPrincipalRole
  ): LegacyCompatibilityPrincipalRow {
    const principal = this.getLegacyCompatibilityPrincipal(principalId)
    if (!principal || principal.status !== 'committed' || (role && principal.role !== role)) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy compatibility principal ${principalId} is not committed for this operation.`
      )
    }
    return principal
  }

  private requireLegacyMailPrincipal(
    principalId: string,
    role?: LegacyPrincipalRole
  ): LegacyCompatibilityPrincipalRow {
    const principal = this.getLegacyCompatibilityPrincipal(principalId)
    if (
      !principal ||
      !['committed', 'settled'].includes(principal.status) ||
      (role && principal.role !== role)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy compatibility principal ${principalId} cannot access retained mail.`
      )
    }
    return principal
  }

  private initializeLegacyRecoveryCohort(principal: LegacyCompatibilityPrincipalRow): void {
    if (principal.role === 'worker') {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO legacy_mail_receipts (
             principal_id, message_id, acknowledged_at
           )
           SELECT ?, m.id, NULL
           FROM messages m
           INNER JOIN dispatch_contexts d ON d.id = ?
           WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct' AND m.read = 1
             AND d.status IN ('pending', 'dispatched')
             AND m.created_at >= d.created_at
             AND (m.to_handle = ? OR m.to_handle = ?)`
        )
        .run(
          principal.id,
          principal.dispatch_id,
          principal.run_id,
          principal.terminal_handle,
          `dispatch:${principal.dispatch_id}`
        )
      return
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO legacy_mail_receipts (
           principal_id, message_id, acknowledged_at
         )
         SELECT ?, m.id, NULL
         FROM messages m
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct' AND m.read = 1
           AND m.to_handle = ?
           AND EXISTS(
             SELECT 1 FROM dispatch_contexts d
             WHERE d.run_id = m.run_id
               AND d.contract_version = ?
               AND d.status IN ('pending', 'dispatched')
               AND m.created_at >= d.created_at
               AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
           )`
      )
      .run(principal.id, principal.run_id, principal.terminal_handle, LEGACY_CONTRACT_VERSION)
  }

  getLegacyMailPage(params: { principalId: string; limit?: number; types?: MessageType[] }): {
    messages: MessageRow[]
    recovery: boolean
  } {
    const principal = this.requireLegacyMailPrincipal(params.principalId)
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 50)
    const addressSql =
      principal.role === 'worker' ? '(m.to_handle = ? OR m.to_handle = ?)' : 'm.to_handle = ?'
    const addressParams =
      principal.role === 'worker'
        ? [principal.terminal_handle, `dispatch:${principal.dispatch_id}`]
        : [principal.terminal_handle]
    const typeSql =
      params.types && params.types.length > 0
        ? `AND m.type IN (${params.types.map(() => '?').join(',')})`
        : ''
    const typeParams = params.types ?? []
    const recovery = this.db
      .prepare(
        `SELECT m.*
         FROM legacy_mail_receipts r
         INNER JOIN messages m ON m.id = r.message_id
         WHERE r.principal_id = ? AND r.acknowledged_at IS NULL
           AND m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND ${addressSql}
           ${typeSql}
         ORDER BY m.sequence ASC LIMIT ?`
      )
      .all(
        params.principalId,
        principal.run_id,
        ...addressParams,
        ...typeParams,
        limit
      ) as MessageRow[]
    if (recovery.length > 0) {
      return { messages: exposeMessageListTimestamps(recovery), recovery: true }
    }

    const unread = this.db
      .prepare(
        `SELECT m.*
         FROM messages m
         LEFT JOIN legacy_mail_receipts r
           ON r.principal_id = ? AND r.message_id = m.id
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND m.read = 0 AND r.message_id IS NULL AND ${addressSql}
           ${typeSql}
         ORDER BY m.sequence ASC LIMIT ?`
      )
      .all(
        params.principalId,
        principal.run_id,
        ...addressParams,
        ...typeParams,
        limit
      ) as MessageRow[]
    return { messages: exposeMessageListTimestamps(unread), recovery: false }
  }

  getLegacyMailHistory(params: { principalId: string; limit?: number; types?: MessageType[] }): {
    messages: MessageRow[]
    recovery: false
  } {
    const principal = this.requireLegacyMailPrincipal(params.principalId)
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 100)
    const addressSql =
      principal.role === 'worker' ? '(to_handle = ? OR to_handle = ?)' : 'to_handle = ?'
    const addressParams =
      principal.role === 'worker'
        ? [principal.terminal_handle, `dispatch:${principal.dispatch_id}`]
        : [principal.terminal_handle]
    const typeSql =
      params.types && params.types.length > 0
        ? `AND type IN (${params.types.map(() => '?').join(',')})`
        : ''
    const messages = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE run_id = ? AND delivery_contract = 'legacy_direct'
           AND ${addressSql} ${typeSql}
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(principal.run_id, ...addressParams, ...(params.types ?? []), limit) as MessageRow[]
    return { messages: exposeMessageListTimestamps(messages), recovery: false }
  }

  acknowledgeLegacyMail(params: {
    principalId: string
    messageIds: string[]
    types?: MessageType[]
  }): {
    receipts: LegacyMailReceiptRow[]
    duplicate: boolean
  } {
    if (params.messageIds.length === 0) {
      return { receipts: [], duplicate: true }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireLegacyMailPrincipal(params.principalId)
      const uniqueIds = [...new Set(params.messageIds)]
      const placeholders = uniqueIds.map(() => '?').join(',')
      const prior = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id IN (${placeholders})
             AND acknowledged_at IS NOT NULL`
        )
        .get(params.principalId, ...uniqueIds) as { count: number }
      if (prior.count !== uniqueIds.length) {
        const actionable = this.getLegacyMailPage({
          principalId: params.principalId,
          limit: uniqueIds.length,
          types: params.types
        }).messages
        if (
          actionable.length !== uniqueIds.length ||
          actionable.some((message, index) => message.id !== uniqueIds[index])
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            'Legacy mail acknowledgment does not match the current replay page.'
          )
        }
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE id IN (${placeholders}) AND run_id = ?
             AND delivery_contract = 'legacy_direct'`
        )
        .all(...uniqueIds, principal.run_id) as MessageRow[]
      const validIds = new Set(
        rows
          .filter(
            (message) =>
              message.to_handle === principal.terminal_handle ||
              (principal.role === 'worker' &&
                message.to_handle === `dispatch:${principal.dispatch_id}`)
          )
          .map((message) => message.id)
      )
      if (validIds.size !== uniqueIds.length || uniqueIds.some((id) => !validIds.has(id))) {
        throw new OrchestrationError(
          'request_mismatch',
          'Legacy mail acknowledgment contains a message outside this principal inbox.'
        )
      }

      this.db
        .prepare(
          `UPDATE messages
           SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
           WHERE id IN (${placeholders})`
        )
        .run(...uniqueIds)
      const insert = this.db.prepare(
        `INSERT INTO legacy_mail_receipts (
           principal_id, message_id, acknowledged_at
         ) VALUES (?, ?, datetime('now'))
         ON CONFLICT(principal_id, message_id)
         DO UPDATE SET acknowledged_at = COALESCE(
           legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
         )`
      )
      for (const messageId of uniqueIds) {
        insert.run(params.principalId, messageId)
      }
      const receipts = this.db
        .prepare(
          `SELECT * FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id IN (${placeholders})
           ORDER BY message_id`
        )
        .all(params.principalId, ...uniqueIds) as LegacyMailReceiptRow[]
      this.db.exec('COMMIT')
      return { receipts, duplicate: prior.count === uniqueIds.length }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  acknowledgeLegacyQuestionAnswer(params: {
    principalId: string
    questionId: string
    answerMessageId: string
  }): { receipt: LegacyMailReceiptRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireLegacyMailPrincipal(params.principalId, 'worker')
      const question = this.getQuestionRaw(params.questionId)
      const source = this.getMessageById(params.questionId)
      const answer = this.getMessageById(params.answerMessageId)
      const dispatch = principal.dispatch_id
        ? this.getDispatchContextById(principal.dispatch_id)
        : undefined
      const exactLegacyAnswer =
        answer?.delivery_contract === 'legacy_direct' &&
        (answer.to_handle === principal.terminal_handle ||
          answer.to_handle === `dispatch:${principal.dispatch_id}`)
      const adoption = this.getLegacyAdoption()
      const exactTakenOverAnswer =
        adoption?.adopted_run_id === principal.run_id &&
        dispatch?.run_id === principal.run_id &&
        dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
        source?.run_id === principal.run_id &&
        source.from_handle === principal.terminal_handle &&
        source.to_handle === `run:${principal.run_id}` &&
        source.delivery_contract === 'current_delivery' &&
        answer?.run_id === principal.run_id &&
        answer?.delivery_contract === 'current_delivery' &&
        answer.from_handle === `run:${principal.run_id}` &&
        answer.to_handle === `dispatch:${principal.dispatch_id}` &&
        answer.thread_id === question?.message_id
      if (
        !question ||
        !answer ||
        question.run_id !== principal.run_id ||
        question.dispatch_id !== principal.dispatch_id ||
        question.answer_message_id !== params.answerMessageId ||
        (!exactLegacyAnswer && !exactTakenOverAnswer)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          'Legacy answer acknowledgment does not match this principal question.'
        )
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id = ?`
        )
        .get(params.principalId, params.answerMessageId) as LegacyMailReceiptRow | undefined
      this.db
        .prepare(
          `UPDATE messages
           SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
           WHERE id = ?`
        )
        .run(params.answerMessageId)
      this.db
        .prepare(
          `INSERT INTO legacy_mail_receipts (
             principal_id, message_id, acknowledged_at
           ) VALUES (?, ?, datetime('now'))
           ON CONFLICT(principal_id, message_id)
           DO UPDATE SET acknowledged_at = COALESCE(
             legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
           )`
        )
        .run(params.principalId, params.answerMessageId)
      const receipt = this.db
        .prepare(
          `SELECT * FROM legacy_mail_receipts
           WHERE principal_id = ? AND message_id = ?`
        )
        .get(params.principalId, params.answerMessageId) as LegacyMailReceiptRow
      this.db.exec('COMMIT')
      return { receipt, duplicate: Boolean(existing?.acknowledged_at) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── Runs ──

  createRun(params: {
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
  }): RunRow {
    const id = generateId('run')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.unbindOtherRunsForPane(params.coordinatorPaneKey)
      this.db
        .prepare(
          `INSERT INTO runs (
             id, objective, coordinator_handle, coordinator_pane_key,
             consumer_generation, legacy
           ) VALUES (?, ?, ?, ?, 1, 0)`
        )
        .run(id, params.objective, params.coordinatorHandle, params.coordinatorPaneKey)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getRun(id) as RunRow
  }

  bindRun(params: {
    runId: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    takeoverLegacy?: boolean
    legacyCoordinatorAuthority?: {
      runId: string
      principalId: string | null
      terminalHandle: string
      paneKey: string
      consumerGeneration: number
    }
  }): RunRow | undefined {
    if (params.runId === PEER_RUN_ID) {
      throw new OrchestrationError(
        'invalid_argument',
        `${PEER_RUN_ID} is a sentinel mailbox for peer agent mail (S10), not a coordinator Run.`
      )
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.getRunRaw(params.runId)
      if (!run || run.legacy === 1) {
        this.db.exec('ROLLBACK')
        return undefined
      }
      const sameBinding =
        run.coordinator_pane_key !== null &&
        isEquivalentPaneKey(run.coordinator_pane_key, params.coordinatorPaneKey)
      const adoption = this.getLegacyAdoption()
      const adoptedRun = adoption?.adopted_run_id === params.runId
      const legacyAuthority = params.legacyCoordinatorAuthority
      const legacyPrincipalId = legacyAuthority?.principalId
      const legacyPrincipal = legacyPrincipalId
        ? this.getLegacyCompatibilityPrincipal(legacyPrincipalId)
        : undefined
      const provenLegacyBinding = Boolean(
        adoptedRun &&
        legacyAuthority &&
        legacyAuthority.principalId !== null &&
        legacyAuthority.runId === params.runId &&
        legacyAuthority.consumerGeneration === run.consumer_generation &&
        legacyPrincipal?.run_id === params.runId &&
        legacyPrincipal.role === 'coordinator' &&
        legacyPrincipal.status === 'committed' &&
        legacyPrincipal.terminal_handle === legacyAuthority.terminalHandle &&
        isEquivalentPaneKey(legacyPrincipal.pane_key, legacyAuthority.paneKey) &&
        params.coordinatorHandle === legacyAuthority.terminalHandle &&
        isEquivalentPaneKey(params.coordinatorPaneKey, legacyAuthority.paneKey)
      )
      if (legacyAuthority && !provenLegacyBinding) {
        throw new OrchestrationError(
          'legacy_read_only',
          'This retained legacy coordinator no longer has lifecycle authority. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const activeLegacyAssignment =
        adoptedRun &&
        Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM dispatch_contexts
               WHERE run_id = ? AND contract_version = ?
                 AND status IN ('pending', 'dispatched')
               LIMIT 1`
            )
            .get(params.runId, LEGACY_CONTRACT_VERSION)
        )
      const coordinatorPrincipal = adoptedRun
        ? this.getLegacyCoordinatorPrincipal(params.runId)
        : undefined
      const retainedCoordinatorHandle =
        coordinatorPrincipal?.terminal_handle ??
        run.coordinator_handle ??
        this.getUniqueLegacyCoordinatorHandle(params.runId)
      const takeoverAlreadyApplied = Boolean(
        params.takeoverLegacy &&
        sameBinding &&
        run.coordinator_handle === params.coordinatorHandle &&
        coordinatorPrincipal?.status !== 'committed'
      )
      const replacesLegacyCoordinator = Boolean(
        adoptedRun &&
        !provenLegacyBinding &&
        retainedCoordinatorHandle &&
        (params.takeoverLegacy ||
          retainedCoordinatorHandle !== params.coordinatorHandle ||
          !sameBinding)
      )
      if (params.takeoverLegacy && !adoptedRun) {
        throw new OrchestrationError(
          'invalid_argument',
          'Legacy takeover is only available for the automatically adopted Run.'
        )
      }
      // Why: only LIVE legacy work needs the flag — settled work has no competing authority left, and
      // fencing it would strand the recovered graph behind an attestation the caller may not have.
      if (
        activeLegacyAssignment &&
        !sameBinding &&
        !provenLegacyBinding &&
        !params.takeoverLegacy
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This adopted Run still has live legacy work. Its attested coordinator may rebind it, or a current coordinator may explicitly use run-use --takeover-legacy.',
          {
            effectsApplied: false,
            recoveryCommand: `orca orchestration run-use --id ${params.runId} --takeover-legacy`
          }
        )
      }
      this.unbindOtherRunsForPane(params.coordinatorPaneKey, params.runId)
      if (
        (params.takeoverLegacy && !takeoverAlreadyApplied) ||
        !sameBinding ||
        run.coordinator_handle !== params.coordinatorHandle
      ) {
        if (adoptedRun && (params.takeoverLegacy || !activeLegacyAssignment)) {
          if (
            coordinatorPrincipal?.status === 'committed' &&
            (params.takeoverLegacy ||
              coordinatorPrincipal.terminal_handle !== params.coordinatorHandle ||
              !isEquivalentPaneKey(coordinatorPrincipal.pane_key, params.coordinatorPaneKey))
          ) {
            this.setLegacyCompatibilityPrincipalStatus(coordinatorPrincipal.id, 'revoked')
          }
        }
        this.db
          .prepare(
            `UPDATE runs
             SET coordinator_handle = ?, coordinator_pane_key = ?,
                 consumer_generation = consumer_generation + 1,
                 updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(params.coordinatorHandle, params.coordinatorPaneKey, params.runId)
        this.fenceOutstandingDelivery(params.runId)
        if (params.takeoverLegacy || replacesLegacyCoordinator) {
          this.promoteLegacyCoordinatorMailForTakeover(params.runId, retainedCoordinatorHandle)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getRun(params.runId)
  }

  getRun(id: string): RunRow | undefined {
    const run = this.getRunRaw(id)
    return run ? exposeRunTimestamps(run) : undefined
  }

  listRuns(params: { limit?: number; cursor?: string } = {}): RunListPage {
    if (params.limit === undefined && params.cursor === undefined) {
      const rows = this.db
        .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC')
        .all() as RunRow[]
      return { runs: rows.map(exposeRunTimestamps), nextCursor: null }
    }
    const limit = Math.min(
      Math.max(1, params.limit ?? ORCHESTRATION_RUN_PAGE_LIMIT),
      ORCHESTRATION_RUN_PAGE_LIMIT
    )
    const cursor = params.cursor ? decodeRunListCursor(params.cursor) : undefined
    const rows = (
      cursor
        ? this.db
            .prepare(
              `SELECT * FROM runs
             WHERE created_at < ? OR (created_at = ? AND id < ?)
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
            )
            .all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
        : this.db
            .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(limit + 1)
    ) as RunRow[]
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    return {
      runs: pageRows.map(exposeRunTimestamps),
      nextCursor: hasMore ? encodeRunListCursor(pageRows.at(-1) as RunRow) : null
    }
  }

  getCurrentRunForPane(paneKey: string): RunRow | undefined {
    const run = this.runsBoundToPane(paneKey)[0]
    return run ? exposeRunTimestamps(run) : undefined
  }

  // Why: the indexed suffix only narrows candidates; isEquivalentPaneKey still decides, so
  // reminted tab halves keep matching and unparseable keys keep requiring an exact match.
  private runsBoundToPane(paneKey: string): RunRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs
           WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
             AND ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?
           ORDER BY rowid`
        )
        .all(paneKeyMatchSuffix(paneKey)) as RunRow[]
    ).filter(
      (run) =>
        run.coordinator_pane_key !== null && isEquivalentPaneKey(run.coordinator_pane_key, paneKey)
    )
  }

  private getRunRaw(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
  }

  private unbindOtherRunsForPane(paneKey: string, exceptRunId?: string): void {
    for (const run of this.runsBoundToPane(paneKey)) {
      if (run.id !== exceptRunId) {
        this.db
          .prepare(
            `UPDATE runs
             SET coordinator_handle = NULL, coordinator_pane_key = NULL,
                 consumer_generation = consumer_generation + 1,
                 updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(run.id)
        this.fenceOutstandingDelivery(run.id)
      }
    }
  }

  private requireRun(runId: string): void {
    if (!this.getRunRaw(runId)) {
      throw new Error(`Run not found: ${runId}`)
    }
  }

  private fenceOutstandingDelivery(runId: string): void {
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'fenced' WHERE run_id = ? AND status = 'outstanding'"
      )
      .run(runId)
  }

  private promoteLegacyCoordinatorMailForTakeover(
    runId: string,
    retainedCoordinatorHandle: string | null
  ): void {
    if (!retainedCoordinatorHandle) {
      return
    }
    this.db
      .prepare(
        `UPDATE messages
         SET to_handle = ?, delivery_contract = 'current_delivery',
             read = 0, delivered_at = NULL
         WHERE run_id = ? AND delivery_contract = 'legacy_direct'
           AND to_handle = ?
           AND EXISTS(
             SELECT 1 FROM dispatch_contexts d
             WHERE d.run_id = messages.run_id
               AND d.contract_version = ?
               AND (
                 messages.from_handle = d.assignee_handle OR
                 messages.from_handle = 'dispatch:' || d.id
               )
           )
           AND (
             read = 0 OR EXISTS(
               SELECT 1 FROM question_threads q
               WHERE q.message_id = messages.id AND q.status = 'pending'
             ) OR EXISTS(
               SELECT 1
               FROM legacy_mail_receipts r
               INNER JOIN legacy_compatibility_principals p
                 ON p.id = r.principal_id
               WHERE r.message_id = messages.id
                 AND r.acknowledged_at IS NULL
                 AND p.run_id = messages.run_id
                 AND p.role = 'coordinator'
                 AND p.terminal_handle = ?
             ) OR (
               read = 1
               AND NOT EXISTS(
                 SELECT 1 FROM legacy_compatibility_principals p
                 WHERE p.run_id = messages.run_id AND p.role = 'coordinator'
               )
               AND EXISTS(
                 SELECT 1 FROM dispatch_contexts d
                 WHERE d.run_id = messages.run_id
                   AND d.contract_version = ?
                   AND d.status IN ('pending', 'dispatched')
                   AND messages.created_at >= d.created_at
                   AND (
                     messages.from_handle = d.assignee_handle OR
                     messages.from_handle = 'dispatch:' || d.id
                   )
               )
             )
           )`
      )
      .run(
        `run:${runId}`,
        runId,
        retainedCoordinatorHandle,
        LEGACY_CONTRACT_VERSION,
        retainedCoordinatorHandle,
        LEGACY_CONTRACT_VERSION
      )
  }

  private getUniqueLegacyCoordinatorHandle(runId: string): string | null {
    const adoption = this.getLegacyAdoption()
    if (!adoption || adoption.adopted_run_id !== runId) {
      return null
    }
    const workerHandles = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT assignee_handle AS handle
             FROM dispatch_contexts
             WHERE run_id = ? AND contract_version = ?
               AND assignee_handle IS NOT NULL
             UNION
             SELECT DISTINCT terminal_handle AS handle
             FROM legacy_compatibility_principals
             WHERE run_id = ? AND role = 'worker'
               AND status IN ('committed', 'settled')`
          )
          .all(runId, LEGACY_CONTRACT_VERSION, runId) as { handle: string }[]
      ).map((row) => row.handle)
    )
    const durableRows = this.db
      .prepare(
        `SELECT coordinator_handle AS handle
         FROM coordinator_runs
         WHERE scheduler_lost_at = ?
         UNION
         SELECT created_by_terminal_handle AS handle
         FROM tasks t
         WHERE t.run_id = ? AND t.created_by_terminal_handle IS NOT NULL
           AND t.created_at <= ?
           AND EXISTS(
             SELECT 1 FROM dispatch_contexts d
             WHERE d.task_id = t.id AND d.run_id = t.run_id
               AND d.contract_version = ?
           )`
      )
      .all(adoption.adopted_at, runId, adoption.adopted_at, LEGACY_CONTRACT_VERSION) as {
      handle: string
    }[]
    if (durableRows.some((row) => workerHandles.has(row.handle))) {
      return null
    }
    const candidates = new Set(durableRows.map((row) => row.handle))
    const mailRows = this.db
      .prepare(
        `SELECT m.to_handle AS handle
         FROM messages m
         INNER JOIN dispatch_contexts d
           ON d.run_id = m.run_id AND d.contract_version = ?
          AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND m.created_at <= ?
         UNION
         SELECT m.from_handle AS handle
         FROM messages m
         INNER JOIN dispatch_contexts d
           ON d.run_id = m.run_id AND d.contract_version = ?
          AND (m.to_handle = d.assignee_handle OR m.to_handle = 'dispatch:' || d.id)
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
           AND m.created_at <= ?`
      )
      .all(
        LEGACY_CONTRACT_VERSION,
        runId,
        adoption.adopted_at,
        LEGACY_CONTRACT_VERSION,
        runId,
        adoption.adopted_at
      ) as {
      handle: string
    }[]
    for (const row of mailRows) {
      if (
        !workerHandles.has(row.handle) &&
        !row.handle.startsWith('dispatch:') &&
        !row.handle.startsWith('run:')
      ) {
        candidates.add(row.handle)
      }
    }
    return candidates.size === 1 ? ([...candidates][0] ?? null) : null
  }

  private requireCurrentConsumer(runId: string, consumerGeneration: number): RunRow {
    const run = this.getRunRaw(runId)
    if (!run || run.legacy === 1 || run.consumer_generation !== consumerGeneration) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This mailbox consumer has been replaced. Rebind with orchestration run-use.'
      )
    }
    return run
  }

  private getDeliveryRaw(id: string): DeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as
      | DeliveryRow
      | undefined
  }

  // Why filtered here, not just at mint time (amendment E, PURGE § "Frozen delivery batches"):
  // message_ids is frozen at creation, so a message purged (or whose author is quarantined)
  // AFTER this Delivery was minted must still drop out of every replay — the id stays in the
  // frozen list so the eventual ack still clears it, but the row itself is withheld.
  private getDeliveryMessages(delivery: DeliveryRow): {
    messages: MessageRow[]
    omitted: { purged: number; withheld: number }
  } {
    const ids = JSON.parse(delivery.message_ids) as string[]
    if (ids.length === 0) {
      return { messages: [], omitted: { purged: 0, withheld: 0 } }
    }
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as MessageRow[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((row): row is MessageRow => row !== undefined)
    const { messages, omitted } = filterLiveMessageRows(this.db, ordered)
    return { messages: exposeMessageListTimestamps(messages), omitted }
  }

  // Why: message_ids is frozen at creation, so mail that arrives after an outstanding Delivery
  // never joins it and is invisible until the Delivery is acknowledged. Count what is stuck.
  private countUnreadRunMessagesOutsideDelivery(runId: string, deliveredIds: string[]): number {
    const exclusion =
      deliveredIds.length > 0 ? ` AND id NOT IN (${deliveredIds.map(() => '?').join(',')})` : ''
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'${exclusion}`
      )
      .get(runId, `run:${runId}`, ...deliveredIds) as { count: number } | undefined
    return row?.count ?? 0
  }

  getOrCreateRunDelivery(params: {
    runId: string
    consumerGeneration: number
    limit?: number
    wakeTypes?: MessageType[]
  }):
    | {
        delivery: DeliveryRow
        messages: MessageRow[]
        replayed: boolean
        pendingBehind: number
        omitted?: { purged: number; withheld: number }
      }
    | undefined {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 50)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
      const existing = this.db
        .prepare("SELECT * FROM deliveries WHERE run_id = ? AND status = 'outstanding'")
        .get(params.runId) as DeliveryRow | undefined
      if (existing) {
        if (existing.consumer_generation !== params.consumerGeneration) {
          throw new OrchestrationError(
            'consumer_fenced',
            'This mailbox Delivery belongs to a fenced consumer generation.'
          )
        }
        const { messages, omitted } = this.getDeliveryMessages(existing)
        const pendingBehind = this.countUnreadRunMessagesOutsideDelivery(
          params.runId,
          JSON.parse(existing.message_ids) as string[]
        )
        this.db.exec('COMMIT')
        return {
          delivery: exposeDeliveryTimestamps(existing),
          messages,
          replayed: true,
          pendingBehind,
          ...(omitted.purged > 0 || omitted.withheld > 0 ? { omitted } : {})
        }
      }

      const address = `run:${params.runId}`
      if (params.wakeTypes && params.wakeTypes.length > 0) {
        const placeholders = params.wakeTypes.map(() => '?').join(',')
        const matching = this.db
          .prepare(
            `SELECT 1 FROM messages
             WHERE run_id = ? AND to_handle = ? AND read = 0
               AND delivery_contract = 'current_delivery'
               AND type IN (${placeholders}) LIMIT 1`
          )
          .get(params.runId, address, ...params.wakeTypes)
        if (!matching) {
          this.db.exec('COMMIT')
          return undefined
        }
      }

      const messages = exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages
             WHERE run_id = ? AND to_handle = ? AND read = 0
               AND delivery_contract = 'current_delivery'
               AND ${liveMessageSqlClause()}
             ORDER BY sequence ASC LIMIT ?`
          )
          .all(params.runId, address, limit) as MessageRow[]
      )
      if (messages.length === 0) {
        this.db.exec('COMMIT')
        return undefined
      }

      const deliveryId = generateId('delivery')
      this.db
        .prepare(
          `INSERT INTO deliveries (id, run_id, consumer_generation, message_ids)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          deliveryId,
          params.runId,
          params.consumerGeneration,
          JSON.stringify(messages.map((message) => message.id))
        )
      const delivery = this.getDeliveryRaw(deliveryId) as DeliveryRow
      // Why counted here too: a fresh batch is capped at `limit`, so an overflowing mailbox
      // strands the remainder behind this Delivery from the moment it is created.
      const pendingBehind = this.countUnreadRunMessagesOutsideDelivery(
        params.runId,
        messages.map((message) => message.id)
      )
      this.db.exec('COMMIT')
      return {
        delivery: exposeDeliveryTimestamps(delivery),
        messages,
        replayed: false,
        pendingBehind
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  acknowledgeRunDelivery(params: {
    runId: string
    consumerGeneration: number
    deliveryId: string
  }): { delivery: DeliveryRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
      const delivery = this.getDeliveryRaw(params.deliveryId)
      if (!delivery || delivery.run_id !== params.runId) {
        throw new OrchestrationError(
          'stale_delivery',
          `Delivery ${params.deliveryId} does not belong to this Run.`
        )
      }
      if (
        delivery.consumer_generation !== params.consumerGeneration ||
        delivery.status === 'fenced'
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This mailbox Delivery belongs to a fenced consumer generation.'
        )
      }
      if (delivery.status === 'acknowledged') {
        this.db.exec('COMMIT')
        return { delivery: exposeDeliveryTimestamps(delivery), duplicate: true }
      }

      const messageIds = JSON.parse(delivery.message_ids) as string[]
      if (messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(',')
        this.db
          .prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`)
          .run(...messageIds)
      }
      this.db
        .prepare(
          "UPDATE deliveries SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?"
        )
        .run(delivery.id)
      const acknowledged = this.getDeliveryRaw(delivery.id) as DeliveryRow
      this.db.exec('COMMIT')
      return { delivery: exposeDeliveryTimestamps(acknowledged), duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Live-message clause (amendment E): backs `check --peek/--all`, a read path the PURGE §
  // table names explicitly ("Every read path... peek/--all").
  getRunMailboxHistory(runId: string, limit = 100, types?: MessageType[]): MessageRow[] {
    const address = `run:${runId}`
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
             AND type IN (${placeholders}) AND ${liveMessageSqlClause()}
             ORDER BY sequence DESC LIMIT ?`
          )
          .all(runId, address, ...types, limit) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
           AND ${liveMessageSqlClause()}
           ORDER BY sequence DESC LIMIT ?`
        )
        .all(runId, address, limit) as MessageRow[]
    )
  }

  // ── Agent directory (S10-1) — logic lives in agent-directory.ts / peer-mailbox-deliveries.ts;
  // these are delegating calls only (this file is ratcheted).
  upsertAgentByPaneSuffix(params: UpsertAgentByPaneSuffixParams): UpsertAgentByPaneSuffixResult {
    return upsertAgentByPaneSuffix(this.db, params)
  }

  getAgentById(id: string): AgentRow | undefined {
    return getAgentByIdImpl(this.db, id)
  }

  getAgentByName(hostId: string, displayName: string): AgentRow | undefined {
    return getAgentByNameImpl(this.db, hostId, displayName)
  }

  listAgents(params?: ListAgentsParams): ListAgentsResult {
    return listAgentsImpl(this.db, params)
  }

  refreshAgentLiveness(params: RefreshAgentLivenessParams): AgentRow {
    return refreshAgentLivenessImpl(this.db, params)
  }

  setAgentQuarantine(params: SetAgentQuarantineParams): AgentRow {
    return setAgentQuarantineImpl(this.db, params)
  }

  getAgentByIdIncludingTombstoned(id: string): AgentRow | undefined {
    return getAgentByIdIncludingTombstonedImpl(this.db, id)
  }

  retireAgent(id: string): RetireAgentResult {
    return retireAgentImpl(this.db, id)
  }

  writeAgentAudit(params: WriteAgentAuditParams): void {
    writeAgentAuditImpl(this.db, params)
  }

  checkAndBumpRate(params: CheckAndBumpRateParams): RateLimitResult {
    return checkAndBumpRateImpl(this.db, params)
  }

  // C1/C2 (Ruling 33(a)): the sole live registered row on `worktreePath` whose pane went dark —
  // shared by `orchestration.check`'s notice and the idle-edge pane wake.
  findOrphanedIdentityCandidate(
    hostId: string,
    worktreePath: string,
    isPaneLive?: (paneKey: string) => boolean
  ): AgentRow | undefined {
    return findSoleOrphanedIdentityCandidate(this.db, hostId, worktreePath, isPaneLive)
  }

  // F-9b (Ruling 33 Addendum 1): idempotent catch-up for a successor that missed succession on
  // an earlier register (e.g. one registered before this fix landed) — null (no-op) once a
  // `thread_succession` audit row already marks this successor id.
  catchUpThreadSuccession(
    hostId: string,
    displayName: string,
    successorId: string
  ): (ThreadSuccessionOutcome & UninheritedPredecessorMailOutcome) | null {
    return catchUpThreadSuccessionImpl(this.db, hostId, displayName, successorId)
  }

  // S10-16 R14.6: link-binding-store.ts / link-binding-attempts-store.ts /
  // link-binding-observations-store.ts / reply-outbox-store.ts / reply-outbox-lifecycle.ts
  // delegations — two/three-line wrappers only, matching agent-audit-log.ts's split.
  getPeerLinkBinding(linkDeviceId: string): PeerLinkBindingRow | null {
    return getPeerLinkBindingImpl(this.db, linkDeviceId)
  }

  listPeerLinkBindings(): PeerLinkBindingRow[] {
    return listPeerLinkBindingsImpl(this.db)
  }

  putPeerLinkBinding(
    row: Omit<
      PeerLinkBindingRow,
      'state' | 'detail' | 'contestIncidentId' | 'contestedAt' | 'revokedAt'
    >
  ): void {
    putPeerLinkBindingImpl(this.db, row)
  }

  contestPeerLinkBinding(
    linkDeviceId: string,
    now: number,
    incidentId: string,
    detail: string | null,
    firstWinner: ContestFirstWinner
  ): void {
    contestPeerLinkBindingImpl(this.db, linkDeviceId, now, incidentId, detail, firstWinner)
  }

  revokePeerLinkBinding(linkDeviceId: string, now: number): void {
    revokePeerLinkBindingImpl(this.db, linkDeviceId, now)
  }

  // Ruling 28(a): lifts a sticky revoke — called only from the `linkBind` RPC handler.
  unrevokePeerLinkBinding(linkDeviceId: string, now: number): boolean {
    return unrevokePeerLinkBindingImpl(this.db, linkDeviceId, now)
  }

  // Ruling 28(a): clears an existing contest on a forced proveNow round's clean single winner —
  // called only from link-binding-prover-settle.ts, the round settle
  resolvePeerLinkBindingContest(
    row: Omit<
      PeerLinkBindingRow,
      'state' | 'detail' | 'contestIncidentId' | 'contestedAt' | 'revokedAt'
    >
  ): void {
    resolvePeerLinkBindingContestImpl(this.db, row)
  }

  findBindingsByEnvironment(environmentId: string): PeerLinkBindingRow[] {
    return findBindingsByEnvironmentImpl(this.db, environmentId)
  }

  // Ruling 26 Addendum 5(nn): a CANDIDATE, not a routable destination — callers must filter
  // through `getRoutableLinkBinding` before retargeting onto it.
  findBindingCandidateByKeyFingerprint(peerKeyFingerprint: string): PeerLinkBindingRow | null {
    return findBindingCandidateByKeyFingerprintImpl(this.db, peerKeyFingerprint)
  }

  getBindingAttempt(linkDeviceId: string): BindingAttemptRow | null {
    return getBindingAttemptImpl(this.db, linkDeviceId)
  }

  listBindingAttempts(): BindingAttemptRow[] {
    return listBindingAttemptsImpl(this.db)
  }

  putBindingAttempt(linkDeviceId: string): void {
    putBindingAttemptImpl(this.db, linkDeviceId)
  }

  settleBindingAttempt(linkDeviceId: string, settle: BindingAttemptSettle): void {
    settleBindingAttemptImpl(this.db, linkDeviceId, settle)
  }

  putLinkAdvisory(linkDeviceId: string, advisory: LinkAdvisory, now: number): void {
    putLinkAdvisoryImpl(this.db, linkDeviceId, advisory, now)
  }

  clearLinkAdvisory(linkDeviceId: string): void {
    clearLinkAdvisoryImpl(this.db, linkDeviceId)
  }

  bumpMisrouteAdvisories(linkDeviceId: string): void {
    bumpMisrouteAdvisoriesImpl(this.db, linkDeviceId)
  }

  getScanFact(linkDeviceId: string, environmentId: string): ScanFactRow | null {
    return getScanFactImpl(this.db, linkDeviceId, environmentId)
  }

  listScanFacts(linkDeviceId: string): ScanFactRow[] {
    return listScanFactsImpl(this.db, linkDeviceId)
  }

  // Ruling 28(h): the distinct link ids `linkForget` must include so it never deletes a link's
  // scan-fact rows while omitting it from the retained/forgotten id set.
  listScanFactLinkIds(): string[] {
    return listScanFactLinkIdsImpl(this.db)
  }

  putScanFact(row: ScanFactRow): void {
    putScanFactImpl(this.db, row)
  }

  listConfirmObservations(linkDeviceId: string): ConfirmObservationRow[] {
    return listConfirmObservationsImpl(this.db, linkDeviceId)
  }

  // Ruling 28(h): same coverage requirement as `listScanFactLinkIds`, for the confirm-observation
  // table — the one table a peer's own call creates rows in.
  listConfirmObservationLinkIds(): string[] {
    return listConfirmObservationLinkIdsImpl(this.db)
  }

  putConfirmObservation(row: ConfirmObservationRow): void {
    putConfirmObservationImpl(this.db, row)
  }

  isPeerLinkQuarantined(linkDeviceId: string): boolean {
    return isPeerLinkQuarantinedImpl(this.db, linkDeviceId)
  }

  getContainment(
    subjectKind: ContainmentRow['subjectKind'],
    subjectId: string,
    action: ContainmentRow['action']
  ): ContainmentRow | null {
    return getContainmentImpl(this.db, subjectKind, subjectId, action)
  }

  listContainment(): ContainmentRow[] {
    return listContainmentImpl(this.db)
  }

  putContainment(row: Omit<ContainmentRow, 'liftedAt'>): void {
    putContainmentImpl(this.db, row)
  }

  liftContainment(
    subjectKind: ContainmentRow['subjectKind'],
    subjectId: string,
    action: ContainmentRow['action'],
    now: number
  ): void {
    liftContainmentImpl(this.db, subjectKind, subjectId, action, now)
  }

  deleteBindingsAndAttemptsNotIn(retainedLinkDeviceIds: readonly string[]): void {
    deleteBindingsAndAttemptsNotInImpl(this.db, retainedLinkDeviceIds)
  }

  deleteBindingsAndAttemptsIn(forgottenLinkDeviceIds: readonly string[]): void {
    deleteBindingsAndAttemptsInImpl(this.db, forgottenLinkDeviceIds)
  }

  enqueueReplyOutbox(params: EnqueueReplyOutboxParams): string {
    return enqueueReplyOutboxImpl(this.db, params)
  }

  // R16.2(2): audit + enqueue + markAsRead, ONE `BEGIN IMMEDIATE` — plain statements only, no
  // network. `insertGatedMessage` (R16.2(1)) already ran OUTSIDE this transaction, in the
  // caller, so its own `gate_refusals` audit row survives a refusal here undisturbed.
  enqueueForeignReplyIntent(params: {
    audit: WriteAgentAuditParams
    outbox: EnqueueReplyOutboxParams
    markAsReadIds: string[]
  }): string {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeAgentAudit(params.audit)
      const outboxId = enqueueReplyOutboxImpl(this.db, params.outbox)
      this.markAsRead(params.markAsReadIds)
      this.db.exec('COMMIT')
      return outboxId
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getReplyOutboxItem(id: string): ReplyOutboxRow | null {
    return getReplyOutboxItemImpl(this.db, id)
  }

  listReplyOutbox(linkDeviceId?: string): ReplyOutboxRow[] {
    return listReplyOutboxImpl(this.db, linkDeviceId)
  }

  // S10-16 C6a, Ruling 27(b): the bounded, column-limited accessor the check-path health mapper
  // uses instead of `listReplyOutbox`'s unfiltered `SELECT *`.
  listReplyOutboxHealthRows(linkDeviceId: string, now: number): ReplyOutboxHealthRow[] {
    return listReplyOutboxHealthRowsImpl(this.db, linkDeviceId, now)
  }

  countPendingReplyOutbox(linkDeviceId: string): number {
    return countPendingReplyOutboxImpl(this.db, linkDeviceId)
  }

  cancelQueuedReplyOutbox(now: number): number {
    return cancelQueuedReplyOutboxImpl(this.db, now)
  }

  kickReplyOutboxForLink(linkDeviceId: string, now: number): void {
    kickReplyOutboxForLinkImpl(this.db, linkDeviceId, now)
  }

  getReplyOutboxItemByLocalMessageId(localMessageId: string): ReplyOutboxRow | null {
    return getReplyOutboxItemByLocalMessageIdImpl(this.db, localMessageId)
  }

  markReplyOutboxNotified(id: string, now: number): void {
    markReplyOutboxNotifiedImpl(this.db, id, now)
  }

  // Ruling 26 Addendum 4(hh)/(ii)/(jj): the ONLY writer of last_notified_condition/
  // last_notified_at — the DISPOSITION family's own edge + persisted per-link interval; called
  // exclusively from the notice choke's disposition path, never from a hold path and never for
  // the R20.2 advisory or the unreachable/recovered family.
  markReplyOutboxDispositionNotice(id: string, condition: string, now: number): void {
    markReplyOutboxDispositionNoticeImpl(this.db, id, condition, now)
  }

  replyOutboxLinkLastDispositionNotifiedAt(linkDeviceId: string): number | null {
    return replyOutboxLinkLastDispositionNotifiedAtImpl(this.db, linkDeviceId)
  }

  // Ruling 26 Addendum 5(oo): the R20.2 advisory's own persisted per-link interval, restart-safe.
  replyOutboxLinkLastAdvisoryNotifiedAt(linkDeviceId: string): number | null {
    return replyOutboxLinkLastAdvisoryNotifiedAtImpl(this.db, linkDeviceId)
  }

  nextReplyOutboxWakeAt(): number | null {
    return nextReplyOutboxWakeAtImpl(this.db)
  }

  reclaimExpiredReplyOutboxLeases(now: number): number {
    return reclaimExpiredReplyOutboxLeasesImpl(this.db, now)
  }

  claimNextReplyOutboxItem(now: number): ReplyOutboxRow | null {
    return claimNextReplyOutboxItemImpl(this.db, now)
  }

  settleReplyOutboxItem(id: string, settle: ReplyOutboxSettle): boolean {
    return settleReplyOutboxItemImpl(this.db, id, settle)
  }

  // Ruling 26 Addendum 3(dd)/F4: the guarded state='sending' -> 'queued' write's boolean is
  // returned so the caller can check it (a lost write must never be treated as a completed hold).
  holdReplyOutboxItem(
    id: string,
    now: number,
    nextAttemptAfter: number,
    lastErrorCode: string
  ): boolean {
    return holdReplyOutboxItemImpl(this.db, id, now, nextAttemptAfter, lastErrorCode)
  }

  // `now` kept in the public signature for call-site symmetry with the other lifecycle methods;
  // the impl no longer writes it (first_held_at is deliberately never advanced — R18.4(a)/L4).
  holdReplyOutboxItemLocalEvidence(id: string, _now: number, nextAttemptAfter: number): boolean {
    return holdReplyOutboxItemLocalEvidenceImpl(this.db, id, nextAttemptAfter)
  }

  // M10 (C5 review)/Ruling 26(j): the in-flight-registry collision hold — never starts the
  // R18.3 abandon clock (first_held_at left untouched, same shape as the local-evidence hold).
  holdReplyOutboxItemCollision(id: string, nextAttemptAfter: number): boolean {
    return holdReplyOutboxItemCollisionImpl(this.db, id, nextAttemptAfter)
  }

  retryReplyOutboxItem(
    id: string,
    _now: number,
    nextAttemptAfter: number,
    consecutiveFailures: number,
    lastErrorCode: string | null,
    lastError: string | null
  ): boolean {
    return retryReplyOutboxItemImpl(
      this.db,
      id,
      nextAttemptAfter,
      consecutiveFailures,
      lastErrorCode,
      lastError
    )
  }

  retargetReplyOutboxItem(
    id: string,
    route: {
      linkDeviceId: string
      environmentId: string
      boundPairingRevision: number
      peerCredentialFp: string
      peerKeyFingerprint: string
    }
  ): boolean {
    return retargetReplyOutboxItemImpl(this.db, id, route)
  }

  getOrCreateMailboxDelivery(
    params: GetOrCreateMailboxDeliveryParams
  ): GetOrCreateMailboxDeliveryResult | undefined {
    return getOrCreateMailboxDeliveryImpl(this.db, params)
  }

  acknowledgeMailboxDelivery(
    deliveryId: string,
    mailboxHandle: string
  ): AcknowledgeMailboxDeliveryResult {
    return acknowledgeMailboxDeliveryImpl(this.db, deliveryId, mailboxHandle)
  }

  getAgentByPaneKey(hostId: string, paneKey: string): AgentRow | undefined {
    return getAgentByPaneKeyImpl(this.db, hostId, paneKey)
  }

  upsertDerivedAgentForPane(params: UpsertDerivedAgentForPaneParams): AgentRow | undefined {
    return upsertDerivedAgentForPaneImpl(this.db, params)
  }

  pruneStaleDerivedAgents(hostId: string): number {
    return pruneStaleDerivedAgentsImpl(this.db, hostId)
  }

  // ── Durable threads, gated messages, purge (S10-2a) — logic lives in message-gate-writer.ts /
  // thread-directory.ts / message-purge.ts; these are delegating calls only (this file is
  // ratcheted). `insertGatedMessage` is the single write choke for peer-facing content
  // (ruling 2). `insertMessage` below is NOT yet host-lifecycle-only: this series lands no
  // handler edits (s10-2-spec.md:119, 213), so several of its own internal callers and several
  // external ones still write peer-supplied free text ungated. Its exact caller set — which
  // callers are genuinely host-generated and which are pending reroute onto
  // `insertGatedMessage` in S10-2b — is enumerated and CI-pinned in
  // `insert-message-call-sites.ts` / `insert-message-call-site-audit.test.ts`, not asserted
  // here.
  insertGatedMessage(params: InsertGatedMessageParams): InsertGatedMessageResult {
    return insertGatedMessageImpl(this.db, {
      ...params,
      infraAllowlist: params.infraAllowlist ?? this.infraAllowlist
    })
  }

  createThread(params: CreateThreadParams): ReturnType<typeof createThreadImpl> {
    return createThreadImpl(this.db, params)
  }

  getThread(threadId: string): ThreadRow | undefined {
    return getThreadImpl(this.db, threadId)
  }

  listThreadParticipants(threadId: string): ThreadParticipantRow[] {
    return listThreadParticipantsImpl(this.db, threadId)
  }

  isThreadParticipant(threadId: string, participantKey: string): boolean {
    return isThreadParticipantImpl(this.db, threadId, participantKey)
  }

  listThreadsForParticipant(params: ListThreadsForParticipantParams): ThreadRow[] {
    return listThreadsForParticipantImpl(this.db, params)
  }

  upsertThreadParticipant(params: UpsertThreadParticipantParams): ThreadParticipantRow {
    return upsertThreadParticipantImpl(this.db, params)
  }

  leaveThread(threadId: string, participantKey: string): void {
    leaveThreadImpl(this.db, threadId, participantKey)
  }

  bumpThreadOnMessage(
    threadId: string,
    message: Pick<MessageRow, 'id' | 'sequence' | 'created_at'>
  ): void {
    bumpThreadOnMessageImpl(this.db, threadId, message)
  }

  setThreadState(threadId: string, state: ThreadState): ThreadRow {
    return setThreadStateImpl(this.db, threadId, state)
  }

  setThreadPact(threadId: string, params: SetThreadPactParams): ThreadRow {
    return setThreadPactImpl(this.db, threadId, params)
  }

  // S10-3 pact spec — the twelve OrchestrationDb pact methods (RPCS §/SCHEMA §). Logic lives in
  // pact-*.ts per this file's ratchet rule (same precedent as thread-directory.ts).
  proposePact(params: ProposePactParams): ThreadRow {
    return proposePactImpl(this.db, params)
  }

  acceptPact(params: AcceptPactParams): ThreadRow {
    return acceptPactImpl(this.db, params)
  }

  declinePact(params: DeclinePactParams): ThreadRow {
    return declinePactImpl(this.db, params)
  }

  appendPactStep(params: AppendPactStepParams): AppendPactStepResult {
    return appendPactStepImpl(this.db, {
      ...params,
      infraAllowlist: params.infraAllowlist ?? this.infraAllowlist
    })
  }

  pausePact(params: PausePactParams): ThreadRow {
    return pausePactImpl(this.db, params)
  }

  // Dispatcher behind the CLI's single `pact --resume` flag — internally calls
  // requestPactResume or resumePact depending on who the pausing side is (AUTHORITY §).
  resumePactOrRequest(params: ResumePactParams): ResumePactOutcome {
    return resumePactOrRequestImpl(this.db, params)
  }

  releasePact(params: ReleasePactParams): ThreadRow {
    return releasePactImpl(this.db, params)
  }

  getPactState(threadId: string): ThreadRow | undefined {
    return getPactStateImpl(this.db, threadId)
  }

  getEngagedPactWith(agentId: string, peerAgentId: string): ThreadRow | undefined {
    return getEngagedPactWithImpl(this.db, agentId, peerAgentId)
  }

  getTurnsHeldBy(agentId: string): string[] {
    return getTurnsHeldByImpl(this.db, agentId)
  }

  getPactLedger(params: GetPactLedgerParams): PactLedgerResult {
    return getPactLedgerImpl(this.db, params)
  }

  getIncomingUnansweredProposal(agentId: string): ThreadRow | undefined {
    return getIncomingUnansweredProposalImpl(this.db, agentId)
  }

  findOrCreatePeerThread(params: FindOrCreatePeerThreadParams): FindOrCreatePeerThreadResult {
    return findOrCreatePeerThreadImpl(this.db, params)
  }

  // Liveness/leave/thread-state auto-pause hooks (K6/K16/K17) — called by the RPC layer, never
  // internally by these pact methods (which only ever act on the caller's own request).
  autoPausePactsForAgent(agentId: string, reason: PactPauseReason): AutoPauseOutcome[] {
    return autoPausePactsForAgentImpl(this.db, agentId, reason)
  }

  autoPausePactOnThread(threadId: string, reason: PactPauseReason): AutoPauseOutcome | null {
    return autoPausePactOnThreadImpl(this.db, threadId, reason)
  }

  markThreadRead(threadId: string, participantKey: string, sequence: number): void {
    markThreadReadImpl(this.db, threadId, participantKey, sequence)
  }

  getThreadMessagesSince(
    threadId: string,
    afterSequence?: number,
    limit?: number
  ): { messages: MessageRow[]; omitted: GetThreadMessagesSinceOmitted } {
    return getThreadMessagesSinceImpl(this.db, threadId, afterSequence, limit)
  }

  purgeMessage(params: PurgeMessageParams): PurgeMessageResult {
    return purgeMessageImpl(this.db, {
      ...params,
      infraAllowlist: params.infraAllowlist ?? this.infraAllowlist
    })
  }

  purgeThread(params: PurgeThreadParams): PurgeThreadResult {
    return purgeThreadImpl(this.db, {
      ...params,
      infraAllowlist: params.infraAllowlist ?? this.infraAllowlist
    })
  }

  listMessagesByAuthor(params: ListMessagesByAuthorParams): MessageRow[] {
    return listMessagesByAuthorImpl(this.db, params)
  }

  // S10-15 F5 (chair ruling 5): the count the per-link pending-question cap is checked against
  // — every still-pending PEER_RUN_ID question whose synthetic asker handle names this link,
  // regardless of which local agent it targets.
  countPendingPeerQuestionsForLink(pairedDeviceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM question_threads
         WHERE run_id = ? AND status = 'pending' AND asker_handle LIKE ?`
      )
      .get(PEER_RUN_ID, `remote:${pairedDeviceId}:%`) as { n: number }
    return row.n
  }

  // S10-15 review F3: the far side's own blocking wait always returns AT (never past)
  // `deadline`, so a time-deferred close inside that same handler can never observe
  // `deadline + grace` — a lazy sweep at the next ingest is the only place that elapsed time can
  // actually be observed. Per Ruling 5 this must be the ASK'S OWN timeoutMs + RESUME_GRACE_MS,
  // not a coarse max-clamp+grace bound — `expires_at` (set at mint, federatedAsk) carries that
  // exact per-row deadline. `fallbackThresholdIso` (the caller's precomputed
  // `now - (maxClampMs + graceMs)`) is used ONLY for rows minted before this column existed
  // (expires_at IS NULL) — a pre-migration row has no per-ask deadline to read, so it falls back
  // to the old coarse bound rather than never expiring.
  closeExpiredPeerQuestionsForLink(
    pairedDeviceId: string,
    nowIso: string,
    fallbackThresholdIso: string
  ): string[] {
    const rows = this.db
      .prepare(
        `SELECT message_id FROM question_threads
         WHERE run_id = ? AND status = 'pending' AND asker_handle LIKE ?
           AND (
             (expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?))
             OR (expires_at IS NULL AND julianday(created_at) < julianday(?))
           )`
      )
      .all(PEER_RUN_ID, `remote:${pairedDeviceId}:%`, nowIso, fallbackThresholdIso) as {
      message_id: string
    }[]
    if (rows.length === 0) {
      return []
    }
    this.db
      .prepare(
        `UPDATE question_threads SET status = 'closed', closed_at = datetime('now')
         WHERE run_id = ? AND status = 'pending' AND asker_handle LIKE ?
           AND (
             (expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?))
             OR (expires_at IS NULL AND julianday(created_at) < julianday(?))
           )`
      )
      .run(PEER_RUN_ID, `remote:${pairedDeviceId}:%`, nowIso, fallbackThresholdIso)
    return rows.map((row) => row.message_id)
  }

  // S10-15 review F5: the smallest delete available — no general-purpose thread-delete method
  // exists (purgeThread scrubs content but keeps the row). Scoped to the ONE caller that needs
  // it: relayPeerAskToHost's just-minted local thread when the relay transport call itself
  // throws (an unreachable/timed-out host) — never call this on a thread anything else may
  // already reference (a message, a pact, a purge record).
  deleteOrphanRelayAskThread(threadId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM thread_participants WHERE thread_id = ?').run(threadId)
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // S10-2b amendment F: peer ask/reply (no Dispatch, no consumer_generation to fence on).
  createPeerQuestion(params: CreatePeerQuestionParams): CreatePeerQuestionResult {
    return createPeerQuestionImpl(this.db, {
      ...params,
      infraAllowlist: params.infraAllowlist ?? this.infraAllowlist
    })
  }

  answerPeerQuestion(params: AnswerPeerQuestionParams): AnswerPeerQuestionResult {
    return answerPeerQuestionImpl(this.db, {
      ...params,
      infraAllowlist: params.infraAllowlist ?? this.infraAllowlist
    })
  }

  // ── Messages ──

  insertMessage(msg: {
    id?: string
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
    senderPaneKey?: string
    recipientPaneKey?: string
    senderAgentId?: string | null
    runId?: string
    deliveryContract?: MessageDeliveryContract
    /** Host-only column write (never gated — insertMessage's callers are the host-lifecycle
     * exemption list): the runtime-notification kinds (input_not_consumed / liveness_breach /
     * relay_unreachable) that keep living in JSON payload.kind (amendment D) also need the
     * payload_kind COLUMN populated, since every read-side waiter/reservation lookup
     * (message-waiter-thread-keying.ts) now reads that column exclusively. */
    payloadKind?: string | null
  }): MessageRow {
    const runId = msg.runId ?? LEGACY_RUN_ID
    const deliveryContract = msg.deliveryContract ?? 'current_delivery'
    this.requireRun(runId)
    const id = msg.id ?? generateId('msg')
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle, subject, body,
        type, priority, thread_id, payload, sender_pane_key, recipient_pane_key, sender_agent_id,
        payload_kind
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      runId,
      deliveryContract,
      msg.from,
      msg.to,
      msg.subject,
      msg.body ?? '',
      msg.type ?? 'status',
      msg.priority ?? 'normal',
      msg.threadId ?? null,
      msg.payload ?? null,
      msg.senderPaneKey ?? null,
      msg.recipientPaneKey ?? null,
      msg.senderAgentId ?? null,
      msg.payloadKind ?? null
    )
    return exposeMessageTimestamps(
      this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
    )
  }

  commitLegacyLifecycleOperation(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    message: {
      existingId?: string
      to: string
      subject: string
      body?: string
      type: MessageType
      priority?: MessagePriority
      payload?: string
    }
    lifecycle:
      | { kind: 'message_only' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
  }): {
    receipt: LegacyOperationReceiptRow
    message: MessageRow
    settlement?: WorkerReportSettlement
    duplicate: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
      if (
        !principal ||
        principal.role !== 'worker' ||
        !['committed', 'settled'].includes(principal.status)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Legacy compatibility principal ${params.principalId} cannot send lifecycle work.`
        )
      }
      const dispatchId = principal.dispatch_id as string
      const existingReceipt = this.requireMatchingLegacyOperationReceipt(params)
      if (existingReceipt) {
        const response = JSON.parse(existingReceipt.response_json) as {
          messageId: string
          settlement?: WorkerReportSettlement
        }
        const message = this.getMessageById(response.messageId)
        if (!message) {
          throw new OrchestrationError(
            'operation_unknown',
            `Legacy operation ${params.operationKey} lost its recorded message.`
          )
        }
        this.db.exec('COMMIT')
        return {
          receipt: existingReceipt,
          message,
          settlement: response.settlement,
          duplicate: true
        }
      }

      const dispatch = this.getDispatchContextById(dispatchId)
      if (
        !dispatch ||
        dispatch.run_id !== principal.run_id ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is not this principal's legacy attempt.`
        )
      }
      if (
        (principal.status === 'settled' || !['pending', 'dispatched'].includes(dispatch.status)) &&
        (!params.message.existingId || params.lifecycle.kind !== 'worker_report')
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is settled and only matching completion reconstruction is allowed.`
        )
      }
      let message = params.message.existingId
        ? this.getMessageById(params.message.existingId)
        : undefined
      const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
        principal.run_id,
        params.message.to
      )
      if (params.message.existingId) {
        const matchesOriginalLegacyRoute =
          message?.delivery_contract === 'legacy_direct' && message.to_handle === params.message.to
        const matchesCurrentRoute =
          message?.delivery_contract === delivery.contract && message.to_handle === delivery.to
        if (
          !message ||
          message.run_id !== principal.run_id ||
          message.from_handle !== principal.terminal_handle ||
          (!matchesOriginalLegacyRoute && !matchesCurrentRoute)
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Existing legacy message ${params.message.existingId} does not match this principal.`
          )
        }
      } else {
        // Amendment A: legacy lifecycle sends (heartbeat/worker_done/escalation, imported via
        // orchestration-legacy-lifecycle.ts) route through the single write choke too — the
        // wire payload is still a pre-stringified string (payloadValueForGate bridges it, see
        // that function's doc comment on the double-encoding trap).
        const insertedLegacy = this.insertGatedMessage({
          from: principal.terminal_handle,
          to: delivery.to,
          subject: params.message.subject,
          body: params.message.body,
          type: params.message.type,
          priority: params.message.priority,
          payload: payloadValueForGate(params.message.payload),
          senderPaneKey: principal.pane_key,
          senderHostId: 'local',
          runId: principal.run_id,
          deliveryContract: delivery.contract,
          verb: 'send'
        })
        if (insertedLegacy.outcome === 'refused') {
          // Why COMMIT, not ROLLBACK: insertGatedMessage already wrote its own gate_refusals
          // audit row as part of THIS ambient transaction (SQLite has no nested transactions,
          // and this method's own BEGIN IMMEDIATE opened above is still the active one) — a
          // ROLLBACK here would erase that audit row along with it, the same trap
          // peer-question.ts's doc comment on createPeerQuestion calls out. Nothing else has
          // been written yet at this point in the flow, so committing here just persists the
          // refusal audit and applies no other legacy-lifecycle effect.
          this.db.exec('COMMIT')
          throw gateVerdictRefusalError(insertedLegacy.verdict, insertedLegacy.refusalId)
        }
        message = insertedLegacy.message
      }

      let settlement: WorkerReportSettlement | undefined
      if (params.lifecycle.kind === 'heartbeat') {
        this.recordHeartbeat(dispatchId, params.lifecycle.at)
      } else if (params.lifecycle.kind === 'worker_report') {
        const persistedOutcome =
          params.message.existingId &&
          dispatch.task_id === params.lifecycle.taskId &&
          dispatch.status === 'completed'
            ? 'succeeded'
            : params.message.existingId &&
                dispatch.task_id === params.lifecycle.taskId &&
                dispatch.status === 'failed'
              ? 'failed'
              : undefined
        settlement = persistedOutcome
          ? { action: 'settled', outcome: persistedOutcome, duplicate: true }
          : this.settleWorkerReportInTransaction({
              taskId: params.lifecycle.taskId,
              dispatchId,
              outcome: params.lifecycle.outcome,
              result: params.lifecycle.result
            })
        if (settlement.action === 'rejected') {
          throw new OrchestrationError(settlement.code, settlement.reason)
        }
        this.db
          .prepare(
            `UPDATE legacy_compatibility_principals
             SET status = 'settled' WHERE id = ? AND status = 'committed'`
          )
          .run(principal.id)
      }
      const responseJson = JSON.stringify({ messageId: message.id, settlement })
      const receipt = this.insertLegacyOperationReceipt({
        principalId: principal.id,
        operationKey: params.operationKey,
        method: params.method,
        payloadHash: params.payloadHash,
        effectId: message.id,
        responseJson
      })
      this.db.exec('COMMIT')
      return { receipt, message, settlement, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  commitLegacyAskOperation(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    question: string
    options?: string[]
    recipientHandle: string
    existingQuestionId?: string
  }): {
    receipt: LegacyOperationReceiptRow
    question: QuestionRow
    message: MessageRow
    duplicate: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'worker')
      const receipt = this.requireMatchingLegacyOperationReceipt(params)
      if (receipt) {
        const response = JSON.parse(receipt.response_json) as { questionId: string }
        const question = this.getQuestion(response.questionId)
        const message = this.getMessageById(response.questionId)
        if (!question || !message) {
          throw new OrchestrationError(
            'operation_unknown',
            `Legacy ask ${params.operationKey} lost its durable question.`
          )
        }
        this.db.exec('COMMIT')
        return { receipt, question, message, duplicate: true }
      }

      const dispatchId = principal.dispatch_id as string
      const dispatch = this.getDispatchContextById(dispatchId)
      if (
        !dispatch ||
        dispatch.run_id !== principal.run_id ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION ||
        !['pending', 'dispatched'].includes(dispatch.status)
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is not an active legacy attempt.`
        )
      }

      const existingQuestionId =
        params.existingQuestionId &&
        !this.db
          .prepare(
            `SELECT 1 FROM legacy_operation_receipts
             WHERE principal_id = ? AND method = 'orchestration.ask' AND effect_id = ?
             LIMIT 1`
          )
          .get(principal.id, params.existingQuestionId)
          ? params.existingQuestionId
          : undefined
      let question: QuestionRow
      let message: MessageRow
      const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
        principal.run_id,
        params.recipientHandle
      )
      if (existingQuestionId) {
        const existingQuestion = this.getQuestion(existingQuestionId)
        const existingMessage = this.getMessageById(existingQuestionId)
        if (
          !existingQuestion ||
          !existingMessage ||
          existingQuestion.run_id !== principal.run_id ||
          existingQuestion.dispatch_id !== dispatchId ||
          existingQuestion.status !== 'pending' ||
          existingMessage.delivery_contract !== delivery.contract ||
          !legacyMessageMatchesQuestion(existingMessage, params.question, params.options ?? [], [
            delivery.to
          ])
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Question ${params.existingQuestionId} is not a pending ask for this principal.`
          )
        }
        question = existingQuestion
        message = existingMessage
      } else {
        message = this.insertMessage({
          from: principal.terminal_handle,
          to: delivery.to,
          subject: 'Question',
          body: params.question,
          type: delivery.contract === 'legacy_direct' ? 'decision_gate' : 'question',
          payload: JSON.stringify({
            taskId: dispatch.task_id,
            dispatchId,
            question: params.question,
            options: params.options ?? []
          }),
          senderPaneKey: principal.pane_key,
          runId: principal.run_id,
          deliveryContract: delivery.contract
        })
        this.db
          .prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
          .run(message.id, message.id)
        this.db
          .prepare(
            `INSERT INTO question_threads (
               message_id, run_id, dispatch_id, asker_handle
             ) VALUES (?, ?, ?, ?)`
          )
          .run(message.id, principal.run_id, dispatchId, principal.terminal_handle)
        question = this.getQuestion(message.id) as QuestionRow
        message = this.getMessageById(message.id) as MessageRow
      }

      const committedReceipt = this.insertLegacyOperationReceipt({
        principalId: principal.id,
        operationKey: params.operationKey,
        method: params.method,
        payloadHash: params.payloadHash,
        effectId: question.message_id,
        responseJson: JSON.stringify({ questionId: question.message_id })
      })
      this.db.exec('COMMIT')
      return { receipt: committedReceipt, question, message, duplicate: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  findPendingLegacyQuestions(params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }): { question: QuestionRow; message: MessageRow }[] {
    return this.findLegacyQuestionsBySemanticIdentity(params)
      .filter((row) => row.question.status === 'pending')
      .map(({ question, message }) => ({ question, message }))
  }

  findLegacyQuestionsBySemanticIdentity(params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }): {
    question: QuestionRow
    message: MessageRow
    answerAcknowledged: boolean
    claimedByOperation: boolean
  }[] {
    const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'worker')
    const runAddress = `run:${principal.run_id}`
    const rows = this.db
      .prepare(
        `SELECT q.*, m.id AS source_message_id,
                EXISTS(
                  SELECT 1 FROM legacy_operation_receipts lor
                  WHERE lor.principal_id = ? AND lor.method = 'orchestration.ask'
                    AND lor.effect_id = q.message_id
                ) AS claimed_by_operation
         FROM question_threads q
         INNER JOIN messages m ON m.id = q.message_id
         WHERE q.run_id = ? AND q.dispatch_id = ?
           AND (
             (m.delivery_contract = 'legacy_direct' AND m.to_handle = ?) OR
             (m.delivery_contract = 'current_delivery' AND m.to_handle = ?)
           )
         ORDER BY m.sequence
         LIMIT 501`
      )
      .all(
        principal.id,
        principal.run_id,
        principal.dispatch_id,
        params.recipientHandle,
        runAddress
      ) as (QuestionRow & {
      source_message_id: string
      claimed_by_operation: number
    })[]
    if (rows.length > 500) {
      throw new OrchestrationError(
        'operation_unknown',
        'Legacy ask identity is too ambiguous to reconstruct safely.'
      )
    }
    return rows
      .filter((row) => {
        const message = this.getMessageById(row.source_message_id)
        return Boolean(
          message &&
          legacyMessageMatchesQuestion(message, params.question, params.options ?? [], [
            params.recipientHandle,
            runAddress
          ])
        )
      })
      .map((row) => ({
        question: exposeQuestionTimestamps(row),
        message: this.getMessageById(row.message_id) as MessageRow,
        claimedByOperation: row.claimed_by_operation === 1,
        answerAcknowledged: row.answer_message_id
          ? Boolean(
              this.db
                .prepare(
                  `SELECT 1 FROM legacy_mail_receipts
                   WHERE principal_id = ? AND message_id = ?
                     AND acknowledged_at IS NOT NULL`
                )
                .get(principal.id, row.answer_message_id)
            )
          : false
      }))
  }

  private resolveLegacyWorkerCoordinatorDelivery(
    runId: string,
    retainedCoordinatorHandle: string
  ): { to: string; contract: MessageDeliveryContract } {
    const run = this.getRunRaw(runId)
    const principal = this.getLegacyCoordinatorPrincipal(runId)
    const takenOver = run?.coordinator_handle !== null && principal?.status !== 'committed'
    return takenOver
      ? { to: `run:${runId}`, contract: 'current_delivery' }
      : { to: retainedCoordinatorHandle, contract: 'legacy_direct' }
  }

  commitLegacyReplyOperation(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    questionId: string
    body: string
  }): {
    receipt: LegacyOperationReceiptRow
    question: QuestionRow
    message: MessageRow
    duplicate: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'coordinator')
      const receipt = this.requireMatchingLegacyOperationReceipt(params)
      if (receipt) {
        const response = JSON.parse(receipt.response_json) as {
          questionId: string
          messageId: string
        }
        const question = this.getQuestion(response.questionId)
        const message = this.getMessageById(response.messageId)
        if (!question || !message) {
          throw new OrchestrationError(
            'operation_unknown',
            `Legacy reply ${params.operationKey} lost its durable effect.`
          )
        }
        this.db.exec('COMMIT')
        return { receipt, question, message, duplicate: true }
      }

      const question = this.getQuestionRaw(params.questionId)
      const sourceMessage = this.getMessageById(params.questionId)
      const dispatch = question ? this.getDispatchContextById(question.dispatch_id) : undefined
      if (
        !question ||
        !sourceMessage ||
        !dispatch ||
        question.run_id !== principal.run_id ||
        sourceMessage.delivery_contract !== 'legacy_direct' ||
        dispatch.run_id !== principal.run_id ||
        dispatch.contract_version !== LEGACY_CONTRACT_VERSION ||
        question.status === 'closed'
      ) {
        throw new OrchestrationError(
          'question_not_found',
          `Question ${params.questionId} is not actionable in the adopted Run.`
        )
      }
      let message: MessageRow
      if (question.status === 'answered') {
        if (question.answer_body !== params.body || !question.answer_message_id) {
          throw new OrchestrationError(
            'answer_conflict',
            `Question ${params.questionId} already has a different answer.`
          )
        }
        message = this.getMessageById(question.answer_message_id) as MessageRow
        if (
          !message ||
          message.run_id !== principal.run_id ||
          message.delivery_contract !== 'legacy_direct'
        ) {
          throw new OrchestrationError(
            'operation_unknown',
            `Question ${params.questionId} lost its recorded answer message.`
          )
        }
      } else {
        message = this.insertMessage({
          from: principal.terminal_handle,
          to: question.asker_handle,
          subject: 'Re: Question',
          body: params.body,
          threadId: question.message_id,
          runId: principal.run_id,
          deliveryContract: 'legacy_direct'
        })
        this.markAsRead([question.message_id])
        this.db
          .prepare(
            `UPDATE question_threads
             SET status = 'answered', answer_message_id = ?, answer_body = ?,
                 answered_at = datetime('now')
             WHERE message_id = ? AND status = 'pending'`
          )
          .run(message.id, params.body, question.message_id)
      }

      const answered = this.getQuestion(params.questionId) as QuestionRow
      const committedReceipt = this.insertLegacyOperationReceipt({
        principalId: principal.id,
        operationKey: params.operationKey,
        method: params.method,
        payloadHash: params.payloadHash,
        effectId: message.id,
        responseJson: JSON.stringify({
          questionId: answered.message_id,
          messageId: message.id
        })
      })
      this.db.exec('COMMIT')
      return {
        receipt: committedReceipt,
        question: answered,
        message,
        duplicate: question.status === 'answered'
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private requireMatchingLegacyOperationReceipt(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
  }): LegacyOperationReceiptRow | undefined {
    const receipt = this.getLegacyOperationReceipt(params.principalId, params.operationKey)
    if (
      receipt &&
      (receipt.method !== params.method || receipt.payload_hash !== params.payloadHash)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy operation ${params.operationKey} was already used with different input.`
      )
    }
    return receipt
  }

  private insertLegacyOperationReceipt(params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    effectId: string
    responseJson: string
  }): LegacyOperationReceiptRow {
    this.db
      .prepare(
        `INSERT INTO legacy_operation_receipts (
           principal_id, operation_key, method, payload_hash, effect_id, response_json
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.principalId,
        params.operationKey,
        params.method,
        params.payloadHash,
        params.effectId,
        params.responseJson
      )
    return this.getLegacyOperationReceipt(
      params.principalId,
      params.operationKey
    ) as LegacyOperationReceiptRow
  }

  // Why the live-message clause here (amendment E, PURGE §): getUnreadMessages backs
  // orchestration.check for every mailbox shape (run/dispatch/agent/bare-handle) — filtering
  // in SQL, not in the RPC formatter, is what keeps a purged body or a quarantined author's row
  // from ever reaching a --json caller.
  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages
             WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
               AND type IN (${placeholders}) AND ${liveMessageSqlClause()} ORDER BY sequence`
          )
          .all(toHandle, ...types) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
             AND ${liveMessageSqlClause()}
           ORDER BY sequence`
        )
        .all(toHandle) as MessageRow[]
    )
  }

  // Why: the heartbeat mail hint needs a count only; loading a whole dispatch mailbox page to length it would be waste.
  countUnreadMessages(toHandle: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'`
      )
      .get(toHandle) as { count: number } | undefined
    return row?.count ?? 0
  }

  convertLifecycleMessageToRejection(
    messageId: string,
    code: string,
    reason: string
  ): MessageRow | undefined {
    const message = this.getMessageById(messageId)
    if (!message || (message.type !== 'worker_done' && message.type !== 'heartbeat')) {
      return message
    }

    const originalBody = message.body ? `\n\nOriginal body:\n${message.body}` : ''
    const body = `Orca rejected this ${message.type}: ${reason}${originalBody}`
    const payload = addLifecycleRejectionMarker(message.payload, code, reason)
    // Why: rejected lifecycle signals stay auditable but must not reach read paths as actionable completion/liveness events.
    this.db
      .prepare(
        `UPDATE messages
         SET priority = 'high', subject = ?, body = ?, payload = ?
         WHERE id = ?`
      )
      .run(`Rejected ${message.type}: ${message.subject}`, body, payload, messageId)
    return this.getMessageById(messageId)
  }

  // Why: delivered_at IS NULL filter — push-on-idle delivers each row at most once; read (set only by check) wouldn't prevent replay.
  // Live-message clause (amendment E): this result feeds the ambient pane push
  // (deliverPendingMessagesForHandle) — a purged/withheld row must never be typed into a pane.
  getUndeliveredUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages
             WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL
               AND delivery_contract = 'current_delivery'
               AND type IN (${placeholders}) AND ${liveMessageSqlClause()} ORDER BY sequence`
          )
          .all(toHandle, ...types) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages
           WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL
             AND delivery_contract = 'current_delivery'
             AND ${liveMessageSqlClause()}
           ORDER BY sequence`
        )
        .all(toHandle) as MessageRow[]
    )
  }

  // Why: a bare terminal handle owns no run/dispatch mailbox row to resolve
  // through (BUG 6) — its durable address is the pane key recorded on the
  // messages already addressed to it, so the most recent one wins.
  getRecipientPaneKeyForBareHandle(handle: string): string | null {
    const row = this.db
      .prepare(
        `SELECT recipient_pane_key FROM messages
         WHERE to_handle = ? AND recipient_pane_key IS NOT NULL
         ORDER BY sequence DESC LIMIT 1`
      )
      .get(handle) as { recipient_pane_key: string | null } | undefined
    return row?.recipient_pane_key ?? null
  }

  getUndeliveredUnreadMailboxHandles(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT to_handle FROM messages
           WHERE read = 0 AND delivered_at IS NULL
             AND delivery_contract = 'current_delivery'
             AND ${liveMessageSqlClause()}`
        )
        .all() as { to_handle: string }[]
    ).map((row) => row.to_handle)
  }

  getAllMessages(toHandle: string, limit = 20): MessageRow[] {
    return exposeMessageListTimestamps(
      this.db
        .prepare('SELECT * FROM messages WHERE to_handle = ? ORDER BY sequence DESC LIMIT ?')
        .all(toHandle, limit) as MessageRow[]
    )
  }

  getMessageById(id: string): MessageRow | undefined {
    const message = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return message ? exposeMessageTimestamps(message) : undefined
  }

  markAsRead(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`).run(...ids)
  }

  // Why: use datetime('now') so delivered_at matches the space-format UTC shape of the table's other timestamps for correct ordering (§3.2).
  markAsDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE messages SET delivered_at = datetime('now') WHERE id IN (${placeholders})`)
      .run(...ids)
  }

  markAsReadAndDelivered(ids: string[]): void {
    if (ids.length === 0) {
      return
    }
    const placeholders = ids.map(() => '?').join(',')
    // Why: superseded lifecycle messages stay in history but must not be consumed or injected after their dispatch finished.
    this.db
      .prepare(
        `UPDATE messages SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now')) WHERE id IN (${placeholders})`
      )
      .run(...ids)
  }

  // Live-message clause (amendment E): orchestration.inbox with no --terminal/--thread-id
  // passthrough — a purged/withheld row must not leak through the bare operator inbox either.
  getInbox(limit = 20): MessageRow[] {
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE ${liveMessageSqlClause()} ORDER BY sequence DESC LIMIT ?`
        )
        .all(limit) as MessageRow[]
    )
  }

  // Why: read-only history for a handle — returns every message regardless of read/delivered state, never flips the read bit (§3.3).
  getAllMessagesForHandle(toHandle: string, limit = 100, types?: MessageType[]): MessageRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',')
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE to_handle = ? AND type IN (${placeholders})
             AND ${liveMessageSqlClause()} ORDER BY sequence DESC LIMIT ?`
          )
          .all(toHandle, ...types, limit) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE to_handle = ? AND ${liveMessageSqlClause()}
           ORDER BY sequence DESC LIMIT ?`
        )
        .all(toHandle, limit) as MessageRow[]
    )
  }

  // Why: ask wait-loop read — to_handle filter shows only replies to the worker; afterSequence resumes past its own outbound ask.
  // F-1 (Ruling 32(b)): `toHandle` accepts one or more addresses — a degraded (non-participant)
  // reader must match BOTH the caller's bare terminal handle and its durable `agent:<id>` form,
  // because every peer-relayed (foreign-origin) row is addressed ONLY as `agent:<id>` (never a
  // bare terminal handle) — filtering by the bare handle alone silently excluded every one of
  // them (orchestration-thread.ts's degrade path was the only caller).
  getThreadMessagesFor(
    threadId: string,
    toHandle: string | readonly string[],
    afterSequence?: number
  ): MessageRow[] {
    const toHandles = Array.isArray(toHandle) ? toHandle : [toHandle as string]
    const placeholders = toHandles.map(() => '?').join(',')
    if (afterSequence !== undefined) {
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE thread_id = ? AND to_handle IN (${placeholders}) AND sequence > ?
             AND ${liveMessageSqlClause()} ORDER BY sequence ASC`
          )
          .all(threadId, ...toHandles, afterSequence) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE thread_id = ? AND to_handle IN (${placeholders})
           AND ${liveMessageSqlClause()} ORDER BY sequence ASC`
        )
        .all(threadId, ...toHandles) as MessageRow[]
    )
  }

  // Why unfiltered by to_handle (unlike getThreadMessagesFor above): `orchestration thread`
  // replays every participant's side of the conversation, not one recipient's inbox (BUG 4).
  // Why `sequence` and not `created_at` (S10-0 review minor): `created_at` has whole-second
  // resolution, so two messages sent in the same wall-clock second are indistinguishable by
  // timestamp and a resume cursor built from one can silently re-include or drop the other.
  // `sequence` is the monotonic AUTOINCREMENT column — always a strict total order. Both cursor
  // shapes are accepted for one release (thread-replay-since-filter.ts) so an old client's/host's
  // own printed `created_at` cursor keeps resuming correctly (remote-wire-compatibility).
  getThreadMessages(threadId: string, since?: ThreadSinceCursor): MessageRow[] {
    if (since?.kind === 'sequence') {
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE thread_id = ? AND sequence > ?
             AND ${liveMessageSqlClause()} ORDER BY sequence ASC`
          )
          .all(threadId, since.value) as MessageRow[]
      )
    }
    if (since?.kind === 'timestamp') {
      return exposeMessageListTimestamps(
        this.db
          .prepare(
            `SELECT * FROM messages WHERE thread_id = ? AND created_at > ?
             AND ${liveMessageSqlClause()} ORDER BY sequence ASC`
          )
          .all(threadId, since.value) as MessageRow[]
      )
    }
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE thread_id = ? AND ${liveMessageSqlClause()} ORDER BY sequence ASC`
        )
        .all(threadId) as MessageRow[]
    )
  }

  // F-11 pt.2 (Ruling 32(b)): the "no addressee" reply refusal's local-evidence recovery. Every
  // row THIS host sent outbound over a peer link carries `peer_agent_id` (the addressee it went
  // to); `peer_link_device_id` marks an INBOUND-imported row only (db.ts's own messages column
  // comment), so excluding it here means these are never peer-supplied values — the host wrote
  // every one itself. Distinct, so the caller can tell "exactly one" from "more than one".
  // F-9 item (b) (delta review, Ruling 32 Addendum 9): scoped to `environmentId` — the LINK the
  // reply is actually being routed over (the INBOUND row's binding, per the caller in
  // orchestration.ts) — not every outbound row on the thread regardless of link. An outbound
  // row's `to_handle` is always `remote:<environmentId>:<peerAgentId>`
  // (orchestration-peer-send-relay.ts), so this is the same address shape that row was written
  // with. Without this scope, an unattributed inbound row from peer Y on a thread that also
  // carries this host's own outbound rows to a DIFFERENT peer X recovered X's id as the
  // addressee for a reply meant for Y.
  getOwnOutboundPeerAgentIdsForThread(threadId: string, environmentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT peer_agent_id FROM messages
         WHERE thread_id = ? AND peer_link_device_id IS NULL AND peer_agent_id IS NOT NULL
         AND to_handle LIKE 'remote:' || ? || ':%'
         AND ${liveMessageSqlClause()}`
      )
      .all(threadId, environmentId) as { peer_agent_id: string }[]
    return rows.map((row) => row.peer_agent_id)
  }

  // Adversarial review S10-2b major #5 fix: getThreadMessages/getThreadMessagesFor above filter
  // purged/quarantine-withheld rows straight in SQL (liveMessageSqlClause) but never counted
  // what they excluded — resolveThreadReplay (orchestration-thread.ts) declares an `omitted`
  // field on its return type and had no way to populate it. Same cursor/to_handle shape as
  // whichever of the two queries the caller just ran, so the counts match exactly what that
  // query excluded. Two separate COUNT queries (not a single CASE-summed one) so a row that is
  // both purged AND from a quarantined sender is never double-counted: the withheld count
  // explicitly excludes purged rows, same split as getThreadMessagesSince (thread-directory.ts).
  // F-1: `toHandle` accepts one or more addresses — see getThreadMessagesFor's own note; the
  // omitted count must be taken over the same address set the degraded read actually queried,
  // or "N withheld" could report a number the caller's own read never corroborates.
  getThreadMessagesOmitted(
    threadId: string,
    since?: ThreadSinceCursor,
    toHandle?: string | readonly string[]
  ): { purged: number; withheld: number } {
    const cursorClause =
      since?.kind === 'sequence'
        ? 'AND sequence > ?'
        : since?.kind === 'timestamp'
          ? 'AND created_at > ?'
          : ''
    const cursorArgs = since ? [since.value] : []
    const toHandles = toHandle === undefined ? [] : Array.isArray(toHandle) ? toHandle : [toHandle]
    const toHandleClause =
      toHandles.length > 0 ? `AND to_handle IN (${toHandles.map(() => '?').join(',')})` : ''
    const toHandleArgs = toHandles
    const purged = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE thread_id = ? ${toHandleClause} ${cursorClause} AND purged_at IS NOT NULL`
        )
        .get(threadId, ...toHandleArgs, ...cursorArgs) as { n: number }
    ).n
    const withheld = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE thread_id = ? ${toHandleClause} ${cursorClause} AND purged_at IS NULL
             AND (sender_agent_id IN (SELECT id FROM agents WHERE quarantined = 1)
               OR ${remoteSenderQuarantinedSqlClause('from_handle')})`
        )
        .get(threadId, ...toHandleArgs, ...cursorArgs) as { n: number }
    ).n
    return { purged, withheld }
  }

  createQuestion(params: {
    runId: string
    dispatchId: string
    askerHandle: string
    question: string
    options?: string[]
  }): { question: QuestionRow; message: MessageRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireRun(params.runId)
      const dispatch = this.getDispatchContextById(params.dispatchId)
      if (
        !dispatch ||
        dispatch.run_id !== params.runId ||
        (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${params.dispatchId} is not active in Run ${params.runId}.`
        )
      }
      const message = this.insertMessage({
        from: `dispatch:${params.dispatchId}`,
        to: `run:${params.runId}`,
        subject: 'Question',
        body: params.question,
        type: 'question',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          question: params.question,
          options: params.options ?? []
        }),
        runId: params.runId
      })
      this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(message.id, message.id)
      this.db
        .prepare(
          `INSERT INTO question_threads (
             message_id, run_id, dispatch_id, asker_handle
           ) VALUES (?, ?, ?, ?)`
        )
        .run(message.id, params.runId, params.dispatchId, params.askerHandle)
      const question = this.getQuestionRaw(message.id) as QuestionRow
      const storedMessage = this.getMessageById(message.id) as MessageRow
      this.db.exec('COMMIT')
      return { question: exposeQuestionTimestamps(question), message: storedMessage }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getQuestion(messageId: string): QuestionRow | undefined {
    const question = this.getQuestionRaw(messageId)
    return question ? exposeQuestionTimestamps(question) : undefined
  }

  private getQuestionRaw(messageId: string): QuestionRow | undefined {
    return this.db.prepare('SELECT * FROM question_threads WHERE message_id = ?').get(messageId) as
      | QuestionRow
      | undefined
  }

  answerQuestion(params: {
    messageId: string
    runId: string
    consumerGeneration: number
    body: string
  }): { question: QuestionRow; message: MessageRow; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.requireCurrentConsumer(params.runId, params.consumerGeneration)
      const question = this.getQuestionRaw(params.messageId)
      if (!question || question.run_id !== params.runId) {
        throw new OrchestrationError(
          'question_not_found',
          `Question ${params.messageId} was not found in Run ${params.runId}.`
        )
      }
      if (question.status === 'closed') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Question ${params.messageId} is closed because its Dispatch is inactive.`
        )
      }
      if (question.status === 'answered') {
        // T7 / PURGE § ruling 10: a purged answer blanks answer_body to '' and stores
        // answer_body_sha256 first — an ordinary at-least-once retry of the ORIGINAL body must
        // still dedup to `duplicate:true`, not throw answer_conflict just because the live
        // column no longer holds the text to compare against.
        const purgedMatch =
          question.answer_purged_at != null &&
          question.answer_body_sha256 ===
            createHash('sha256').update(params.body, 'utf8').digest('hex')
        if (!purgedMatch && question.answer_body !== params.body) {
          throw new OrchestrationError(
            'answer_conflict',
            `Question ${params.messageId} already has a different answer.`
          )
        }
        if (!question.answer_message_id) {
          throw new OrchestrationError(
            'answer_conflict',
            `Question ${params.messageId} already has a different answer.`
          )
        }
        const message = this.getMessageById(question.answer_message_id)
        if (!message) {
          throw new Error(`Recorded answer message ${question.answer_message_id} was not found.`)
        }
        this.db.exec('COMMIT')
        return { question: exposeQuestionTimestamps(question), message, duplicate: true }
      }

      const message = this.insertMessage({
        from: `run:${params.runId}`,
        to: `dispatch:${question.dispatch_id}`,
        subject: 'Re: Question',
        body: params.body,
        threadId: question.message_id,
        runId: params.runId
      })
      // Why: ask returns thread state directly; leaving its answer unread would deliver it again via check.
      this.markAsRead([message.id])
      this.db
        .prepare(
          `UPDATE question_threads
           SET status = 'answered', answer_message_id = ?, answer_body = ?,
               answered_by_generation = ?, answered_at = datetime('now')
           WHERE message_id = ? AND status = 'pending'`
        )
        .run(message.id, params.body, params.consumerGeneration, question.message_id)
      const answered = this.getQuestionRaw(question.message_id) as QuestionRow
      const storedMessage = this.getMessageById(message.id) as MessageRow
      this.db.exec('COMMIT')
      return {
        question: exposeQuestionTimestamps(answered),
        message: storedMessage,
        duplicate: false
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  closeQuestionsForDispatch(dispatchId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT message_id FROM question_threads WHERE dispatch_id = ? AND status = 'pending'"
      )
      .all(dispatchId) as { message_id: string }[]
    if (rows.length === 0) {
      return []
    }
    this.db
      .prepare(
        "UPDATE question_threads SET status = 'closed', closed_at = datetime('now') WHERE dispatch_id = ? AND status = 'pending'"
      )
      .run(dispatchId)
    return rows.map((row) => row.message_id)
  }

  // ── Tasks ──

  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    createdByPaneKey?: string
    createdByProcessIncarnation?: string
    createdByRunGeneration?: number
    runId?: string
  }): TaskRow {
    const runId = task.runId ?? LEGACY_RUN_ID
    this.requireRun(runId)
    if (task.parentId) {
      const parent = this.getTask(task.parentId)
      if (!parent || parent.run_id !== runId) {
        throw new Error(`Parent task ${task.parentId} must belong to run ${runId}`)
      }
    }
    for (const depId of task.deps ?? []) {
      const dependency = this.getTask(depId)
      if (!dependency || dependency.run_id !== runId) {
        throw new Error(`Dependency task ${depId} must belong to run ${runId}`)
      }
    }
    const id = generateId('task')
    const depsJson = JSON.stringify(task.deps ?? [])
    const display = buildOrchestrationTaskDisplayMetadata({
      spec: task.spec,
      taskTitle: task.taskTitle,
      displayName: task.displayName
    })
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, run_id, parent_id, created_by_terminal_handle, created_by_pane_key,
           created_by_process_incarnation, created_by_run_generation,
           task_title, display_name, spec, status, deps
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN EXISTS (
             SELECT 1
             FROM json_each(?) requested
             LEFT JOIN tasks dependency ON dependency.id = requested.value
             WHERE dependency.id IS NULL
                OR dependency.run_id <> ?
                OR dependency.status <> 'completed'
           ) THEN 'pending' ELSE 'ready' END,
           ?
         )`
      )
      .run(
        id,
        runId,
        task.parentId ?? null,
        task.createdByTerminalHandle ?? null,
        task.createdByPaneKey ?? null,
        task.createdByProcessIncarnation ?? null,
        task.createdByRunGeneration ?? null,
        display.taskTitle || null,
        display.displayName || null,
        task.spec,
        depsJson,
        runId,
        depsJson
      )
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
  }

  // Why: return the active creator Dispatch proof with the Task read; runtime still owns pane/process currency.
  getTask(id: string): TaskRow | undefined
  getTask(id: string, dispatchRunId: string): TaskRuntimeLineageRow | undefined
  getTask(id: string, dispatchRunId?: string): TaskRow | TaskRuntimeLineageRow | undefined {
    if (dispatchRunId === undefined) {
      return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    }
    return this.db
      .prepare(
        `SELECT t.*,
           creator.id AS creator_dispatch_id,
           creator.run_id AS creator_dispatch_run_id,
           creator.assignee_pane_key AS creator_dispatch_pane_key,
           creator.process_incarnation AS creator_dispatch_process_incarnation
         FROM tasks t
         LEFT JOIN dispatch_contexts creator ON creator.rowid = (
           SELECT candidate.rowid
           FROM dispatch_contexts candidate
           WHERE candidate.assignee_handle = t.created_by_terminal_handle
             AND candidate.run_id = ?
             AND candidate.status IN ('pending', 'dispatched')
           ORDER BY candidate.rowid DESC
           LIMIT 1
         )
         WHERE t.id = ?`
      )
      .get(dispatchRunId, id) as TaskRuntimeLineageRow | undefined
  }

  listTasks(filter?: { status?: TaskStatus; ready?: boolean; runId?: string }): TaskRow[] {
    const runWhere = filter?.runId ? 'run_id = ? AND ' : ''
    const runParams: Database.BindValue[] = filter?.runId ? [filter.runId] : []
    if (filter?.ready) {
      return this.db
        .prepare(`SELECT * FROM tasks WHERE ${runWhere}status = 'ready' ORDER BY created_at`)
        .all(...runParams) as TaskRow[]
    }
    if (filter?.status) {
      return this.db
        .prepare(`SELECT * FROM tasks WHERE ${runWhere}status = ? ORDER BY created_at`)
        .all(...runParams, filter.status) as TaskRow[]
    }
    if (filter?.runId) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at')
        .all(filter.runId) as TaskRow[]
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[]
  }

  // Why: the correlated indexed lookup avoids materializing every retained Dispatch before filtering Tasks.
  listTasksWithDispatch(filter?: {
    status?: TaskStatus
    ready?: boolean
    runId?: string
  }): (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[] {
    const whereClauses: string[] = []
    const params: Database.BindValue[] = []
    if (filter?.runId) {
      whereClauses.push('t.run_id = ?')
      params.push(filter.runId)
    }
    if (filter?.ready) {
      whereClauses.push("t.status = 'ready'")
    } else if (filter?.status) {
      whereClauses.push('t.status = ?')
      params.push(filter.status)
    }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
    const sql = `
      SELECT
        t.*,
        d.assignee_handle AS assignee_handle,
        d.id              AS dispatch_id
      FROM tasks t
      LEFT JOIN dispatch_contexts d ON d.rowid = (
        SELECT candidate.rowid
        FROM dispatch_contexts candidate
        WHERE candidate.task_id = t.id
          AND candidate.status IN ('pending', 'dispatched')
        ORDER BY candidate.rowid DESC
        LIMIT 1
      )
      ${where}
      ORDER BY t.created_at
    `
    return this.db.prepare(sql).all(...params) as (TaskRow & {
      assignee_handle: string | null
      dispatch_id: string | null
    })[]
  }

  updateTaskStatus(id: string, status: TaskStatus, result?: string): TaskRow | undefined {
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    this.db
      .prepare(
        'UPDATE tasks SET status = ?, result = COALESCE(?, result), completed_at = COALESCE(?, completed_at) WHERE id = ?'
      )
      .run(status, result ?? null, completedAt, id)

    if (status === 'completed') {
      this.promoteReadyTasks(id)
      this.completeActiveDispatchForTask(id)
    }

    return this.getTask(id)
  }

  // Why: runs in the status-update transaction, so a completed task never leaves its ready children unpromoted.
  private promoteReadyTasks(completedTaskId: string): void {
    const candidates = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'pending'")
      .all() as TaskRow[]

    for (const task of candidates) {
      const deps: string[] = JSON.parse(task.deps)
      if (!deps.includes(completedTaskId)) {
        continue
      }

      const allDepsCompleted = deps.every((depId) => {
        const dep = this.getTask(depId)
        return dep?.status === 'completed'
      })
      if (allDepsCompleted) {
        this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      }
    }
  }

  // ── Dispatch Contexts ──

  createStartingWorkerDispatch(params: {
    taskId: string
    startOptions: unknown
    launchTokenHash?: string
    retryOf?: string
    runtimeEpoch?: string
    federation?: {
      environmentId: string
      environmentName: string
      peerFingerprint: string
      protocolVersion: number
    }
    mutationReceipt?: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }): { dispatch: DispatchContextRow; worker: WorkerDispatchRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (params.mutationReceipt) {
        const receipt = params.mutationReceipt
        const existing = this.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)
        if (existing) {
          if (existing.method !== receipt.method || existing.payload_hash !== receipt.payloadHash) {
            throw new OrchestrationError(
              'request_mismatch',
              `Mutation request ${receipt.requestId} was already used with different input.`
            )
          }
          throw new OrchestrationError(
            'operation_unknown',
            `Mutation ${receipt.requestId} already has a durable acceptance record.`
          )
        }
        ensureMutationReceiptCapacity(this.db)
        this.db
          .prepare(
            `INSERT INTO mutation_receipts (
               caller_fingerprint, request_id, method, payload_hash, state
             ) VALUES (?, ?, ?, ?, 'pending')`
          )
          .run(receipt.callerFingerprint, receipt.requestId, receipt.method, receipt.payloadHash)
      }
      const task = this.getTask(params.taskId)
      if (!task) {
        throw new OrchestrationError('task_not_found', `Task ${params.taskId} was not found.`)
      }
      if (params.retryOf) {
        const prior = this.getDispatchContextById(params.retryOf)
        const priorWorker = this.getWorkerDispatch(params.retryOf)
        const latest = this.getDispatchContext(task.id)
        if (
          !prior ||
          prior.task_id !== task.id ||
          latest?.id !== prior.id ||
          !priorWorker ||
          !['failed', 'stopped', 'abandoned'].includes(priorWorker.state) ||
          !['failed', 'blocked'].includes(task.status)
        ) {
          throw new OrchestrationError(
            'task_not_startable',
            `Task ${task.id} cannot retry from Dispatch ${params.retryOf}.`
          )
        }
      } else if (task.status !== 'ready') {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${task.id} is ${task.status}; only a ready Task can start.`
        )
      }

      const id = generateId('ctx')
      if (params.mutationReceipt) {
        this.db
          .prepare(
            `UPDATE mutation_receipts
             SET receipt = ?, updated_at = datetime('now')
             WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
          )
          .run(
            JSON.stringify({ accepted: { dispatchId: id } }),
            params.mutationReceipt.callerFingerprint,
            params.mutationReceipt.requestId
          )
      }
      this.db
        .prepare(
          `INSERT INTO dispatch_contexts (
             id, run_id, task_id, contract_version, launch_token_hash, status, dispatched_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`
        )
        .run(id, task.run_id, task.id, CURRENT_CONTRACT_VERSION, params.launchTokenHash ?? null)
      this.db
        .prepare(
          `INSERT INTO worker_dispatches (
             dispatch_id, runtime_epoch, state, stage, start_options
           ) VALUES (?, ?, 'starting', 'accepted', ?)`
        )
        .run(id, params.runtimeEpoch ?? null, JSON.stringify(params.startOptions))
      if (params.federation) {
        this.db
          .prepare(
            `INSERT INTO federated_dispatches (
               dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
             ) VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            id,
            params.federation.environmentId,
            params.federation.environmentName,
            params.federation.peerFingerprint,
            params.federation.protocolVersion
          )
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'dispatched', result = NULL, completed_at = NULL WHERE id = ?"
        )
        .run(task.id)
      this.db.exec('COMMIT')
      return {
        dispatch: this.getDispatchContextById(id) as DispatchContextRow,
        worker: this.getWorkerDispatch(id) as WorkerDispatchRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordWorkerStage(params: {
    dispatchId: string
    stage: string
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
    state?: WorkerDispatchState
  }): WorkerDispatchRow {
    const current = this.getWorkerDispatch(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${params.dispatchId} was not found.`
      )
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET stage = ?, state = ?, worktree_id = ?, agent_terminal_handle = ?,
             setup_state = ?, effects = ?, residual_resources = ?, last_error = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(
        params.stage,
        params.state ?? current.state,
        params.worktreeId ?? current.worktree_id,
        params.terminalHandle ?? current.agent_terminal_handle,
        params.setupState ?? current.setup_state,
        params.effects ? JSON.stringify(params.effects) : current.effects,
        params.residualResources
          ? JSON.stringify(params.residualResources)
          : current.residual_resources,
        params.lastError ?? current.last_error,
        params.dispatchId
      )
    return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
  }

  updateWorkerSetupEvidence(params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }): { worker: WorkerDispatchRow; changed: boolean } {
    const current = this.getWorkerDispatch(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${params.dispatchId} was not found.`
      )
    }
    const effects = JSON.stringify(params.effects)
    if (current.setup_state === params.setupState && current.effects === effects) {
      return { worker: current, changed: false }
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET setup_state = ?, effects = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(params.setupState, effects, params.dispatchId)
    return {
      worker: this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow,
      changed: true
    }
  }

  prepareStartingWorkerAuthority(params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    launchTokenHash?: string
    worktreeId: string
    effects: unknown[]
    setupState: string
    hostScope?: string | null
    // 'created': this worker-start operation created the agent terminal (including agent-first
    // worktree creation, whose effects receipt says 'reused_agent_terminal'). 'external': an
    // explicit --terminal reuse; ownership transfers only from an exact owned settled resource.
    terminalOwnership?: 'created' | 'external'
  }): string {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not starting.`
      )
    }
    if (
      dispatch.launch_token_hash &&
      params.launchTokenHash &&
      dispatch.launch_token_hash !== params.launchTokenHash
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${params.dispatchId} already has a different launch-token commitment.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?,
               capability_hash = ?, launch_token_hash = COALESCE(launch_token_hash, ?),
               capability_revoked_at = NULL
           WHERE id = ? AND status = 'pending'`
        )
        .run(
          params.handle,
          params.paneKey,
          params.processIncarnation,
          hashDispatchCapability(capability),
          params.launchTokenHash ?? null,
          params.dispatchId
        )
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET stage = 'authority_attached', worktree_id = ?, agent_terminal_handle = ?,
               setup_state = ?, effects = ?, residual_resources = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'starting'`
        )
        .run(
          params.worktreeId,
          params.handle,
          params.setupState,
          JSON.stringify(params.effects),
          JSON.stringify(
            params.effects.filter((effect) =>
              Boolean(
                effect &&
                typeof effect === 'object' &&
                ((effect as { action?: string }).action?.startsWith('created') ||
                  (effect as { action?: string }).action === 'reused_agent_terminal')
              )
            )
          ),
          params.dispatchId
        )
      if (params.terminalOwnership && !this.getWorkerTerminalResourceByOwner(params.dispatchId)) {
        if (params.terminalOwnership === 'created') {
          this.createWorkerTerminalResourceStatement({
            dispatchId: params.dispatchId,
            worktreeId: params.worktreeId,
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope,
            ownership: 'owned'
          })
        } else {
          const transferable = this.findTransferableWorkerTerminalResource({
            terminalHandle: params.handle,
            paneKey: params.paneKey,
            processIncarnation: params.processIncarnation,
            hostScope: params.hostScope ?? null
          })
          if (transferable) {
            this.transferWorkerTerminalResourceStatement({
              resourceId: transferable.id,
              toDispatchId: params.dispatchId,
              terminalHandle: params.handle,
              paneKey: params.paneKey,
              processIncarnation: params.processIncarnation,
              hostScope: params.hostScope ?? null
            })
          } else {
            this.createWorkerTerminalResourceStatement({
              dispatchId: params.dispatchId,
              worktreeId: params.worktreeId,
              terminalHandle: params.handle,
              paneKey: params.paneKey,
              processIncarnation: params.processIncarnation,
              hostScope: params.hostScope,
              ownership: 'external'
            })
          }
        }
      }
      this.db.exec('COMMIT')
      return capability
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Why inputEvidence lands in the same statement that stamps readiness: the receipt and the row
  // must agree about what the terminal showed at the submit, and a second write could be lost to a
  // crash between them — leaving `ready` claiming more than the evidence supports (A1 section 2).
  markWorkerDispatchReady(
    dispatchId: string,
    effects?: unknown[],
    inputEvidence?: DispatchInputEvidence
  ): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
      }
      this.db
        .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'ready', stage = 'input_accepted',
               effects = COALESCE(?, effects), input_evidence = COALESCE(?, input_evidence),
               updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(
          effects ? JSON.stringify(effects) : null,
          inputEvidence ? JSON.stringify(inputEvidence) : null,
          dispatchId
        )
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failWorkerStart(dispatchId: string, stage: string, reason: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker || worker.state !== 'starting') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
      }
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
               capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ?`
        )
        .run(reason, dispatchId)
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'failed', stage = ?, last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(stage, reason, dispatchId)
      this.db
        .prepare("UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
        .run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markWorkerStartUnknown(dispatchId: string, stage: string, reason: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker || worker.state !== 'starting') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'start_unknown', stage = ?, last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(stage, reason, dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ?`
        )
        .run(dispatchId)
      this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  reconcileFederatedWorkerStart(params: {
    dispatchId: string
    state: 'ready' | 'failed' | 'stopped' | 'start_unknown'
    stage: string
    lastError?: string | null
    worktreeId?: string | null
    terminalHandle?: string | null
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
  }): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(params.dispatchId)
      const worker = this.getWorkerDispatch(params.dispatchId)
      if (!dispatch || !worker) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Federated Dispatch ${params.dispatchId} was not found.`
        )
      }
      if (!['starting', 'start_unknown'].includes(worker.state)) {
        this.db.exec('COMMIT')
        return worker
      }

      if (params.state === 'ready') {
        this.db
          .prepare(
            `UPDATE worker_dispatches
             SET state = 'ready', stage = ?, worktree_id = COALESCE(?, worktree_id),
                 agent_terminal_handle = COALESCE(?, agent_terminal_handle), setup_state = ?,
                 effects = ?, residual_resources = ?, last_error = NULL,
                 updated_at = datetime('now')
             WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
          )
          .run(
            params.stage,
            params.worktreeId ?? null,
            params.terminalHandle ?? null,
            params.setupState ?? worker.setup_state,
            JSON.stringify(params.effects ?? JSON.parse(worker.effects)),
            JSON.stringify(params.residualResources ?? JSON.parse(worker.residual_resources)),
            params.dispatchId
          )
        this.db
          .prepare(
            "UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ? AND status = 'pending'"
          )
          .run(params.dispatchId)
        this.db
          .prepare(
            "UPDATE tasks SET status = 'dispatched', completed_at = NULL WHERE id = ? AND status = 'blocked'"
          )
          .run(dispatch.task_id)
      } else if (params.state === 'start_unknown') {
        this.db
          .prepare(
            `UPDATE worker_dispatches
             SET stage = ?, last_error = ?, updated_at = datetime('now')
             WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
          )
          .run(params.stage, params.lastError ?? worker.last_error, params.dispatchId)
      } else {
        const reason = params.lastError ?? `The worker server reported ${params.state}.`
        this.db
          .prepare(
            `UPDATE worker_dispatches
             SET state = ?, stage = ?, last_error = ?, updated_at = datetime('now')
             WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
          )
          .run(params.state, params.stage, reason, params.dispatchId)
        this.db
          .prepare(
            `UPDATE dispatch_contexts
             SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
                 capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
             WHERE id = ? AND status IN ('pending', 'dispatched')`
          )
          .run(reason, params.dispatchId)
        this.db
          .prepare(
            "UPDATE tasks SET status = 'failed', completed_at = datetime('now') WHERE id = ? AND status IN ('blocked', 'dispatched')"
          )
          .run(dispatch.task_id)
        this.closeQuestionsForDispatch(params.dispatchId)
      }
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getWorkerDispatch(dispatchId: string): WorkerDispatchRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
      .get(dispatchId) as WorkerDispatchRow | undefined
  }

  listLegacyWorkerTerminalRecoveryRows(): LegacyWorkerTerminalRecoveryRow[] {
    return this.db
      .prepare(
        `SELECT dc.id AS dispatch_id, dc.task_id, dc.status AS dispatch_status,
                dc.contract_version, dc.assignee_handle, dc.assignee_pane_key,
                dc.process_incarnation, wd.state AS worker_state, wd.worktree_id,
                wd.agent_terminal_handle
         FROM dispatch_contexts dc
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
         WHERE wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
         ORDER BY dc.rowid`
      )
      .all() as LegacyWorkerTerminalRecoveryRow[]
  }

  reconcileMissingWorkerTerminal(dispatchId: string, reason: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch || !worker) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
        this.db.exec('COMMIT')
        return worker
      }

      const activeDispatch = dispatch.status === 'pending' || dispatch.status === 'dispatched'
      const stopWasPending = worker.state === 'stopping' || worker.state === 'stop_unknown'
      if (activeDispatch) {
        const failureCount = dispatch.failure_count + 1
        const dispatchStatus: DispatchStatus = failureCount >= 3 ? 'circuit_broken' : 'failed'
        this.db
          .prepare(
            `UPDATE dispatch_contexts
             SET status = ?, failure_count = ?, last_failure = ?,
                 completed_at = datetime('now'),
                 capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
             WHERE id = ? AND status IN ('pending', 'dispatched')`
          )
          .run(dispatchStatus, failureCount, reason, dispatchId)
        if (!stopWasPending) {
          const taskStatus: TaskStatus = dispatchStatus === 'circuit_broken' ? 'failed' : 'ready'
          this.db
            .prepare(
              `UPDATE tasks
               SET status = ?, completed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END
               WHERE id = ? AND status IN ('dispatched', 'blocked')`
            )
            .run(taskStatus, taskStatus, dispatch.task_id)
        }
        this.closeQuestionsForDispatch(dispatchId)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = ?, stage = 'terminal_missing', last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(stopWasPending ? 'stopped' : 'abandoned', reason, dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getFederatedDispatch(dispatchId: string): FederatedDispatchRow | undefined {
    return this.db
      .prepare('SELECT * FROM federated_dispatches WHERE dispatch_id = ?')
      .get(dispatchId) as FederatedDispatchRow | undefined
  }

  // Why the health lives on the row and not only in the relay's Map: the Map dies with the process,
  // and a resumed relay that starts from a zeroed failure count re-dials a peer it already knows is
  // unreachable at the 1s base interval, then reports `never / 0` to whoever asks (A1 section 9).
  recordFederatedDispatchSyncHealth(dispatchId: string, health: FederationSyncHealth): void {
    // Why updated_at is deliberately untouched: it is the receipt for a change to the binding, and a
    // column rewritten on every relay tick could no longer answer when the binding last changed.
    this.db
      .prepare(
        `UPDATE federated_dispatches
         SET last_sync_at = ?, last_error = ?, consecutive_failures = ?
         WHERE dispatch_id = ?`
      )
      .run(health.lastSyncAt, health.lastError, health.consecutiveFailures, dispatchId)
  }

  getFederatedDispatchSyncHealth(dispatchId: string): FederationSyncHealth | null {
    return federationSyncHealthFromRow(
      this.db
        .prepare(
          `SELECT last_sync_at, last_error, consecutive_failures
           FROM federated_dispatches
           WHERE dispatch_id = ?`
        )
        .get(dispatchId) as FederationSyncHealthRow | undefined
    )
  }

  // Why the unsettled predicate: a transport that dies after the Dispatch settled is nothing the
  // coordinator can act on, and the relay stays armed past settlement until the peer's queue is
  // acknowledged — so without this an outage spanning a settlement would escalate afterwards.
  getFederatedRelayNoticeTarget(
    dispatchId: string
  ): { runId: string; taskId: string; environmentName: string } | undefined {
    return this.db
      .prepare(
        `SELECT d.run_id AS runId, d.task_id AS taskId, f.environment_name AS environmentName
         FROM federated_dispatches f
         JOIN dispatch_contexts d ON d.id = f.dispatch_id
         WHERE f.dispatch_id = ? AND d.status IN ('pending', 'dispatched')`
      )
      .get(dispatchId) as { runId: string; taskId: string; environmentName: string } | undefined
  }

  listActiveFederatedDispatches(runId?: string): FederatedDispatchRow[] {
    return this.db
      .prepare(
        `SELECT fd.*
         FROM federated_dispatches fd
         INNER JOIN dispatch_contexts dc ON dc.id = fd.dispatch_id
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
         WHERE wd.state IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
           AND (? IS NULL OR dc.run_id = ?)
         ORDER BY fd.rowid`
      )
      .all(runId ?? null, runId ?? null) as FederatedDispatchRow[]
  }

  findNextTerminalFederatedDispatchPendingAcknowledgment(
    afterRowId: number
  ): { dispatchId: string; rowId: number } | undefined {
    return this.db
      .prepare(
        `SELECT fd.dispatch_id AS dispatchId, fd.rowid AS rowId
         FROM federated_dispatches fd
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
         WHERE wd.state NOT IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
           AND fd.to_home_acknowledged_sequence < fd.to_home_imported_sequence
           AND fd.rowid > ?
         ORDER BY fd.rowid
         LIMIT 1`
      )
      .get(afterRowId) as { dispatchId: string; rowId: number } | undefined
  }

  isFederatedDispatchRelayEligible(dispatchId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM federated_dispatches fd
           INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
           WHERE fd.dispatch_id = ?
             AND (
               wd.state IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
               OR (
                 fd.to_home_acknowledged_sequence < fd.to_home_imported_sequence
               )
             )`
        )
        .get(dispatchId)
    )
  }

  updateFederatedDispatchResources(params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    worktreeId: string
    terminalHandle: string
  }): FederatedDispatchRow {
    this.db
      .prepare(
        `UPDATE federated_dispatches
         SET remote_runtime_epoch = ?, remote_worktree_id = ?, remote_terminal_handle = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(params.remoteRuntimeEpoch, params.worktreeId, params.terminalHandle, params.dispatchId)
    const row = this.getFederatedDispatch(params.dispatchId)
    if (!row) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${params.dispatchId} was not found.`
      )
    }
    return row
  }

  createRemoteDispatchAttachment(params: {
    dispatchId: string
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    mutationReceipt: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }): RemoteDispatchAttachmentRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // S10-4 ruling 5: authenticatedCallerFingerprint falls back to
      // sha256('authenticated_transport') when a request carries neither an auth token nor a
      // device token — every tokenless local caller (the `orca` CLI, the renderer, a shared-box
      // peer) collapses onto that ONE value, which names no federation link at all. Binding it
      // here would let a caller with no per-link credential attach itself as "the home peer" for
      // ANY dispatch id it can guess.
      if (params.homePeerFingerprint === UNAUTHENTICATED_LANE_CALLER_FINGERPRINT) {
        throw new OrchestrationError(
          'unauthenticated_lane',
          'This caller presented no per-link credential and cannot be bound as a federation home peer.'
        )
      }
      if (params.homePeerFingerprint !== params.mutationReceipt.callerFingerprint) {
        throw new OrchestrationError(
          'resource_server_mismatch',
          'The authenticated Run-home peer does not match the attachment request.'
        )
      }
      const existingReceipt = this.getMutationReceipt(
        params.mutationReceipt.callerFingerprint,
        params.mutationReceipt.requestId
      )
      if (existingReceipt) {
        throw new OrchestrationError(
          existingReceipt.method === params.mutationReceipt.method &&
            existingReceipt.payload_hash === params.mutationReceipt.payloadHash
            ? 'operation_unknown'
            : 'request_mismatch',
          `Remote attachment request ${params.mutationReceipt.requestId} already exists.`
        )
      }
      ensureMutationReceiptCapacity(this.db)
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state, receipt
           ) VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .run(
          params.mutationReceipt.callerFingerprint,
          params.mutationReceipt.requestId,
          params.mutationReceipt.method,
          params.mutationReceipt.payloadHash,
          JSON.stringify({ accepted: { dispatchId: params.dispatchId } })
        )
      this.db
        .prepare(
          `INSERT INTO remote_dispatch_attachments (
             dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          params.dispatchId,
          params.taskId,
          params.homePeerFingerprint,
          params.protocolVersion,
          params.runtimeEpoch
        )
      this.db.exec('COMMIT')
      return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRemoteDispatchAttachment(dispatchId: string): RemoteDispatchAttachmentRow | undefined {
    return this.db
      .prepare('SELECT * FROM remote_dispatch_attachments WHERE dispatch_id = ?')
      .get(dispatchId) as RemoteDispatchAttachmentRow | undefined
  }

  // S10-19 W-2 (INV-P-013): the row a peer-owned-pane exit hook should act on — no state filter
  // (attacker/Ruling 20(c): the close must fire regardless of succeeded/stopped/abandoned/
  // failed/ready), scoped to the terminal and to a row that has not already been marked exited.
  findPeerOwnedAttachmentForHandle(handle: string): RemoteDispatchAttachmentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_dispatch_attachments
         WHERE terminal_handle = ? AND agent_exited_at IS NULL
         ORDER BY COALESCE(handle_bound_at, created_at) DESC, rowid DESC LIMIT 1`
      )
      .get(handle) as RemoteDispatchAttachmentRow | undefined
  }

  // S10-19 W-2 (ops MJ-1 / §D): agent_exited_at is stamped in EVERY case — the only durable fact
  // of the exit. `state`/`stage` move to 'agent_exited' ONLY from ready/start_unknown/failed
  // (§D — never from 'starting', where recordRemoteAttachmentStage/failRemoteAttachment are the
  // unguarded in-flight writers) — succeeded/stopping/stop_unknown/stopped/abandoned rows keep
  // their own more specific terminal state, but still get the stamp.
  markPeerOwnedAttachmentAgentExited(
    dispatchId: string,
    cause: string
  ): RemoteDispatchAttachmentRow | undefined {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET agent_exited_at = COALESCE(agent_exited_at, datetime('now')),
             state = CASE WHEN state IN ('ready', 'start_unknown', 'failed') THEN 'agent_exited' ELSE state END,
             stage = CASE WHEN state IN ('ready', 'start_unknown', 'failed') THEN 'agent_exited' ELSE stage END,
             last_error = CASE WHEN state IN ('ready', 'start_unknown', 'failed') THEN ? ELSE last_error END,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND agent_exited_at IS NULL`
      )
      .run(`peer pane closed: ${cause}`, dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId)
  }

  // S10-19 W-2 (ops MN-7): the per-link live-attachment count the ingress cap
  // (PEER_LIVE_ATTACHMENTS_PER_LINK, W-3) checks before admitting a new attach.
  countLivePeerAttachments(fingerprint: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM remote_dispatch_attachments
         WHERE home_peer_fingerprint = ? AND agent_exited_at IS NULL
           AND state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')`
      )
      .get(fingerprint) as { n: number }
    return row.n
  }

  // S10-19 W-2 (Ruling 24 addendum 2(o)): every stale-epoch row not yet marked exited — the
  // caller (runPeerAttachmentBootSweep) decides per row, from its OWN pty table, whether the
  // PTY is provably gone; this query never filters on that (db.ts has no pty visibility).
  findStaleEpochAttachments(currentEpoch: string): RemoteDispatchAttachmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM remote_dispatch_attachments
         WHERE runtime_epoch != ? AND agent_exited_at IS NULL`
      )
      .all(currentEpoch) as RemoteDispatchAttachmentRow[]
  }

  // S10-19 W-2 (Ruling 24 addendum 2(p)/(q)): candidates for the runtime-time prune — a live,
  // still-bound terminal handle whose attachment has not been marked exited. The caller filters
  // to peer-profile rows and to ones whose agent has actually exited (isTerminalRunningAgent).
  findLivePeerCandidateAttachments(): RemoteDispatchAttachmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM remote_dispatch_attachments
         WHERE terminal_handle IS NOT NULL AND agent_exited_at IS NULL`
      )
      .all() as RemoteDispatchAttachmentRow[]
  }

  // S10-19 W-4 (the choke's single-shot claim): the ONE conditional UPDATE that lets exactly one
  // federationAnswerPrompt call proceed to write a keystroke for a given blocked-prompt
  // occurrence. Returns whether THIS call won the claim.
  reservePeerPromptAnswer(dispatchId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET blocked_consumed_at = datetime('now')
         WHERE dispatch_id = ? AND agent_exited_at IS NULL AND blocked_consumed_at IS NULL`
      )
      .run(dispatchId)
    return Number(result.changes) === 1
  }

  // S10-19 W-4 (Ruling 20(b)): un-burns the single shot — called only when the reserved write
  // itself failed, so a failed answer never costs the caller their one opportunity.
  releasePeerPromptAnswer(dispatchId: string): void {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET blocked_consumed_at = NULL
         WHERE dispatch_id = ? AND blocked_consumed_at IS NOT NULL`
      )
      .run(dispatchId)
  }

  deleteRemoteDispatchAttachment(dispatchId: string): void {
    this.db.prepare(`DELETE FROM remote_dispatch_attachments WHERE dispatch_id = ?`).run(dispatchId)
  }

  // S10-19 W-2 (§8.6, ops MO-2), Ruling 31(d): garbage-collects rows that are ALREADY settled AND
  // already closed-or-stamped by the pane-lifecycle pass — either agent_exited_at is set (a
  // close-then-stamp or markOwnerUnresolved already ran) or the row reached a terminal dispatch
  // state with NO pane ever bound (terminal_handle IS NULL, so there is nothing to leak). A
  // settled row that still carries a live terminal_handle and has not yet been stamped is left
  // for the next pane-lifecycle pass — never deleted unclosed. Retention window first (Ruling
  // 31(b): floored at the install-day stamp so a pre-existing backlog gets a full window counted
  // from upgrade, not from its own long-past updated_at), then the per-link cap on the remainder.
  pruneSettledRemoteAttachments(): number {
    const settledPredicate = `(
      agent_exited_at IS NOT NULL
      OR (
        state IN (${PEER_ATTACHMENT_SETTLED_STATES.map(() => '?').join(', ')}, 'stop_unknown', 'start_unknown')
        AND terminal_handle IS NULL
      )
    )`
    const settledParams = [...PEER_ATTACHMENT_SETTLED_STATES]
    const floorFloored = `max(COALESCE(agent_exited_at, updated_at),
        COALESCE((SELECT floor_at FROM peer_attachment_retention_floor WHERE id = 1), '0000'))`
    const retentionDeleted = Number(
      this.db
        .prepare(
          `DELETE FROM remote_dispatch_attachments
           WHERE ${settledPredicate}
             AND ${floorFloored} < datetime('now', ?)`
        )
        .run(...settledParams, `-${Math.floor(PEER_ATTACHMENT_RETENTION_MS / 1000)} seconds`)
        .changes
    )
    const capDeleted = Number(
      this.db
        .prepare(
          `DELETE FROM remote_dispatch_attachments
           WHERE dispatch_id IN (
             SELECT dispatch_id FROM (
               SELECT dispatch_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY home_peer_fingerprint
                        ORDER BY COALESCE(agent_exited_at, updated_at) DESC, rowid DESC
                      ) AS rn
               FROM remote_dispatch_attachments
               WHERE ${settledPredicate}
             )
             WHERE rn > ?
           )`
        )
        .run(...settledParams, PEER_ATTACHMENTS_RETAINED_PER_LINK).changes
    )
    return retentionDeleted + capDeleted
  }

  recordRemoteAttachmentStage(params: {
    dispatchId: string
    stage: string
    state?: WorkerDispatchState
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
  }): RemoteDispatchAttachmentRow {
    const current = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${params.dispatchId} was not found.`
      )
    }
    // S10-19 W-2/INV-P-013: the first time this stage write attaches a terminal_handle, stamp
    // handle_bound_at — the boot sweep's ordering rule (Ruling 24(c)) resolves a stale peer row's
    // handle "in this process" and needs to tell a freshly-bound handle from one that was already
    // bound before the restart.
    const bindsHandleNow = Boolean(params.terminalHandle) && !current.terminal_handle
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET stage = ?, state = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
             effects = ?, residual_resources = ?, last_error = ?,
             handle_bound_at = CASE WHEN ? THEN datetime('now') ELSE handle_bound_at END,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(
        params.stage,
        params.state ?? current.state,
        params.worktreeId ?? current.worktree_id,
        params.terminalHandle ?? current.terminal_handle,
        params.setupState ?? current.setup_state,
        params.effects ? JSON.stringify(params.effects) : current.effects,
        params.residualResources
          ? JSON.stringify(params.residualResources)
          : current.residual_resources,
        params.lastError ?? current.last_error,
        bindsHandleNow ? 1 : 0,
        params.dispatchId
      )
    return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
  }

  updateRemoteAttachmentSetupEvidence(params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }): { attachment: RemoteDispatchAttachmentRow; changed: boolean } {
    const current = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!current) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${params.dispatchId} was not found.`
      )
    }
    const effects = JSON.stringify(params.effects)
    if (current.setup_state === params.setupState && current.effects === effects) {
      return { attachment: current, changed: false }
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET setup_state = ?, effects = ?, updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(params.setupState, effects, params.dispatchId)
    return {
      attachment: this.getRemoteDispatchAttachment(
        params.dispatchId
      ) as RemoteDispatchAttachmentRow,
      changed: true
    }
  }

  prepareRemoteAttachmentAuthority(params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
    terminalHandle: string
    setupState: string
    effects: unknown[]
  }): string {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!attachment || attachment.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is not starting.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET stage = 'authority_attached', capability_hash = ?, pane_key = ?,
             process_incarnation = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
             effects = ?, residual_resources = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(
        hashDispatchCapability(capability),
        params.paneKey,
        params.processIncarnation,
        params.worktreeId,
        params.terminalHandle,
        params.setupState,
        JSON.stringify(params.effects),
        JSON.stringify(
          params.effects.filter((effect) =>
            Boolean(
              effect &&
              typeof effect === 'object' &&
              ((effect as { action?: string }).action?.startsWith('created') ||
                (effect as { action?: string }).action === 'reused_agent_terminal')
            )
          )
        ),
        params.dispatchId
      )
    return capability
  }

  markRemoteAttachmentReady(dispatchId: string, effects?: unknown[]): RemoteDispatchAttachmentRow {
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'ready', stage = 'input_accepted',
             effects = COALESCE(?, effects), updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(effects ? JSON.stringify(effects) : null, dispatchId)
    if (result.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} is not starting.`
      )
    }
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  failRemoteAttachment(
    dispatchId: string,
    stage: string,
    reason: string,
    unknown: boolean
  ): RemoteDispatchAttachmentRow {
    const state = unknown ? 'start_unknown' : 'failed'
    // S10-19 W-1: blocked_reason/blocked_at also record a terminal failure — the columns read
    // generically ("this attachment is blocked, and why") and a failed attachment has nothing
    // further to unblock, so stamping them here finalizes any would-be prompt-answer wait.
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = ?, stage = ?, last_error = ?, capability_hash = NULL,
             blocked_reason = ?, blocked_at = datetime('now'), updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(state, stage, reason, reason, dispatchId)
    if (result.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} is not starting.`
      )
    }
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  verifyRemoteAttachmentAuthority(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (
      !attachment?.capability_hash ||
      !params.capability ||
      !attachment.pane_key ||
      !params.paneKey ||
      !isEquivalentPaneKey(attachment.pane_key, params.paneKey) ||
      !attachment.process_incarnation ||
      attachment.process_incarnation !== params.processIncarnation
    ) {
      return false
    }
    const expected = Buffer.from(attachment.capability_hash, 'hex')
    const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
    return expected.length === observed.length && timingSafeEqual(expected, observed)
  }

  isRemoteAttachmentProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    return Boolean(
      attachment?.pane_key &&
      params.paneKey &&
      isEquivalentPaneKey(attachment.pane_key, params.paneKey) &&
      attachment.process_incarnation &&
      attachment.process_incarnation === params.processIncarnation
    )
  }

  beginRemoteAttachmentStop(dispatchId: string): RemoteDispatchAttachmentRow {
    const attachment = this.getRemoteDispatchAttachment(dispatchId)
    if (!attachment) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${dispatchId} was not found.`
      )
    }
    if ((PEER_ATTACHMENT_SETTLED_STATES as readonly string[]).includes(attachment.state)) {
      return attachment
    }
    if (!['ready', 'start_unknown'].includes(attachment.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} cannot stop from ${attachment.state}.`
      )
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'stopping', stage = 'stop_requested', capability_hash = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state IN ('ready', 'start_unknown')`
      )
      .run(dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  settleRemoteAttachmentStop(dispatchId: string): RemoteDispatchAttachmentRow {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  markRemoteAttachmentStopUnknown(dispatchId: string, reason: string): RemoteDispatchAttachmentRow {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(reason, dispatchId)
    return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
  }

  findActiveRemoteAttachmentForPane(paneKey: string): RemoteDispatchAttachmentRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_dispatch_attachments
         WHERE state IN ('starting', 'ready') AND pane_key IS NOT NULL
         ORDER BY rowid DESC`
      )
      .all() as RemoteDispatchAttachmentRow[]
    return rows.find((row) => row.pane_key && isEquivalentPaneKey(row.pane_key, paneKey))
  }

  enqueueFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    kind: string
    payload: string
    messageId?: string
    settleRemoteOutcome?: WorkerReportOutcome
    remoteQuestion?: true
  }): FederationRelayItemRow {
    const byteCount = Buffer.byteLength(params.payload, 'utf8')
    const messageId = params.messageId ?? generateId('relay')
    if (byteCount > 64 * 1024) {
      throw new OrchestrationError(
        'relay_quota_exceeded',
        'A federated orchestration message cannot exceed 64 KiB.'
      )
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (params.settleRemoteOutcome) {
        const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
        if (!attachment || attachment.state !== 'ready') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Remote Dispatch ${params.dispatchId} is not active.`
          )
        }
      }
      if (params.kind === 'heartbeat') {
        const heartbeat = this.db
          .prepare(
            `SELECT * FROM federation_relay_items
             WHERE dispatch_id = ? AND direction = ? AND kind = 'heartbeat'
               AND acked_at IS NULL
             ORDER BY sequence DESC LIMIT 1`
          )
          .get(params.dispatchId, params.direction) as FederationRelayItemRow | undefined
        if (heartbeat) {
          this.db
            .prepare(
              `UPDATE federation_relay_items
               SET payload = ?, byte_count = ?, created_at = datetime('now')
               WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
            )
            .run(params.payload, byteCount, params.dispatchId, params.direction, heartbeat.sequence)
          this.db.exec('COMMIT')
          return this.getFederationRelayItem(
            params.dispatchId,
            params.direction,
            heartbeat.sequence
          ) as FederationRelayItemRow
        }
      }
      if (params.kind === 'worker_done') {
        const identicalReport = this.db
          .prepare(
            `SELECT * FROM federation_relay_items
             WHERE dispatch_id = ? AND direction = ? AND kind = 'worker_done'
               AND payload = ? AND acked_at IS NULL
             ORDER BY sequence DESC LIMIT 1`
          )
          .get(params.dispatchId, params.direction, params.payload) as
          | FederationRelayItemRow
          | undefined
        if (identicalReport) {
          this.settleRemoteAttachmentInRelayTransaction(
            params.dispatchId,
            params.settleRemoteOutcome
          )
          this.db.exec('COMMIT')
          return identicalReport
        }
      }
      const quota = this.db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes
           FROM federation_relay_items
           WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL`
        )
        .get(params.dispatchId, params.direction) as { count: number; bytes: number }
      if (quota.count >= 256 || quota.bytes + byteCount > 1024 * 1024) {
        if (params.kind === 'worker_done') {
          const heartbeat = this.db
            .prepare(
              `SELECT * FROM federation_relay_items
               WHERE dispatch_id = ? AND direction = ? AND kind = 'heartbeat'
                 AND acked_at IS NULL
               ORDER BY sequence LIMIT 1`
            )
            .get(params.dispatchId, params.direction) as FederationRelayItemRow | undefined
          if (heartbeat) {
            this.db
              .prepare(
                `UPDATE federation_relay_items
                 SET message_id = ?, kind = ?, payload = ?, byte_count = ?,
                     created_at = datetime('now')
                 WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
              )
              .run(
                messageId,
                params.kind,
                params.payload,
                byteCount,
                params.dispatchId,
                params.direction,
                heartbeat.sequence
              )
            this.settleRemoteAttachmentInRelayTransaction(
              params.dispatchId,
              params.settleRemoteOutcome
            )
            this.db.exec('COMMIT')
            return this.getFederationRelayItem(
              params.dispatchId,
              params.direction,
              heartbeat.sequence
            ) as FederationRelayItemRow
          }
        }
        throw new OrchestrationError(
          'relay_quota_exceeded',
          `Federated Dispatch ${params.dispatchId} has no relay capacity.`
        )
      }
      const latest = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS sequence
           FROM federation_relay_items WHERE dispatch_id = ? AND direction = ?`
        )
        .get(params.dispatchId, params.direction) as { sequence: number }
      const sequence = latest.sequence + 1
      this.db
        .prepare(
          `INSERT INTO federation_relay_items (
             dispatch_id, direction, sequence, message_id, kind, payload, byte_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.dispatchId,
          params.direction,
          sequence,
          messageId,
          params.kind,
          params.payload,
          byteCount
        )
      if (params.remoteQuestion) {
        this.db
          .prepare(
            `INSERT INTO remote_questions (message_id, dispatch_id)
             VALUES (?, ?)`
          )
          .run(messageId, params.dispatchId)
      }
      this.settleRemoteAttachmentInRelayTransaction(params.dispatchId, params.settleRemoteOutcome)
      this.db.exec('COMMIT')
      return this.getFederationRelayItem(
        params.dispatchId,
        params.direction,
        sequence
      ) as FederationRelayItemRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    afterSequence: number
    limit?: number
  }): FederationRelayItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND sequence > ?
         ORDER BY sequence LIMIT ?`
      )
      .all(
        params.dispatchId,
        params.direction,
        params.afterSequence,
        Math.min(Math.max(params.limit ?? 50, 1), 50)
      ) as FederationRelayItemRow[]
  }

  listPendingFederationRelay(
    dispatchId: string,
    direction: FederationRelayDirection,
    limit = 50
  ): FederationRelayItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL
         ORDER BY sequence LIMIT ?`
      )
      .all(dispatchId, direction, Math.min(Math.max(limit, 1), 50)) as FederationRelayItemRow[]
  }

  acknowledgeFederationRelay(params: {
    dispatchId: string
    direction: FederationRelayDirection
    throughSequence: number
    settleRemoteReports?: { sequence: number; outcome?: WorkerReportOutcome }[]
  }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const settledReports = params.settleRemoteReports ?? []
      for (const settledReport of settledReports) {
        const report = this.getFederationRelayItem(
          params.dispatchId,
          params.direction,
          settledReport.sequence
        )
        if (
          params.direction !== 'to_home' ||
          settledReport.sequence > params.throughSequence ||
          report?.kind !== 'worker_done' ||
          (settledReport.outcome !== undefined &&
            parseFederatedWorkerReportOutcome(report.payload) !== settledReport.outcome)
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Federation acknowledgment for ${params.dispatchId} does not match its queued worker_done.`
          )
        }
      }
      const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
      if (
        params.direction === 'to_home' &&
        attachment !== undefined &&
        attachment.protocol_version >=
          ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
      ) {
        const acknowledgedReports = this.db
          .prepare(
            `SELECT sequence FROM federation_relay_items
             WHERE dispatch_id = ? AND direction = 'to_home' AND kind = 'worker_done'
               AND acked_at IS NULL AND sequence <= ?`
          )
          .all(params.dispatchId, params.throughSequence) as { sequence: number }[]
        const settledSequences = new Set(settledReports.map((report) => report.sequence))
        if (acknowledgedReports.some((report) => !settledSequences.has(report.sequence))) {
          throw new OrchestrationError(
            'request_mismatch',
            `Federation acknowledgment for ${params.dispatchId} omits a worker_done settlement.`
          )
        }
      }
      const terminalOutcomes = new Set(
        settledReports.flatMap((report) => (report.outcome ? [report.outcome] : []))
      )
      if (terminalOutcomes.size > 1) {
        throw new OrchestrationError(
          'request_mismatch',
          `Federation acknowledgment for ${params.dispatchId} contains conflicting settlements.`
        )
      }
      const terminalOutcome = settledReports.find((report) => report.outcome)?.outcome
      if (terminalOutcome) {
        this.settleRemoteAttachmentInRelayTransaction(
          params.dispatchId,
          terminalOutcome,
          'worker_report_settled'
        )
      }
      this.db
        .prepare(
          `UPDATE federation_relay_items SET acked_at = COALESCE(acked_at, datetime('now'))
           WHERE dispatch_id = ? AND direction = ? AND sequence <= ?`
        )
        .run(params.dispatchId, params.direction, params.throughSequence)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setFederatedHomeImportSequence(dispatchId: string, sequence: number): void {
    this.db
      .prepare(
        `UPDATE federated_dispatches
         SET to_home_imported_sequence = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND to_home_imported_sequence < ?`
      )
      .run(sequence, dispatchId, sequence)
  }

  recordFederatedHomeAcknowledgment(params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    sequence: number
  }): void {
    const federated = this.getFederatedDispatch(params.dispatchId)
    if (
      !federated ||
      !Number.isInteger(params.sequence) ||
      params.sequence < 0 ||
      params.sequence > federated.to_home_imported_sequence
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Federation acknowledgment for ${params.dispatchId} exceeds imported relay state.`
      )
    }
    this.db
      .prepare(
        `UPDATE federated_dispatches
         SET remote_runtime_epoch = ?,
             to_home_acknowledged_sequence = CASE
               WHEN remote_runtime_epoch = ?
                 THEN MAX(to_home_acknowledged_sequence, ?)
               ELSE ?
             END,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      .run(
        params.remoteRuntimeEpoch,
        params.remoteRuntimeEpoch,
        params.sequence,
        params.sequence,
        params.dispatchId
      )
  }

  // S10-4 ruling 2: the durable half of importFederatedRelayItem's disposition. No own
  // BEGIN/COMMIT (same discipline as setFederatedHomeImportSequence just above) so it commits
  // atomically inside that method's enclosing transaction; INSERT OR IGNORE makes a retried call
  // against an already-recorded (dispatch_id, sequence, generation) a no-op rather than a PK
  // error, so a second call for the same item (a replayed relay page) never overwrites the
  // first outcome. `generation` defaults to 0 (a link that has never been relinked) so callers
  // outside the relay-import transaction — a test, or a pre-relink caller with no reason to
  // know its dispatch's current epoch — don't need to plumb it through; importFederatedRelayItem
  // always passes the dispatch's actual current `relink_generation` explicitly.
  recordRelaySeen(params: {
    dispatchId: string
    sequence: number
    messageId: string
    outcome: RelaySeenOutcome
    ruleIds?: readonly string[]
    generation?: number
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO relay_seen (dispatch_id, sequence, generation, message_id, outcome, rule_ids)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.dispatchId,
        params.sequence,
        params.generation ?? 0,
        params.messageId,
        params.outcome,
        params.ruleIds && params.ruleIds.length > 0 ? JSON.stringify(params.ruleIds) : null
      )
  }

  listRelaySeen(dispatchId: string): RelaySeenRow[] {
    return this.db
      .prepare(
        `SELECT * FROM relay_seen WHERE dispatch_id = ? ORDER BY generation ASC, sequence ASC`
      )
      .all(dispatchId) as RelaySeenRow[]
  }

  // S10-4 ruling 1, keying amended by S10-15 D5: upsert a peer-asserted agent-directory row into
  // the SEPARATE remote_agents table, keyed by the LINK (`environmentId` is a link key here —
  // `pairedDeviceId` for a 'paired_device' link, a saved KnownRuntimeEnvironment.id for an
  // 'environment' link; see remote-agent-directory-types.ts). A remote-quarantine flip is
  // honored; a local quarantine is never cleared by this path — trg_remote_lift_scope enforces
  // it even if a caller forgets to check, and (S10-15 breaker finding 8, load-bearing) this
  // statement must NEVER name `local_quarantined` in its column list or DO UPDATE SET: THAT
  // omission, not the trigger, is what makes a remote assertion structurally unable to clear a
  // local quarantine in the common (non-simultaneous) case the trigger doesn't cover.
  // S10-15 review F8 (Ruling 3(b)): the cap is enforced HERE too, not only by the importer's
  // own pre-check (federated-sender-identity.ts) — this is the defense-in-depth backstop for
  // any future caller that forgets to pre-check; the importer's own check stays (it is what
  // gives a caller the richer 'capped' outcome, including displayName/hostLabel/askerHandle,
  // BEFORE doing any of its other work). Only a genuinely NEW row counts against the cap — an
  // update to an already-mirrored row never evicts and is never capped.
  upsertRemoteAgent(params: {
    environmentId: string
    environmentName: string
    linkKind: RemoteAgentLinkKind
    remoteAgentId: string
    displayName: string
    role: string | null
    state: 'live' | 'idle' | 'gone'
    derived: boolean
    remoteQuarantined: boolean
    /** S10-15 ruling 2: the link's own authenticated fingerprint. Omit for a writer that has
     *  none to offer (e.g. a future 'environment'-kind writer) — an existing bound value is
     *  preserved, never clobbered with NULL. */
    peerFingerprint?: string | null
  }): { outcome: 'upserted' } | { outcome: 'capped' } {
    const isNewRow = !this.hasRemoteAgent(params.environmentId, params.remoteAgentId)
    if (
      isNewRow &&
      this.countRemoteAgentsForLink(params.environmentId) >= REMOTE_AGENTS_PER_LINK_CAP
    ) {
      return { outcome: 'capped' }
    }
    this.db
      .prepare(
        `INSERT INTO remote_agents (
           environment_id, environment_name, link_kind, remote_agent_id, display_name, role,
           state, derived, remote_quarantined, peer_fingerprint, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(environment_id, remote_agent_id) DO UPDATE SET
           environment_name = excluded.environment_name,
           link_kind = excluded.link_kind,
           display_name = excluded.display_name,
           role = excluded.role,
           state = excluded.state,
           derived = excluded.derived,
           remote_quarantined = excluded.remote_quarantined,
           peer_fingerprint = COALESCE(excluded.peer_fingerprint, remote_agents.peer_fingerprint),
           last_seen_at = datetime('now')`
      )
      .run(
        params.environmentId,
        params.environmentName,
        params.linkKind,
        params.remoteAgentId,
        params.displayName,
        params.role,
        params.state,
        params.derived ? 1 : 0,
        params.remoteQuarantined ? 1 : 0,
        params.peerFingerprint ?? null
      )
    return { outcome: 'upserted' }
  }

  listRemoteAgents(params?: {
    environmentId?: string
    linkKind?: RemoteAgentLinkKind
    includeQuarantined?: boolean
  }): RemoteAgentRow[] {
    const clauses: string[] = []
    const args: Database.BindValue[] = []
    if (params?.environmentId) {
      clauses.push('environment_id = ?')
      args.push(params.environmentId)
    }
    if (params?.linkKind) {
      clauses.push('link_kind = ?')
      args.push(params.linkKind)
    }
    if (!params?.includeQuarantined) {
      clauses.push('remote_quarantined = 0 AND local_quarantined = 0')
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM remote_agents ${where} ORDER BY display_name ASC`)
      .all(...args) as RemoteAgentRow[]
  }

  // S10-15 D5 interface point for the routing slice's `name@host` resolution: only 'environment'
  // rows are ever an address source, and the local-quarantine union (Rule 3) is applied here too
  // — a peer agent quarantined on its OTHER (paired_device) row must not resolve as a target.
  listAddressableRemoteAgents(params: { environmentId: string }): RemoteAgentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM remote_agents
         WHERE link_kind = 'environment' AND environment_id = ? AND remote_quarantined = 0
           AND NOT EXISTS (
             SELECT 1 FROM remote_agents q
             WHERE q.remote_agent_id = remote_agents.remote_agent_id AND q.local_quarantined = 1
           )
         ORDER BY display_name ASC`
      )
      .all(params.environmentId) as RemoteAgentRow[]
  }

  // S10-15 breaker finding 7: the local-quarantine union in ONE accessor, used at the ingest
  // refusal (never a per-key read there) — a peer agent quarantined on one link_kind row must be
  // refused when it arrives over the OTHER. `remote_quarantined` deliberately stays per-row
  // (D5 Rule 3): unioning IT would let one link's assertion deny another link's genuine traffic.
  isRemoteAgentLocallyQuarantined(remoteAgentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM remote_agents WHERE remote_agent_id = ? AND local_quarantined = 1`)
        .get(remoteAgentId) !== undefined
    )
  }

  // S10-15 R6: marks the sender's local mirror row as accepted by the peer, and records the
  // peer's own thread id for the conversation (COALESCE preserves an already-stored value on a
  // retry that reports no threadId).
  markPeerRelayAccepted(messageId: string, peerThreadId: string | null): void {
    this.db
      .prepare(
        `UPDATE messages SET peer_relayed_at = datetime('now'),
           peer_thread_id = COALESCE(?, peer_thread_id) WHERE id = ?`
      )
      .run(peerThreadId, messageId)
  }

  // S10-16 C5, R28.1 rule 2: the continuation path for a multi-message exchange — a prior
  // INBOUND-imported row (peer_link_device_id set) on the same link naming the same peer thread
  // id, already carrying a local thread. `peer_thread_id IS NOT NULL` is load-bearing (L2): SQL
  // equality on NULL matches nothing on its own, but this clause makes that explicit rather than
  // relying on the implicit behaviour.
  findForeignRowByLinkAndPeerThread(
    linkDeviceId: string,
    peerThreadId: string
  ): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages
          WHERE peer_link_device_id = ? AND peer_thread_id = ? AND peer_thread_id IS NOT NULL
            AND thread_id IS NOT NULL
          ORDER BY sequence DESC LIMIT 1`
      )
      .get(linkDeviceId, peerThreadId) as MessageRow | undefined
  }

  // S10-16 C5, R28.1(1b): mint a local thread, then back-fill a NULL-thread row's `thread_id`.
  // `createThread` already owns its own `BEGIN IMMEDIATE`/COMMIT (thread-directory.ts), so the
  // mint and the back-fill are two statements, not one nested transaction — SQLite has none. The
  // `AND thread_id IS NULL` guard on the UPDATE is what stays load-bearing: it protects the ROW
  // (a concurrent mint loses the backfill race and its thread becomes an unreferenced orphan,
  // never a correctness fault) even though the two writes are not atomic with each other.
  mintThreadAndBackfillMessage(
    backfillMessageId: string,
    threadParams: CreateThreadParams
  ): { threadId: string; backfilled: boolean } {
    const { thread } = this.createThread(threadParams)
    const result = this.db
      .prepare('UPDATE messages SET thread_id = ? WHERE id = ? AND thread_id IS NULL')
      .run(thread.id, backfillMessageId)
    return { threadId: thread.id, backfilled: result.changes === 1 }
  }

  // S10-15 ruling 2: the link's own currently-bound fingerprint, or null if this link has never
  // asserted one (first contact — binds on the next upsertRemoteAgent call).
  getBoundPeerFingerprintForLink(environmentId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT peer_fingerprint FROM remote_agents
         WHERE environment_id = ? AND peer_fingerprint IS NOT NULL LIMIT 1`
      )
      .get(environmentId) as { peer_fingerprint: string } | undefined
    return row?.peer_fingerprint ?? null
  }

  // S10-15 ruling 2: is this fingerprint already speaking for a DIFFERENT link? A hostile-or-
  // compromised (but legitimately paired) peer must never be able to claim an identity another
  // link already bound.
  findEnvironmentIdForPeerFingerprint(
    fingerprint: string,
    excludingEnvironmentId: string
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT environment_id FROM remote_agents WHERE peer_fingerprint = ? AND environment_id != ? LIMIT 1`
      )
      .get(fingerprint, excludingEnvironmentId) as { environment_id: string } | undefined
    return row?.environment_id ?? null
  }

  // S10-15 ruling 3(b): whether this exact (link, remote agent) pair is already mirrored — an
  // update to an existing row never counts against, or is blocked by, the per-link cap.
  hasRemoteAgent(environmentId: string, remoteAgentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`)
        .get(environmentId, remoteAgentId) !== undefined
    )
  }

  // S10-15 ruling 3(b): the count the per-link cap (REMOTE_AGENTS_PER_LINK_CAP) is checked
  // against — every row under this link key, regardless of link_kind or quarantine state.
  countRemoteAgentsForLink(environmentId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM remote_agents WHERE environment_id = ?`)
      .get(environmentId) as { n: number }
    return row.n
  }

  setLocalRemoteAgentQuarantine(params: {
    environmentId: string
    remoteAgentId: string
    quarantined: boolean
    reasonCode?: string | null
  }): RemoteAgentRow
  // S10-15 D5: the operator does not have to know which link_kind a peer arrived over — updates
  // every row sharing this remote_agent_id.
  setLocalRemoteAgentQuarantine(params: {
    remoteAgentId: string
    quarantined: boolean
    reasonCode?: string | null
    allLinks: true
  }): RemoteAgentRow[]
  setLocalRemoteAgentQuarantine(params: {
    environmentId?: string
    remoteAgentId: string
    quarantined: boolean
    reasonCode?: string | null
    allLinks?: boolean
  }): RemoteAgentRow | RemoteAgentRow[] {
    if (params.allLinks) {
      this.db
        .prepare(
          `UPDATE remote_agents
           SET local_quarantined = ?, quarantine_reason_code = ?
           WHERE remote_agent_id = ?`
        )
        .run(
          params.quarantined ? 1 : 0,
          params.quarantined ? (params.reasonCode ?? null) : null,
          params.remoteAgentId
        )
      return this.db
        .prepare(
          `SELECT * FROM remote_agents WHERE remote_agent_id = ? ORDER BY environment_id ASC`
        )
        .all(params.remoteAgentId) as RemoteAgentRow[]
    }
    if (!params.environmentId) {
      throw new OrchestrationError(
        'invalid_argument',
        'setLocalRemoteAgentQuarantine requires environmentId unless allLinks is set.'
      )
    }
    this.db
      .prepare(
        `UPDATE remote_agents
         SET local_quarantined = ?, quarantine_reason_code = ?
         WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .run(
        params.quarantined ? 1 : 0,
        params.quarantined ? (params.reasonCode ?? null) : null,
        params.environmentId,
        params.remoteAgentId
      )
    const row = this.db
      .prepare(`SELECT * FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`)
      .get(params.environmentId, params.remoteAgentId) as RemoteAgentRow | undefined
    if (!row) {
      throw new OrchestrationError(
        'agent_not_found',
        `Remote agent ${params.remoteAgentId}@${params.environmentId} was not found.`
      )
    }
    return row
  }

  // S10-4 ruling 5: an epoch-rewind recovery verb for a reimaged/reinstalled peer. Zeroes the
  // to_home import/ack cursors on every federated dispatch this host still tracks against the
  // named environment — the same tolerance federation-sync.ts already applies automatically on
  // a `remote_runtime_epoch` change (a peer's own epoch bump), offered here as a manual escape
  // hatch for the case a human has to force (the epoch string didn't change, or the peer is
  // gone and unreachable so the automatic path never fires). Also bumps `relink_generation`
  // (relink-generation fix): relay_seen's key includes it, so every relay_seen row this host
  // records after this point lands in a new generation rather than colliding with — and being
  // silently dropped against, via INSERT OR IGNORE — whatever the SAME sequence number recorded
  // before the relink. relay_seen rows from the prior generation are left exactly as they were:
  // this method never writes to relay_seen directly, only to the counter that keys it.
  relinkFederatedEnvironment(environmentId: string): { dispatchIds: string[] } {
    const dispatchIds = this.db
      .prepare(
        `SELECT dispatch_id FROM federated_dispatches WHERE environment_id = ?
           AND dispatch_id IN (SELECT id FROM dispatch_contexts WHERE status NOT IN ('completed', 'failed'))`
      )
      .all(environmentId)
      .map((row) => (row as { dispatch_id: string }).dispatch_id)
    if (dispatchIds.length === 0) {
      return { dispatchIds }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const reset = this.db.prepare(
        `UPDATE federated_dispatches
         SET to_home_imported_sequence = 0, to_home_acknowledged_sequence = 0,
             remote_runtime_epoch = NULL, relink_generation = relink_generation + 1,
             updated_at = datetime('now')
         WHERE dispatch_id = ?`
      )
      for (const dispatchId of dispatchIds) {
        reset.run(dispatchId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { dispatchIds }
  }

  importFederatedRelayItem(params: {
    dispatchId: string
    sequence: number
    /** federation_relay_items.kind for this item (federation-sync.ts's `item.kind`) — the
     * peer-host-attested provenance discriminator (Amendment A/D fix): 'runtime_notification'
     * only for rows the peer's own trusted runtime code enqueued; every other value (a
     * MESSAGE_TYPES literal, or 'question') is reachable from the dispatched agent's own
     * orchestration.send/ask. See the call site below for the full rationale. */
    relayKind: string
    message: {
      id: string
      runId: string
      from: string
      to: string
      subject: string
      body: string
      type: MessageType
      priority: MessagePriority
      threadId?: string
      payload?: string
    }
    lifecycle:
      | { kind: 'none' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
      | { kind: 'rejected'; code: string; reason: string }
  }): {
    message: MessageRow | null
    duplicate: boolean
    lifecycle?: WorkerReportSettlement | { action: 'rejected'; code: string; reason: string }
    refused?: { refusalId: number; ruleIds: readonly string[] }
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const federated = this.getFederatedDispatch(params.dispatchId)
      if (!federated) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Federated Dispatch ${params.dispatchId} was not found.`
        )
      }
      const duplicate = params.sequence <= federated.to_home_imported_sequence
      if (duplicate && !this.getMessageById(params.message.id)) {
        throw new OrchestrationError(
          'operation_unknown',
          `Federated relay sequence ${params.sequence} was committed without its message.`
        )
      }
      if (!duplicate && params.sequence !== federated.to_home_imported_sequence + 1) {
        throw new OrchestrationError(
          'operation_unknown',
          `Federated relay for ${params.dispatchId} is not contiguous after sequence ${federated.to_home_imported_sequence}.`
        )
      }

      let message = this.getMessageById(params.message.id)
      if (!message) {
        // Amendment A fix: this relay item carries mixed content — a worker's own free-text
        // worker_done/escalation/status body (a dispatched agent's own orchestration.send/ask
        // params, queued straight into federation_relay_items with NO gate check anywhere on
        // that path — the "already gated once at the worker's own local orchestration.send"
        // this comment used to claim is not true; that RPC branch only calls
        // db.enqueueFederationRelay) alongside host-generated 'runtime_notification' relay
        // items (dispatch-input-observer.ts / orchestration-federation-setup.ts) whose JSON
        // payload legitimately carries `kind` (input_not_consumed/liveness_breach/
        // relay_unreachable/setup status — amendment D's reserved namespace). The two shapes are
        // told apart by `params.relayKind` — federation_relay_items.kind, threaded through from
        // federation-sync.ts's `item.kind` — which is peer-host-attested provenance, not a value
        // the dispatched agent can set: its own orchestration.send/ask can only pick a
        // MESSAGE_TYPES value for the relay kind (`kind: type`, orchestration.ts), never the
        // literal 'runtime_notification' that only the peer's own trusted runtime code enqueues.
        //
        // 'runtime_notification' rows: same as before — payload_kind (the COLUMN) populated
        // directly from the trusted JSON `kind`, same bridge as runtime-notification.ts, un-gated
        // (host-lifecycle, never sender-controlled prose). Every other relay kind: routed through
        // the single write choke (h1+h2 tiers only, amendment A's inbound scope — infraAllowlist
        // is never defaulted here so a local infra literal never blocks mail a remote peer
        // already sent) and payload_kind is never derived from the imported JSON (amendment D) —
        // `payloadValueForGate` parses the wire payload once into a value insertGatedMessage can
        // gate leaf-by-leaf and re-serialize without double-encoding; a caller-supplied top-level
        // `kind` in that JSON hits the same payload_kind_reserved refusal every other peer-facing
        // sender does.
        if (params.relayKind === 'runtime_notification') {
          let payloadKind: string | null = null
          if (params.message.payload) {
            try {
              const parsed: unknown = JSON.parse(params.message.payload)
              const kind =
                parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>).kind
                  : undefined
              payloadKind = typeof kind === 'string' ? kind : null
            } catch {
              payloadKind = null
            }
          }
          message = this.insertMessage({ ...params.message, payloadKind })
        } else {
          const inserted = this.insertGatedMessage({
            id: params.message.id,
            runId: params.message.runId,
            from: params.message.from,
            to: params.message.to,
            subject: params.message.subject,
            body: params.message.body,
            type: params.message.type,
            priority: params.message.priority,
            threadId: params.message.threadId,
            payload: payloadValueForGate(params.message.payload),
            infraAllowlist: [],
            verb: 'federation_import'
          })
          if (inserted.outcome === 'refused') {
            // A relay refusal is a DISPOSITION, not an exception (S10-4 ruling: a refusal MUST
            // advance the cursor). Throwing here rolled back the gate_refusals audit row this
            // same transaction had just written AND left to_home_imported_sequence behind the
            // item, so the identical poisoned item re-imported forever. Commit the audit row
            // and the cursor; store no message row, settle no lifecycle. (`duplicate` is
            // provably false on this path: a duplicate with a missing message row threw
            // operation_unknown above.)
            this.setFederatedHomeImportSequence(params.dispatchId, params.sequence)
            // S10-4 ruling 2: the durable relay_seen outcome row lands in the SAME transaction
            // as the audit row and the cursor advance above — the refusal disposition is now
            // three durable writes committed atomically, not two. `generation` is the epoch
            // this sequence number belongs to (relink-generation fix) — without it, a refusal
            // replayed after a relink would silently no-op against a pre-relink row for the
            // same sequence instead of being recorded.
            this.recordRelaySeen({
              dispatchId: params.dispatchId,
              sequence: params.sequence,
              messageId: params.message.id,
              outcome: 'refused',
              ruleIds: inserted.verdict.ruleIds,
              generation: federated.relink_generation
            })
            this.db.exec('COMMIT')
            return {
              message: null,
              duplicate: false,
              refused: { refusalId: inserted.refusalId, ruleIds: inserted.verdict.ruleIds }
            }
          }
          message = inserted.message
        }
      } else if (
        message.run_id !== params.message.runId ||
        message.to_handle !== params.message.to ||
        message.type !== params.message.type
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Federated relay message ${params.message.id} conflicts with an existing message.`
        )
      }
      if (message.type === 'question') {
        this.registerFederatedQuestion({
          messageId: message.id,
          runId: params.message.runId,
          dispatchId: params.dispatchId
        })
      }
      let lifecycle:
        | WorkerReportSettlement
        | { action: 'rejected'; code: string; reason: string }
        | undefined
      if (params.lifecycle.kind === 'heartbeat' && !duplicate) {
        this.recordHeartbeat(params.dispatchId, params.lifecycle.at)
      } else if (params.lifecycle.kind === 'worker_report') {
        lifecycle = this.settleWorkerReportInTransaction({
          taskId: params.lifecycle.taskId,
          dispatchId: params.dispatchId,
          outcome: params.lifecycle.outcome,
          result: params.lifecycle.result
        })
        if (lifecycle.action === 'rejected' && !duplicate) {
          message = this.convertLifecycleMessageToRejection(
            message.id,
            lifecycle.code,
            lifecycle.reason
          ) as MessageRow
        }
      } else if (params.lifecycle.kind === 'rejected') {
        lifecycle = {
          action: 'rejected',
          code: params.lifecycle.code,
          reason: params.lifecycle.reason
        }
        if (!duplicate) {
          message = this.convertLifecycleMessageToRejection(
            message.id,
            params.lifecycle.code,
            params.lifecycle.reason
          ) as MessageRow
        }
      }
      if (!duplicate) {
        this.setFederatedHomeImportSequence(params.dispatchId, params.sequence)
        // S10-4 ruling 2: record the successful-import outcome too, same transaction. Skipped
        // on the `duplicate` branch on purpose — a duplicate replay's relay_seen row was
        // already written the first time this sequence landed (imported or refused), and
        // INSERT OR IGNORE would just no-op against it anyway. `generation` per the
        // relink-generation fix, same reasoning as the refused branch above.
        this.recordRelaySeen({
          dispatchId: params.dispatchId,
          sequence: params.sequence,
          messageId: params.message.id,
          outcome: 'imported',
          generation: federated.relink_generation
        })
      }
      this.db.exec('COMMIT')
      return { message, duplicate, ...(lifecycle ? { lifecycle } : {}) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRemoteQuestion(messageId: string):
    | {
        message_id: string
        dispatch_id: string
        status: 'pending' | 'answered' | 'closed'
        answer_message_id: string | null
        answer_body: string | null
      }
    | undefined {
    return this.db.prepare('SELECT * FROM remote_questions WHERE message_id = ?').get(messageId) as
      | {
          message_id: string
          dispatch_id: string
          status: 'pending' | 'answered' | 'closed'
          answer_message_id: string | null
          answer_body: string | null
        }
      | undefined
  }

  answerRemoteQuestion(params: {
    messageId: string
    dispatchId: string
    answerMessageId: string
    body: string
  }): void {
    const question = this.getRemoteQuestion(params.messageId)
    if (!question || question.dispatch_id !== params.dispatchId) {
      throw new OrchestrationError(
        'question_not_found',
        `Remote Question ${params.messageId} was not found.`
      )
    }
    if (question.status === 'answered') {
      if (
        question.answer_message_id !== params.answerMessageId ||
        question.answer_body !== params.body
      ) {
        throw new OrchestrationError(
          'answer_conflict',
          `Remote Question ${params.messageId} already has a different answer.`
        )
      }
      return
    }
    this.db
      .prepare(
        `UPDATE remote_questions
         SET status = 'answered', answer_message_id = ?, answer_body = ?,
             answered_at = datetime('now')
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(params.answerMessageId, params.body, params.messageId)
  }

  setRemoteWorkerImportSequence(dispatchId: string, sequence: number): void {
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET to_worker_imported_sequence = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND to_worker_imported_sequence < ?`
      )
      .run(sequence, dispatchId, sequence)
  }

  registerFederatedQuestion(params: {
    messageId: string
    runId: string
    dispatchId: string
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO question_threads (
           message_id, run_id, dispatch_id, asker_handle
         ) VALUES (?, ?, ?, ?)`
      )
      .run(params.messageId, params.runId, params.dispatchId, `dispatch:${params.dispatchId}`)
  }

  private getFederationRelayItem(
    dispatchId: string,
    direction: FederationRelayDirection,
    sequence: number
  ): FederationRelayItemRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
      )
      .get(dispatchId, direction, sequence) as FederationRelayItemRow | undefined
  }

  private settleRemoteAttachmentInRelayTransaction(
    dispatchId: string,
    outcome: WorkerReportOutcome | undefined,
    stage = 'worker_report_queued'
  ): void {
    if (!outcome) {
      return
    }
    const attachment = this.getRemoteDispatchAttachment(dispatchId)
    const state = outcome === 'succeeded' ? 'succeeded' : 'failed'
    if (!attachment) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${dispatchId} was not found.`
      )
    }
    if (attachment.state === state) {
      return
    }
    if (attachment.state !== 'ready') {
      throw new OrchestrationError(
        'request_mismatch',
        `Remote Dispatch ${dispatchId} cannot settle as ${state} from ${attachment.state}.`
      )
    }
    this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = ?, stage = ?, capability_hash = NULL,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'ready'`
      )
      .run(state, stage, dispatchId)
  }

  isDispatchProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    return Boolean(
      dispatch?.assignee_pane_key &&
      params.paneKey &&
      isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey) &&
      dispatch.process_incarnation &&
      params.processIncarnation === dispatch.process_incarnation
    )
  }

  beginWorkerStop(
    dispatchId: string
  ):
    | { disposition: 'stopping'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
    | { disposition: 'already_settled'; worker: WorkerDispatchRow; dispatch: DispatchContextRow }
    | ({ disposition: 'context_only' } & ContextOnlyDispatchReleaseResult) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const dispatch = this.getDispatchContextById(dispatchId)
      const worker = this.getWorkerDispatch(dispatchId)
      if (!dispatch) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (!worker) {
        const released = releaseContextOnlyDispatch(
          this.db,
          dispatch,
          this.getDispatchContext(dispatch.task_id)?.id,
          'stopped'
        )
        if (!released.alreadySettled) {
          this.closeQuestionsForDispatch(dispatchId)
        }
        this.db.exec('COMMIT')
        return { disposition: 'context_only', ...released }
      }
      if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
        this.db.exec('COMMIT')
        return { disposition: 'already_settled', worker, dispatch }
      }
      if (!['ready', 'start_unknown'].includes(worker.state)) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} cannot stop from ${worker.state}.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'stopping', stage = 'stop_requested', updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('ready', 'start_unknown')`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ?`
        )
        .run(dispatchId)
      this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return {
        disposition: 'stopping',
        worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow,
        dispatch: this.getDispatchContextById(dispatchId) as DispatchContextRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  settleWorkerStop(dispatchId: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch || worker.state !== 'stopping') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'stopped', stage = 'process_stopped', updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'stopping'`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', completed_at = datetime('now'), last_failure = 'stopped'
           WHERE id = ? AND status IN ('pending', 'dispatched')`
        )
        .run(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  reconcileFederatedWorkerStop(dispatchId: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch || !this.getFederatedDispatch(dispatchId)) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Federated Dispatch ${dispatchId} was not found.`
        )
      }
      if (worker.state === 'stopped') {
        this.db.exec('COMMIT')
        return worker
      }
      if (!['stopping', 'stop_unknown'].includes(worker.state)) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Federated Dispatch ${dispatchId} cannot reconcile stop from ${worker.state}.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'stopped', stage = 'process_stopped', last_error = NULL,
               updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('stopping', 'stop_unknown')`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now')),
               last_failure = 'stopped'
           WHERE id = ? AND status IN ('pending', 'dispatched')`
        )
        .run(dispatchId)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  resumeFederatedWorkerForTerminalRelay(dispatchId: string): WorkerDispatchRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!worker || !dispatch || worker.state !== 'stopping') {
        throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not stopping.`)
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'ready', stage = 'remote_report_pending', updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'stopping'`
        )
        .run(dispatchId)
      this.db
        .prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ? AND status = 'blocked'")
        .run(dispatch.task_id)
      this.db.exec('COMMIT')
      return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markWorkerStopUnknown(dispatchId: string, reason: string): WorkerDispatchRow {
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = 'stop_unknown', stage = 'stop_outcome_unknown', last_error = ?,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'stopping'`
      )
      .run(reason, dispatchId)
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  }

  abandonWorkerDispatch(dispatchId: string):
    | {
        disposition: 'abandoned' | 'already_abandoned' | 'stale'
        worker: WorkerDispatchRow
      }
    | ({ disposition: 'context_only' } & ContextOnlyDispatchReleaseResult) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      const dispatch = this.getDispatchContextById(dispatchId)
      if (!dispatch) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (!worker) {
        const released = releaseContextOnlyDispatch(
          this.db,
          dispatch,
          this.getDispatchContext(dispatch.task_id)?.id,
          'abandoned'
        )
        if (!released.alreadySettled) {
          this.closeQuestionsForDispatch(dispatchId)
        }
        this.db.exec('COMMIT')
        return { disposition: 'context_only', ...released }
      }
      if (worker.state === 'abandoned') {
        this.db.exec('COMMIT')
        return { disposition: 'already_abandoned', worker }
      }
      if (this.getDispatchContext(dispatch.task_id)?.id !== dispatchId) {
        this.db.exec('COMMIT')
        return { disposition: 'stale', worker }
      }
      if (worker.state === 'succeeded') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} already succeeded and cannot be abandoned.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'abandoned', stage = 'abandoned', updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = CASE WHEN status IN ('pending', 'dispatched') THEN 'failed' ELSE status END,
               capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')),
               completed_at = COALESCE(completed_at, datetime('now'))
           WHERE id = ?`
        )
        .run(dispatchId)
      this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(dispatch.task_id)
      this.closeQuestionsForDispatch(dispatchId)
      this.db.exec('COMMIT')
      return {
        disposition: 'abandoned',
        worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // --- Worker terminal resources (schema v23) ---------------------------------------------------

  // Historical renderer input and reuse cannot be proven, so pre-v23 terminals stay external.
  private backfillWorkerTerminalResources(): void {
    const rows = this.db
      .prepare(
        `SELECT w.dispatch_id, w.worktree_id, w.agent_terminal_handle,
                d.assignee_pane_key, d.process_incarnation
           FROM worker_dispatches w
           JOIN dispatch_contexts d ON d.id = w.dispatch_id
          WHERE w.agent_terminal_handle IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id = w.dispatch_id)
            AND NOT EXISTS (
              SELECT 1 FROM worker_terminal_resources r WHERE r.owner_dispatch_id = w.dispatch_id
            )`
      )
      .all() as {
      dispatch_id: string
      worktree_id: string | null
      agent_terminal_handle: string
      assignee_pane_key: string | null
      process_incarnation: string | null
    }[]
    const insert = this.db.prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle,
         pane_key, process_incarnation, ownership_state, release_state, retained_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(
        generateId('wtr'),
        row.dispatch_id,
        row.dispatch_id,
        row.worktree_id,
        row.agent_terminal_handle,
        row.assignee_pane_key,
        row.process_incarnation,
        'external',
        'retained',
        'legacy_ambiguous'
      )
    }
  }

  // No transaction: composes inside worker-start's authority transaction.
  createWorkerTerminalResourceStatement(params: {
    dispatchId: string
    worktreeId: string | null
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope?: string | null
    ownership: Extract<WorkerTerminalOwnershipState, 'owned' | 'external'>
  }): WorkerTerminalResourceRow {
    const id = generateId('wtr')
    this.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle,
           pane_key, process_incarnation, host_scope, ownership_state, release_state,
           retained_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested', ?)`
      )
      .run(
        id,
        params.dispatchId,
        params.dispatchId,
        params.worktreeId,
        params.terminalHandle,
        params.paneKey,
        params.processIncarnation,
        params.hostScope ?? null,
        params.ownership,
        params.ownership === 'external' ? 'external_terminal' : null
      )
    return this.getWorkerTerminalResource(id) as WorkerTerminalResourceRow
  }

  getWorkerTerminalResource(id: string): WorkerTerminalResourceRow | undefined {
    return this.db.prepare('SELECT * FROM worker_terminal_resources WHERE id = ?').get(id) as
      | WorkerTerminalResourceRow
      | undefined
  }

  getWorkerTerminalResourceByOwner(dispatchId: string): WorkerTerminalResourceRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_terminal_resources WHERE owner_dispatch_id = ?')
      .get(dispatchId) as WorkerTerminalResourceRow | undefined
  }

  getWorkerTerminalResourceFormerlyOwnedBy(
    dispatchId: string
  ): WorkerTerminalResourceRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM worker_terminal_resources
          WHERE prior_owner_dispatch_ids LIKE ?
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(`%"${dispatchId}"%`) as WorkerTerminalResourceRow | undefined
  }

  // Reusable exact settled terminal: transfers cleanup ownership to the new Dispatch and fences
  // release through the old owner. No transaction: composes inside the authority transaction.
  transferWorkerTerminalResourceStatement(params: {
    resourceId: string
    toDispatchId: string
    terminalHandle: string
    paneKey: string
    processIncarnation: string
    hostScope: string | null
  }): WorkerTerminalResourceRow {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    const priorOwners = JSON.parse(resource.prior_owner_dispatch_ids) as string[]
    priorOwners.push(resource.owner_dispatch_id)
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET owner_dispatch_id = ?, prior_owner_dispatch_ids = ?, release_state = 'not_requested',
             retained_reason = NULL, release_requested_at = NULL, release_completed_at = NULL,
             release_error = NULL, terminal_handle = ?, pane_key = ?, process_incarnation = ?,
             host_scope = ?, updated_at = datetime('now')
         WHERE id = ? AND ownership_state = 'owned'`
      )
      .run(
        params.toDispatchId,
        JSON.stringify(priorOwners),
        params.terminalHandle,
        params.paneKey,
        params.processIncarnation,
        params.hostScope,
        params.resourceId
      )
    return this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
  }

  // Finds an owned, settled, exact-match resource for an explicitly reused terminal.
  findTransferableWorkerTerminalResource(params: {
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope: string | null
  }): WorkerTerminalResourceRow | undefined {
    if (!params.paneKey || !params.processIncarnation) {
      return undefined
    }
    const candidates = this.db
      .prepare(
        `SELECT r.* FROM worker_terminal_resources r
           JOIN worker_dispatches w ON w.dispatch_id = r.owner_dispatch_id
          WHERE r.process_incarnation = ? AND r.host_scope IS ?
            AND r.ownership_state != 'released'`
      )
      .all(params.processIncarnation, params.hostScope) as WorkerTerminalResourceRow[]
    const exact = candidates.filter(
      (candidate) =>
        candidate.pane_key &&
        params.paneKey &&
        isEquivalentPaneKey(candidate.pane_key, params.paneKey) &&
        candidate.process_incarnation === params.processIncarnation &&
        candidate.host_scope === params.hostScope
    )
    if (
      exact.some((candidate) =>
        ['requested', 'releasing', 'unknown'].includes(candidate.release_state)
      )
    ) {
      throw new OrchestrationError(
        'terminal_release_in_progress',
        `Terminal ${params.terminalHandle} has a release in progress; wait for cleanup or use another terminal.`
      )
    }
    return exact.find(
      (candidate) =>
        candidate.ownership_state === 'owned' &&
        ['not_requested', 'retained'].includes(candidate.release_state) &&
        ['succeeded', 'failed', 'stopped', 'abandoned'].includes(
          this.getWorkerDispatch(candidate.owner_dispatch_id)?.state ?? ''
        )
    )
  }

  workerTerminalResourceHasIdentityConflict(resourceId: string): boolean {
    const resource = this.getWorkerTerminalResource(resourceId)
    if (!resource?.pane_key || !resource.process_incarnation) {
      return true
    }
    const candidates = this.db
      .prepare(
        `SELECT * FROM worker_terminal_resources
          WHERE process_incarnation = ? AND host_scope IS ?
            AND id != ? AND ownership_state != 'released'`
      )
      .all(
        resource.process_incarnation,
        resource.host_scope,
        resource.id
      ) as WorkerTerminalResourceRow[]
    return candidates.some(
      (candidate) =>
        candidate.pane_key &&
        isEquivalentPaneKey(candidate.pane_key, resource.pane_key as string) &&
        candidate.process_incarnation === resource.process_incarnation &&
        candidate.host_scope === resource.host_scope
    )
  }

  requestWorkerTerminalRelease(dispatchId: string):
    | { disposition: 'requested'; resource: WorkerTerminalResourceRow }
    | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
    | {
        disposition: 'retained'
        resource: WorkerTerminalResourceRow | null
        reason: WorkerTerminalRetainedReason
      } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const worker = this.getWorkerDispatch(dispatchId)
      if (!worker) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
      }
      if (!WORKER_SETTLED_STATES.includes(worker.state)) {
        // Why: release is post-completion cleanup only; recording intent for an unsettled or
        // uncertain worker would let recovery close a terminal the coordinator never reviewed.
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is ${worker.state}; only a settled worker can release. Use worker-stop to cancel an active worker.`
        )
      }
      const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
      if (!resource) {
        const transferred = this.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)
        this.db.exec('COMMIT')
        return transferred
          ? { disposition: 'retained', resource: transferred, reason: 'ownership_transferred' }
          : { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
      }
      if (resource.release_state === 'released' || resource.ownership_state === 'released') {
        this.db.exec('COMMIT')
        return { disposition: 'already_released', resource }
      }
      if (worker.state === 'stopped' || worker.state === 'abandoned') {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource, reason: 'identity_unproven' }
      }
      if (resource.ownership_state === 'external') {
        this.db.exec('COMMIT')
        return {
          disposition: 'retained',
          resource,
          reason: (resource.retained_reason as WorkerTerminalRetainedReason) ?? 'external_terminal'
        }
      }
      if (resource.ownership_state === 'user_owned') {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource, reason: 'user_takeover' }
      }
      if (resource.ownership_state === 'transferred') {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource, reason: 'ownership_transferred' }
      }
      if (
        resource.release_state === 'unknown' ||
        (resource.release_state === 'retained' && resource.retained_reason === 'user_requested')
      ) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(dispatchId)
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = CASE
                 WHEN release_state = 'releasing' THEN 'releasing'
                 ELSE 'requested'
               END,
               retained_reason = NULL,
               release_requested_at = COALESCE(release_requested_at, datetime('now')),
               release_error = NULL, updated_at = datetime('now')
           WHERE id = ? AND release_state IN ('not_requested', 'retained', 'requested', 'releasing', 'unknown')`
        )
        .run(resource.id)
      this.db.exec('COMMIT')
      return {
        disposition: 'requested',
        resource: this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  settleDeadWorkerTerminalRelease(params: {
    requestingDispatchId: string
    resourceId: string
    processIncarnation: string
  }):
    | { disposition: 'released'; resource: WorkerTerminalResourceRow }
    | { disposition: 'retained'; resource: WorkerTerminalResourceRow } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const resource = this.getWorkerTerminalResource(params.resourceId)
      if (!resource) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker terminal resource ${params.resourceId} was not found.`
        )
      }
      const priorOwners = parseWorkerTerminalPriorOwnerIds(resource.prior_owner_dispatch_ids)
      const requesterRelated =
        resource.owner_dispatch_id === params.requestingDispatchId ||
        priorOwners?.includes(params.requestingDispatchId) === true
      const requester = this.getWorkerDispatch(params.requestingDispatchId)
      const owner = this.getWorkerDispatch(resource.owner_dispatch_id)
      const requesterSettled = Boolean(requester && WORKER_SETTLED_STATES.includes(requester.state))
      const ownerSettled = Boolean(owner && WORKER_SETTLED_STATES.includes(owner.state))
      if (
        !priorOwners ||
        !requesterRelated ||
        !requesterSettled ||
        !ownerSettled ||
        resource.process_incarnation !== params.processIncarnation ||
        resource.ownership_state === 'released' ||
        !['not_requested', 'retained', 'unknown'].includes(resource.release_state)
      ) {
        this.db.exec('COMMIT')
        return { disposition: 'retained', resource }
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = 'released', ownership_state = 'released', retained_reason = NULL,
               release_requested_at = COALESCE(release_requested_at, datetime('now')),
               release_completed_at = datetime('now'), release_error = NULL,
               updated_at = datetime('now')
           WHERE id = ? AND process_incarnation = ? AND ownership_state != 'released'
             AND release_state IN ('not_requested', 'retained', 'unknown')`
        )
        .run(params.resourceId, params.processIncarnation)
      const released = this.getWorkerTerminalResource(
        params.resourceId
      ) as WorkerTerminalResourceRow
      this.db.exec('COMMIT')
      return released.release_state === 'released'
        ? { disposition: 'released', resource: released }
        : { disposition: 'retained', resource: released }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  storeWorkerTerminalArchive(params: {
    dispatchId: string
    resourceId: string
    kind: 'transcript_pin' | 'terminal_tail'
    content: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dispatch_id) DO UPDATE SET
           resource_id = excluded.resource_id, kind = excluded.kind, content = excluded.content`
      )
      .run(params.dispatchId, params.resourceId, params.kind, params.content)
  }

  commitWorkerTerminalArchiveForRelease(params: {
    dispatchId: string
    resourceId: string
    kind?: 'transcript_pin' | 'terminal_tail'
    content?: string
    archiveSource: 'transcript' | 'terminal'
    archiveStatus: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
  }): WorkerTerminalResourceRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const resource = this.getWorkerTerminalResource(params.resourceId)
      if (
        resource?.owner_dispatch_id === params.dispatchId &&
        resource.ownership_state === 'owned' &&
        resource.release_state === 'requested'
      ) {
        if (params.kind && params.content !== undefined) {
          this.storeWorkerTerminalArchive({
            dispatchId: params.dispatchId,
            resourceId: params.resourceId,
            kind: params.kind,
            content: params.content
          })
        }
        const archive = this.getWorkerTerminalArchive(params.dispatchId)
        if (!archive || archive.resource_id !== params.resourceId) {
          throw new OrchestrationError(
            'archive_failed',
            `Output could not be preserved for Dispatch ${params.dispatchId}; the terminal was retained.`
          )
        }
        this.db
          .prepare(
            `UPDATE worker_terminal_resources
             SET release_state = 'releasing', archive_source = ?, archive_status = ?,
                 updated_at = datetime('now')
             WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
               AND release_state = 'requested'`
          )
          .run(params.archiveSource, params.archiveStatus, params.resourceId, params.dispatchId)
      }
      const updated = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
      this.db.exec('COMMIT')
      return updated
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getWorkerTerminalArchive(dispatchId: string): WorkerTerminalArchiveRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_terminal_archives WHERE dispatch_id = ?')
      .get(dispatchId) as WorkerTerminalArchiveRow | undefined
  }

  settleWorkerTerminalRelease(resourceId: string): WorkerTerminalResourceRow {
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'released', ownership_state = 'released',
             release_completed_at = datetime('now'), release_error = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('requested', 'releasing', 'unknown')`
      )
      .run(resourceId)
    return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
  }

  markWorkerTerminalReleaseUnknown(resourceId: string, reason: string): WorkerTerminalResourceRow {
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'unknown', release_error = ?, updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('requested', 'releasing')`
      )
      .run(reason, resourceId)
    return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
  }

  revertWorkerTerminalReleaseToRetained(
    resourceId: string,
    reason: WorkerTerminalRetainedReason
  ): WorkerTerminalResourceRow {
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained', retained_reason = ?, updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('requested', 'releasing')`
      )
      .run(reason, resourceId)
    return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
  }

  retainWorkerTerminalResource(
    dispatchId: string
  ):
    | { disposition: 'retained'; resource: WorkerTerminalResourceRow }
    | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
    | { disposition: 'release_committed'; resource: WorkerTerminalResourceRow }
    | { disposition: 'no_owned_resource'; resource: null } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
      if (!resource) {
        this.db.exec('COMMIT')
        return { disposition: 'no_owned_resource', resource: null }
      }
      if (resource.release_state === 'released') {
        this.db.exec('COMMIT')
        return { disposition: 'already_released', resource }
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = 'retained', retained_reason = 'user_requested',
               updated_at = datetime('now')
           WHERE id = ? AND release_state IN ('not_requested', 'retained', 'requested')`
        )
        .run(resource.id)
      const updated = this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
      if (updated.release_state !== 'retained') {
        this.db.exec('COMMIT')
        return { disposition: 'release_committed', resource: updated }
      }
      this.db.prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?').run(dispatchId)
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource: updated }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Real user input relinquishes orchestration ownership durably; programmatic prompt delivery,
  // query auto-replies, resize, and output never reach this path.
  markWorkerTerminalUserOwned(paneKey: string): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const exact = this.db
        .prepare(
          `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
            WHERE pane_key = ? AND ownership_state = 'owned'
              AND release_state IN ('not_requested', 'retained', 'requested')`
        )
        .all(paneKey) as { id: string; owner_dispatch_id: string; pane_key: string }[]
      const candidates =
        exact.length > 0
          ? exact
          : (
              this.db
                .prepare(
                  `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
                  WHERE ownership_state = 'owned'
                    AND release_state IN ('not_requested', 'retained', 'requested')
                    AND pane_key IS NOT NULL`
                )
                .all() as { id: string; owner_dispatch_id: string; pane_key: string }[]
            ).filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
      const update = this.db.prepare(
        `UPDATE worker_terminal_resources
         SET ownership_state = 'user_owned', release_state = 'retained',
             retained_reason = 'user_takeover', updated_at = datetime('now')
         WHERE id = ? AND ownership_state = 'owned'
           AND release_state IN ('not_requested', 'retained', 'requested')`
      )
      let changed = 0
      for (const candidate of candidates) {
        const result = Number(update.run(candidate.id).changes)
        if (result > 0) {
          this.db
            .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
            .run(candidate.owner_dispatch_id)
          changed += result
        }
      }
      this.db.exec('COMMIT')
      return changed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listWorkerTerminalReleaseBacklog(): WorkerTerminalResourceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM worker_terminal_resources
          WHERE release_state IN ('requested', 'releasing')
          ORDER BY release_requested_at ASC`
      )
      .all() as WorkerTerminalResourceRow[]
  }

  listWorkerTerminalResources(params: { runId?: string } = {}): {
    dispatchId: string
    taskId: string
    runId: string
    workerState: WorkerDispatchState
    dispatchStatus: DispatchStatus
    agentTerminalHandle: string | null
    lastHeartbeatAt: string | null
    terminalState: WorkerTerminalListState | null
    resource: WorkerTerminalResourceRow | null
  }[] {
    const rows = this.db
      .prepare(
        `SELECT w.dispatch_id, w.state AS worker_state, w.agent_terminal_handle,
                d.task_id, d.run_id, d.status AS dispatch_status, d.last_heartbeat_at
           FROM worker_dispatches w
           JOIN dispatch_contexts d ON d.id = w.dispatch_id
          ${params.runId ? 'WHERE d.run_id = ?' : ''}
          ORDER BY w.created_at ASC`
      )
      .all(...(params.runId ? [params.runId] : [])) as {
      dispatch_id: string
      worker_state: WorkerDispatchState
      agent_terminal_handle: string | null
      task_id: string
      run_id: string
      dispatch_status: DispatchStatus
      last_heartbeat_at: string | null
    }[]
    const resources = this.db
      .prepare(
        `SELECT r.* FROM worker_terminal_resources r
           JOIN dispatch_contexts d ON d.id = r.owner_dispatch_id
          ${params.runId ? 'WHERE d.run_id = ?' : ''}`
      )
      .all(...(params.runId ? [params.runId] : [])) as WorkerTerminalResourceRow[]
    const resourceByOwner = new Map(
      resources.map((resource) => [resource.owner_dispatch_id, resource])
    )
    return rows.map((row) => {
      const resource = resourceByOwner.get(row.dispatch_id) ?? null
      return {
        dispatchId: row.dispatch_id,
        taskId: row.task_id,
        runId: row.run_id,
        workerState: row.worker_state,
        dispatchStatus: row.dispatch_status,
        agentTerminalHandle: row.agent_terminal_handle,
        lastHeartbeatAt: row.last_heartbeat_at,
        terminalState: deriveWorkerTerminalListState({
          workerState: row.worker_state,
          agentTerminalHandle: row.agent_terminal_handle,
          resource
        }),
        resource
      }
    })
  }

  createDispatchContext(
    taskId: string,
    assigneeHandle: string,
    // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
    assigneePaneKey?: string,
    launchTokenHash?: string,
    processIncarnation?: string
  ): DispatchContextRow {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    if (task.status !== 'ready') {
      throw new Error(`Task ${taskId} is ${task.status}; only ready tasks can be dispatched`)
    }

    // Why: lock on pane identity too, so a reminted handle can't open a second concurrent dispatch on the same pane.
    const existing = this.findActiveDispatchForAssignee(assigneeHandle, assigneePaneKey)

    if (existing) {
      throw new Error(
        `Terminal ${assigneeHandle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
      )
    }

    // Carry forward failure_count so the circuit breaker accumulates across retries for the same task.
    const prior = this.db
      .prepare('SELECT MAX(failure_count) as max_failures FROM dispatch_contexts WHERE task_id = ?')
      .get(taskId) as { max_failures: number | null } | undefined
    const priorFailures = prior?.max_failures ?? 0

    const id = generateId('ctx')
    this.db
      .prepare(
        `INSERT INTO dispatch_contexts (
           id, run_id, task_id, contract_version, launch_token_hash,
           assignee_handle, assignee_pane_key, process_incarnation,
           status, failure_count, dispatched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, datetime('now'))`
      )
      .run(
        id,
        task.run_id,
        taskId,
        CURRENT_CONTRACT_VERSION,
        launchTokenHash ?? null,
        assigneeHandle,
        assigneePaneKey ?? null,
        processIncarnation ?? null,
        priorFailures
      )
    this.hasAnyDispatchContextsCache = true

    this.db.prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ?").run(taskId)

    return this.db
      .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
      .get(id) as DispatchContextRow
  }

  getDispatchContext(taskId: string): DispatchContextRow | undefined {
    return this.db
      .prepare('SELECT * FROM dispatch_contexts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(taskId) as DispatchContextRow | undefined
  }

  getDispatchContextById(dispatchId: string): DispatchContextRow | undefined {
    return this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(dispatchId) as
      | DispatchContextRow
      | undefined
  }

  commitDispatchLaunchTokenHash(dispatchId: string, launchTokenHash: string): DispatchContextRow {
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (dispatch.contract_version !== CURRENT_CONTRACT_VERSION) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${dispatchId} does not use the current contract.`
      )
    }
    if (dispatch.launch_token_hash && dispatch.launch_token_hash !== launchTokenHash) {
      throw new OrchestrationError(
        'request_mismatch',
        `Dispatch ${dispatchId} already has a different launch-token commitment.`
      )
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET launch_token_hash = COALESCE(launch_token_hash, ?)
         WHERE id = ?`
      )
      .run(launchTokenHash, dispatchId)
    return this.getDispatchContextById(dispatchId) as DispatchContextRow
  }

  mintDispatchCapability(params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
  }): string {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not active.`
      )
    }
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_hash = ?, assignee_pane_key = ?, process_incarnation = ?,
             capability_revoked_at = NULL
         WHERE id = ?`
      )
      .run(
        hashDispatchCapability(capability),
        params.paneKey,
        params.processIncarnation,
        params.dispatchId
      )
    return capability
  }

  verifyDispatchCapability(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | undefined
    processIncarnation: string | undefined
  }): { valid: true } | { valid: false; reason: string } {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch) {
      return { valid: false, reason: `Dispatch ${params.dispatchId} was not found.` }
    }
    if (!dispatch.capability_hash) {
      return { valid: false, reason: `Dispatch ${params.dispatchId} has no lifecycle capability.` }
    }
    if (dispatch.capability_revoked_at) {
      return { valid: false, reason: `Dispatch ${params.dispatchId} capability is revoked.` }
    }
    if (!params.capability) {
      return { valid: false, reason: 'The Dispatch capability is missing.' }
    }
    const expected = Buffer.from(dispatch.capability_hash, 'hex')
    const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
    if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
      return { valid: false, reason: 'The Dispatch capability is invalid.' }
    }
    if (
      !dispatch.assignee_pane_key ||
      !params.paneKey ||
      !isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
    ) {
      return { valid: false, reason: 'The caller is not the Dispatch pane.' }
    }
    if (
      !dispatch.process_incarnation ||
      !params.processIncarnation ||
      dispatch.process_incarnation !== params.processIncarnation
    ) {
      return { valid: false, reason: 'The Dispatch process incarnation changed.' }
    }
    return { valid: true }
  }

  revokeDispatchCapability(dispatchId: string): void {
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(dispatchId)
  }

  getActiveDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.findActiveDispatchForAssignee(handle)
  }

  /**
   * Cheap "are there any dispatch rows at all" probe. When false, no terminal
   * can have an active or recent-completed dispatch, so orchestration-context
   * builders can skip their per-terminal query fan-out entirely. Cached after
   * the first probe; createDispatchContext marks it true, resets clear it.
   */
  hasAnyDispatchContexts(): boolean {
    if (this.hasAnyDispatchContextsCache === undefined) {
      const row = this.db.prepare('SELECT 1 FROM dispatch_contexts LIMIT 1').get()
      this.hasAnyDispatchContextsCache = row !== undefined
    }
    return this.hasAnyDispatchContextsCache
  }

  getActiveDispatchForIdentity(handle: string, paneKey?: string): DispatchContextRow | undefined {
    return this.findActiveDispatchForAssignee(handle, paneKey)
  }

  private findActiveDispatchForAssignee(
    assigneeHandle: string,
    assigneePaneKey?: string
  ): DispatchContextRow | undefined {
    const byHandle = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE assignee_handle = ? AND status IN ('pending', 'dispatched') LIMIT 1"
      )
      .get(assigneeHandle) as DispatchContextRow | undefined
    if (byHandle) {
      return byHandle
    }

    if (!assigneePaneKey) {
      return undefined
    }

    const actives = this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE assignee_pane_key IS NOT NULL
           AND status IN ('pending', 'dispatched')
           AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?`
      )
      .all(paneKeyMatchSuffix(assigneePaneKey)) as DispatchContextRow[]

    for (const row of actives) {
      if (row.assignee_pane_key && isEquivalentPaneKey(row.assignee_pane_key, assigneePaneKey)) {
        return row
      }
    }
    return undefined
  }

  getLatestDispatchForTerminal(handle: string): DispatchContextRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM dispatch_contexts WHERE assignee_handle = ? ORDER BY rowid DESC LIMIT 1'
      )
      .get(handle) as DispatchContextRow | undefined
  }

  completeDispatch(ctxId: string): void {
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now'), capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')) WHERE id = ?"
      )
      .run(ctxId)
  }

  completeActiveDispatchForTask(taskId: string): void {
    const active = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as DispatchContextRow | undefined
    if (active) {
      this.completeDispatch(active.id)
    }
  }

  settleWorkerReport(params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }): WorkerReportSettlement {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const settlement = this.settleWorkerReportInTransaction(params)
      this.db.exec('COMMIT')
      return settlement
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private settleWorkerReportInTransaction(params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }): WorkerReportSettlement {
    const task = this.getTask(params.taskId)
    if (!task) {
      return { action: 'rejected', code: 'unknown_task', reason: `Unknown task ${params.taskId}.` }
    }
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch) {
      return {
        action: 'rejected',
        code: 'unknown_dispatch',
        reason: `Unknown dispatch ${params.dispatchId}.`
      }
    }
    if (dispatch.task_id !== params.taskId) {
      return {
        action: 'rejected',
        code: 'task_dispatch_mismatch',
        reason: `Dispatch ${params.dispatchId} belongs to task ${dispatch.task_id}, not ${params.taskId}.`
      }
    }

    const expectedDispatchStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
    const expectedTaskStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
    if (dispatch.status === expectedDispatchStatus && task.status === expectedTaskStatus) {
      return { action: 'settled', outcome: params.outcome, duplicate: true }
    }
    if (dispatch.status !== 'dispatched' || task.status !== 'dispatched') {
      return {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `inactive dispatch ${params.dispatchId}: it or task ${params.taskId} is already settled.`
      }
    }
    const latest = this.getDispatchContext(params.taskId)
    if (latest?.id !== params.dispatchId) {
      return {
        action: 'rejected',
        code: 'stale_dispatch',
        reason: `Dispatch ${params.dispatchId} is not the current dispatch for task ${params.taskId}.`
      }
    }

    this.db.exec('SAVEPOINT settle_worker_report')
    const dispatchUpdate = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = ?, completed_at = datetime('now'),
             last_failure = CASE WHEN ? = 'failed' THEN ? ELSE last_failure END,
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(expectedDispatchStatus, expectedDispatchStatus, params.result, params.dispatchId)
    const taskUpdate = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, result = ?, completed_at = datetime('now')
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(expectedTaskStatus, params.result, params.taskId)
    if (dispatchUpdate.changes !== 1 || taskUpdate.changes !== 1) {
      this.db.exec('ROLLBACK TO settle_worker_report')
      this.db.exec('RELEASE settle_worker_report')
      return {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `Dispatch ${params.dispatchId} changed while its worker report was settling.`
      }
    }
    this.db
      .prepare(
        `UPDATE worker_dispatches
         SET state = ?, stage = 'settled', updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'ready'`
      )
      .run(params.outcome === 'succeeded' ? 'succeeded' : 'failed', params.dispatchId)
    this.closeQuestionsForDispatch(params.dispatchId)
    if (params.outcome === 'succeeded') {
      this.promoteReadyTasks(params.taskId)
    }
    this.db.exec('RELEASE settle_worker_report')
    return { action: 'settled', outcome: params.outcome, duplicate: false }
  }

  failActiveDispatchForTask(taskId: string, error: string): DispatchContextRow | undefined {
    const active = this.db
      .prepare(
        "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
      )
      .get(taskId) as DispatchContextRow | undefined
    return active ? this.failDispatch(active.id, error) : undefined
  }

  // Why the same guard as recordHeartbeat: a park recorded against a settled or retried Dispatch
  // would hand a liveness window an exemption the live worker never earned (A1 §14).
  markDispatchBlocked(dispatchId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET blocked_since = ? WHERE id = ? AND status = 'dispatched'"
      )
      .run(at, dispatchId)
  }

  clearDispatchBlocked(dispatchId: string): void {
    this.db
      .prepare(
        "UPDATE dispatch_contexts SET blocked_since = NULL WHERE id = ? AND status = 'dispatched'"
      )
      .run(dispatchId)
  }

  // Why: only bump status='dispatched' — a zombie heartbeat from a finished dispatch would mask a hung retry from the stale detector (§5.3.4).
  // Why clear the breach here: one escalation per silence, re-armed by the evidence that the worker
  // came back. The same guard keeps a late heartbeat from a failed retry off the live Dispatch's row.
  recordHeartbeat(dispatchId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE dispatch_contexts SET last_heartbeat_at = ?, liveness_breached_at = NULL
         WHERE id = ? AND status = 'dispatched'`
      )
      .run(at, dispatchId)
  }

  // Why the join, not dispatch_contexts alone: only a supervised worker-start was handed the
  // preamble that promises a heartbeat cadence, and only it carries a start_options window. A
  // legacy `orchestration.run` dispatch context has no worker row and is never judged here.
  listDispatchLivenessCandidates(): DispatchLivenessCandidateRow[] {
    return this.db
      .prepare(
        `SELECT d.id, d.run_id, d.task_id, d.dispatched_at, d.last_heartbeat_at, d.blocked_since,
                w.start_options,
                EXISTS (SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id = d.id) AS federated
         FROM dispatch_contexts d
         JOIN worker_dispatches w ON w.dispatch_id = d.id
         WHERE d.status = 'dispatched' AND d.liveness_breached_at IS NULL`
      )
      .all() as DispatchLivenessCandidateRow[]
  }

  // Why the join to tasks: reading the spec back is what lets an observer re-armed after a restart
  // ask the same question it asked at worker-start. Federated Dispatches are excluded — the home
  // never sees that PTY — and the state/status/release predicates are also the observer's disarm.
  listDispatchInputObservationTargets(dispatchId?: string): DispatchInputObservationTargetRow[] {
    return this.db
      .prepare(
        `SELECT w.dispatch_id, d.run_id, d.task_id, w.agent_terminal_handle,
                d.process_incarnation, w.input_evidence, d.last_heartbeat_at, t.spec
         FROM worker_dispatches w
         JOIN dispatch_contexts d ON d.id = w.dispatch_id
         JOIN tasks t ON t.id = d.task_id
         WHERE w.state = 'ready' AND d.status = 'dispatched'
           AND w.input_observed_at IS NULL
           AND w.agent_terminal_handle IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id = w.dispatch_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM worker_terminal_resources r
             WHERE r.owner_dispatch_id = w.dispatch_id
               AND r.release_state IN ('requested', 'releasing', 'released')
           )
           AND (? IS NULL OR w.dispatch_id = ?)`
      )
      .all(dispatchId ?? null, dispatchId ?? null) as DispatchInputObservationTargetRow[]
  }

  // Why claim-before-emit and once per Dispatch rather than once per kind: the report exists to
  // hand the decision to a coordinator, and a second machine-written escalation about the same
  // worker adds no decision — the liveness window still covers whatever happens after it.
  claimDispatchInputObservation(dispatchId: string, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE worker_dispatches SET input_observed_at = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND state = 'ready' AND input_observed_at IS NULL`
        )
        .run(at, dispatchId).changes > 0
    )
  }

  // Why the peer asks its relay queue and not a heartbeat column: it has none — a federated
  // worker's heartbeats are queued here and stamped on the home at import. The one excluded kind is
  // the one only this runtime writes, so the exclusion is provenance and not a type a worker can
  // also send (`send --type status` enqueues kind='status' verbatim).
  hasFederatedWorkerSpoken(dispatchId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = 'to_home'
           AND kind != 'runtime_notification'
         LIMIT 1`
      )
      .get(dispatchId)
  }

  // Why releasable: the claim is only honest if a notice actually followed it, so a post that threw
  // hands the fence back and the next sweep re-reports instead of losing the breach forever.
  releaseDispatchLivenessBreach(dispatchId: string, at: string): void {
    this.db
      .prepare(
        'UPDATE dispatch_contexts SET liveness_breached_at = NULL WHERE id = ? AND liveness_breached_at = ?'
      )
      .run(dispatchId, at)
  }

  // Why claim-before-emit: the column is the once-per-breach fence, so the writer that flips it is
  // the only one allowed to insert the escalation. Returns false when someone else already did.
  markDispatchLivenessBreached(dispatchId: string, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE dispatch_contexts SET liveness_breached_at = ?
           WHERE id = ? AND status = 'dispatched' AND liveness_breached_at IS NULL`
        )
        .run(at, dispatchId).changes > 0
    )
  }

  // Why: dispatched_at grace skips workers still within their first heartbeat interval; julianday() vs raw-TEXT compare avoids misflagging space-format timestamps as stale (#8452).
  getStaleDispatches(thresholdIso: string): DispatchContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE status = 'dispatched'
           AND dispatched_at IS NOT NULL
           AND julianday(dispatched_at) < julianday(?)
           AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) < julianday(?))`
      )
      .all(thresholdIso, thresholdIso) as DispatchContextRow[]
  }

  failDispatch(ctxId: string, error: string): DispatchContextRow | undefined {
    const ctx = this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
    if (!ctx) {
      return undefined
    }

    const newFailureCount = ctx.failure_count + 1
    const newStatus: DispatchStatus = newFailureCount >= 3 ? 'circuit_broken' : 'failed'

    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = ?, failure_count = ?, last_failure = ?,
             completed_at = COALESCE(completed_at, datetime('now')),
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ?`
      )
      .run(newStatus, newFailureCount, error, ctxId)

    // Why: back to 'ready' not 'pending' — 'pending' would strand it since promoteReadyTasks only runs when a dep completes.
    const taskStatus: TaskStatus = newStatus === 'circuit_broken' ? 'failed' : 'ready'
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskStatus, ctx.task_id)

    return this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
  }

  // ── Decision Gates ──

  createGate(gate: { taskId: string; question: string; options?: string[] }): DecisionGateRow {
    const id = generateId('gate')
    const optionsJson = JSON.stringify(gate.options ?? [])
    this.db
      .prepare(
        'INSERT INTO decision_gates (id, run_id, task_id, question, options) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        id,
        this.getTask(gate.taskId)?.run_id ?? LEGACY_RUN_ID,
        gate.taskId,
        gate.question,
        optionsJson
      )

    this.completeActiveDispatchForTask(gate.taskId)
    this.db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(gate.taskId)

    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as DecisionGateRow
  }

  resolveGate(gateId: string, resolution: string): DecisionGateRow | undefined {
    const gate = this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
    if (!gate) {
      return undefined
    }

    this.db
      .prepare(
        "UPDATE decision_gates SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?"
      )
      .run(resolution, gateId)

    // Why: set to 'ready' (not the previous status) so the coordinator re-dispatches the worker with the resolution context.
    this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(gate.task_id)

    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
  }

  timeoutGate(gateId: string): DecisionGateRow | undefined {
    this.db
      .prepare(
        "UPDATE decision_gates SET status = 'timeout', resolved_at = datetime('now') WHERE id = ?"
      )
      .run(gateId)
    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(gateId) as
      | DecisionGateRow
      | undefined
  }

  listGates(filter?: { taskId?: string; status?: GateStatus }): DecisionGateRow[] {
    if (filter?.taskId && filter?.status) {
      return this.db
        .prepare(
          'SELECT * FROM decision_gates WHERE task_id = ? AND status = ? ORDER BY created_at'
        )
        .all(filter.taskId, filter.status) as DecisionGateRow[]
    }
    if (filter?.taskId) {
      return this.db
        .prepare('SELECT * FROM decision_gates WHERE task_id = ? ORDER BY created_at')
        .all(filter.taskId) as DecisionGateRow[]
    }
    if (filter?.status) {
      return this.db
        .prepare('SELECT * FROM decision_gates WHERE status = ? ORDER BY created_at')
        .all(filter.status) as DecisionGateRow[]
    }
    return this.db
      .prepare('SELECT * FROM decision_gates ORDER BY created_at')
      .all() as DecisionGateRow[]
  }

  getGate(id: string): DecisionGateRow | undefined {
    return this.db.prepare('SELECT * FROM decision_gates WHERE id = ?').get(id) as
      | DecisionGateRow
      | undefined
  }

  // ── Coordinator Runs ──

  createCoordinatorRun(run: {
    spec: string
    coordinatorHandle: string
    pollIntervalMs?: number
  }): CoordinatorRun {
    const id = generateId('run')
    this.db
      .prepare(
        "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, poll_interval_ms) VALUES (?, ?, 'running', ?, ?)"
      )
      .run(id, run.spec, run.coordinatorHandle, run.pollIntervalMs ?? 2000)
    return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as CoordinatorRun
  }

  getCoordinatorRun(id: string): CoordinatorRun | undefined {
    return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as
      | CoordinatorRun
      | undefined
  }

  updateCoordinatorRun(id: string, status: CoordinatorStatus): CoordinatorRun | undefined {
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    this.db
      .prepare(
        'UPDATE coordinator_runs SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?'
      )
      .run(status, completedAt, id)
    return this.getCoordinatorRun(id)
  }

  getActiveCoordinatorRun(): CoordinatorRun | undefined {
    return this.db
      .prepare(
        "SELECT * FROM coordinator_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as CoordinatorRun | undefined
  }

  // ── Queries for Coordinator ──

  getIdleTerminals(excludeHandles: string[] = []): string[] {
    const active = this.db
      .prepare(
        "SELECT DISTINCT assignee_handle FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')"
      )
      .all() as { assignee_handle: string }[]
    const busyHandles = new Set(active.map((r) => r.assignee_handle))
    for (const h of excludeHandles) {
      busyHandles.add(h)
    }
    // Return handles from message history that aren't busy
    const allHandles = this.db
      .prepare(
        'SELECT DISTINCT to_handle FROM messages UNION SELECT DISTINCT from_handle FROM messages'
      )
      .all() as { to_handle: string }[]
    return [...new Set(allHandles.map((r) => r.to_handle))].filter((h) => !busyHandles.has(h))
  }

  // ── Lifecycle ──

  private runResetTransaction(statements: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(statements)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  resetAll(): void {
    // Why: retain mutation receipts so a lost reset response cannot replay as a new mutation.
    this.runResetTransaction(`
      DELETE FROM coordinator_runs;
      DELETE FROM decision_gates;
      DELETE FROM remote_questions;
      DELETE FROM question_threads;
      DELETE FROM deliveries;
      DELETE FROM legacy_mail_receipts;
      DELETE FROM legacy_operation_receipts;
      DELETE FROM legacy_compatibility_principals;
      DELETE FROM legacy_adoptions;
      DELETE FROM federation_relay_items;
      DELETE FROM remote_dispatch_attachments;
      -- S10-19: peer_run_grants is dispatch-scoped federation state, purged alongside attachments.
      DELETE FROM peer_run_grants;
      DELETE FROM federated_dispatches;
      -- S10-15 ruling 3(a): remote_agents was unpurgeable before this slice (breaker finding 2).
      DELETE FROM remote_agents;
      -- S10-15 (INV-P-006): agent_rate is peer-writable (checkAndBumpRate, agent-rate-limit.ts)
      -- and must be purgeable like every other coordination-bus table.
      DELETE FROM agent_rate;
      -- S10-16 R14.3 (v5, P10): peer_reply_outbox and peer_link_confirm_observations are the two
      -- link-binding tables NOT exempt from resetAll — the outbox is coordination-bus state and
      -- confirm observations are the only table a peer's own call causes a row in (INV-P-006(b)).
      -- The other four — bindings, attempts, scan facts, containment — stay out (this host's own
      -- proofs and its operator's own decisions); see A2_RESET_EXEMPT_TABLES for the ONE list.
      DELETE FROM peer_reply_outbox;
      DELETE FROM peer_link_confirm_observations;
      DELETE FROM worker_terminal_archives;
      DELETE FROM worker_terminal_resources;
      DELETE FROM worker_dispatches;
      DELETE FROM dispatch_contexts;
      DELETE FROM tasks;
      DELETE FROM messages;
      DELETE FROM runs;
      INSERT INTO runs (id, objective, home_database, consumer_generation, legacy)
        VALUES ('${LEGACY_RUN_ID}', 'Legacy orchestration state (inspect only)', 'this_database', 0, 1);
    `)
    this.hasAnyDispatchContextsCache = undefined
  }

  resetTasks(): void {
    this.runResetTransaction(`
      DELETE FROM coordinator_runs;
      DELETE FROM decision_gates;
      DELETE FROM remote_questions;
      DELETE FROM question_threads;
      DELETE FROM legacy_mail_receipts;
      DELETE FROM legacy_operation_receipts;
      DELETE FROM legacy_compatibility_principals;
      DELETE FROM legacy_adoptions;
      DELETE FROM federation_relay_items;
      DELETE FROM remote_dispatch_attachments;
      -- S10-19: peer_run_grants is dispatch-scoped federation state, purged alongside attachments.
      DELETE FROM peer_run_grants;
      DELETE FROM federated_dispatches;
      DELETE FROM worker_terminal_archives;
      DELETE FROM worker_terminal_resources;
      DELETE FROM worker_dispatches;
      DELETE FROM dispatch_contexts;
      DELETE FROM tasks;
    `)
    this.hasAnyDispatchContextsCache = undefined
  }

  resetMessages(): void {
    // Why: relay rows carry contiguous cross-server cursors, not just inbox history.
    // S10-16 R14.3 (v5, P18) / F10: cancel every queued AND 'sending' outbox row BEFORE deleting
    // messages — without this the outbox's self-contained payload would still ship a
    // conversation the operator just purged. 'sending' too: without the durable in-flight state
    // a claimed item stays 'queued' while its RPC runs, so this cancel would hit it and the
    // item's own settle would then write 'delivered' straight over the cancellation.
    // The cancel itself is `cancelQueuedReplyOutbox` (reply-outbox-store.ts) — the ONE
    // definition of "cancel queued/sending outbox rows", not restated here — called inside this
    // same BEGIN IMMEDIATE/COMMIT so it stays atomic with the message deletes below.
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      cancelQueuedReplyOutboxImpl(this.db, now)
      this.db.exec(`
        DELETE FROM legacy_mail_receipts;
        DELETE FROM question_threads;
        DELETE FROM deliveries;
        DELETE FROM messages;
      `)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

function parseFederatedWorkerReportOutcome(payload: string): WorkerReportOutcome | undefined {
  try {
    const message = JSON.parse(payload) as { payload?: unknown }
    if (typeof message.payload !== 'string') {
      return undefined
    }
    const report = JSON.parse(message.payload) as { outcome?: unknown }
    return report.outcome === 'succeeded' || report.outcome === 'failed'
      ? report.outcome
      : undefined
  } catch {
    return undefined
  }
}
