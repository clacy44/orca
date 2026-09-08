// [S10-21c B4c/B4d, D-R154-b4b findings 1/2/4; D-R156 findings 1/3/5] Split out of
// agent-lineage-mismatch.ts to stay under the max-lines ratchet — same precedent as
// agent-lineage-contest-audit.ts's chore split.
// Conjunct (iii)'s transcript check (one recursive filesystem walk) memoized per (host, pane,
// AGENT TYPE, reported id) for the CURRENT launch generation [D-R156 finding 1: the key must
// cover the memoized resolver's full domain — agentType gates coverage AND selects the file
// search, so a positive earned under one agent type must not be served for another]: POSITIVE
// cached for the whole generation (a transcript that carries a turn cannot lose it), NEGATIVE on
// a short doubling backoff (a transcript may still gain its first turn later — B4b cached
// negatives permanently, which made that unobservable, D-R154 finding 1). A per-pane
// distinct-reported-id counter bounds how many DIFFERENT ids can ever pay a walk in a ROLLING
// window, not for the whole generation [D-R156 finding 3: a generation-scoped bound never decays
// and can leave S3/S5 permanently dead for a legitimately churning pane until an app restart];
// older entries age out of the window on their own. Structural params (not imported from
// agent-lineage-mismatch.ts) so this split introduces no import cycle.
import type Database from '../../sqlite/sync-database'
import { writeAgentAudit } from './agent-audit-log'

export type LiveReportTranscriptVerdict =
  | { path: string; hasTurn: boolean }
  | { coverage: 'uncovered' }
  | null

export type ResolveLiveReportTranscript = (
  agentType: string,
  sessionId: string
) => Promise<LiveReportTranscriptVerdict>

const TRANSCRIPT_VERDICT_CACHE_MAX = 512
/** First negative retry after 60s, doubling each re-check, capped at 15 min. */
const NEGATIVE_TRANSCRIPT_BACKOFF_INITIAL_MS = 60_000
const NEGATIVE_TRANSCRIPT_BACKOFF_CAP_MS = 15 * 60_000
/** At most this many DISTINCT reported ids per pane may pay a walk inside the rolling window
 * below [D-R156 finding 3] — older ids age out on their own, so the bound refills over time
 * instead of sitting dead for the rest of the generation. */
const DISTINCT_REPORTED_ID_CHURN_LIMIT = 8
/** [D-R156 finding 3] The rolling window matches the negative backoff cap: a churn-refused id is
 * always retryable again within the same span a stuck negative verdict would recover on its own. */
const DISTINCT_REPORTED_ID_CHURN_WINDOW_MS = NEGATIVE_TRANSCRIPT_BACKOFF_CAP_MS
const ID_CHURN_AUDIT_VERB = 'live_report_id_churn_bounded'
export const ID_CHURN_REFUSAL_NOTE = 'live_report_id_churn_bounded'

type CachedTranscriptVerdict =
  | { ok: true }
  | { ok: false; note?: string; nextRetryAt: number; backoffMs: number }

let transcriptVerdictGeneration: string | undefined
const transcriptVerdictCache = new Map<string, CachedTranscriptVerdict>()
/** pane churn key -> (reported id -> when it first paid a walk, this window). */
const distinctReportedIdsSeenByPane = new Map<string, Map<string, number>>()

/** [D-R156 finding 3] Drops entries older than the rolling window in place — called before every
 * size check so an aged-out id no longer counts against the budget. */
function pruneAgedOutChurnEntries(seenIds: Map<string, number>, now: number): void {
  for (const [id, seenAt] of seenIds) {
    if (now - seenAt >= DISTINCT_REPORTED_ID_CHURN_WINDOW_MS) {
      seenIds.delete(id)
    }
  }
}

/** [D-R154 finding 4; D-R156 finding 5] Audited ONCE PER GENERATION, deduped on (outcome,
 * reason_code) where the reason code carries the generation — NOT (verb, outcome) alone, which
 * dedupes for the life of the database and leaves later generations' churn silently unaudited. */
function writeIdChurnAuditOnce(
  db: Database.Database,
  params: { hostId: string; paneKey: string; launchGeneration: string }
): void {
  const reasonCode = `distinct_ids_exceeded limit=${DISTINCT_REPORTED_ID_CHURN_LIMIT} gen=${params.launchGeneration}`
  const newest = db
    .prepare(
      `SELECT outcome, reason_code FROM agent_audit
         WHERE actor_pane_key = ? AND verb = ?
         ORDER BY seq DESC LIMIT 1`
    )
    .get(params.paneKey, ID_CHURN_AUDIT_VERB) as
    | { outcome: string; reason_code: string | null }
    | undefined
  if (newest?.outcome === 'refused' && newest.reason_code === reasonCode) {
    return
  }
  writeAgentAudit(db, {
    agentId: null,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: ID_CHURN_AUDIT_VERB,
    outcome: 'refused',
    reasonCode
  })
}

/** [S10-21c B4, design §2 S3/S5 conjunct (iii)] `{path, hasTurn:true}` is real; `{coverage}` is
 * S4's third state and REFUSES here (the sweep only notes it and proceeds; this path is deciding
 * whether to believe an id the PANE authored, so an unverifiable transcript is no check at all). */
async function checkTranscriptConjunct(
  resolveResumeTranscript: ResolveLiveReportTranscript,
  agentType: string,
  sessionId: string
): Promise<{ ok: true } | { ok: false; note?: string }> {
  const transcript = await resolveResumeTranscript(agentType, sessionId)
  if (transcript !== null && 'coverage' in transcript) {
    return { ok: false, note: `resume_preflight_uncovered ${agentType}` }
  }
  if (!transcript || !transcript.hasTurn) {
    return { ok: false }
  }
  return { ok: true }
}

export async function checkTranscriptConjunctMemoized(
  db: Database.Database,
  resolveResumeTranscript: ResolveLiveReportTranscript,
  agentType: string,
  params: { hostId: string; paneKey: string; reportedSessionId: string; launchGeneration: string }
): Promise<{ ok: true } | { ok: false; note?: string }> {
  if (transcriptVerdictGeneration !== params.launchGeneration) {
    transcriptVerdictGeneration = params.launchGeneration
    transcriptVerdictCache.clear()
    distinctReportedIdsSeenByPane.clear()
  }
  // [D-R156 finding 1] agentType is part of the key: it gates coverage AND selects the file
  // search inside the resolver, so a positive earned under one agent type must never be served
  // for a check made under a different one.
  const key = `${params.hostId}:${params.paneKey}:${agentType}:${params.reportedSessionId}`
  const cached = transcriptVerdictCache.get(key)
  if (cached?.ok) {
    return { ok: true }
  }
  const now = Date.now()
  if (cached && !cached.ok && now < cached.nextRetryAt) {
    return { ok: false, note: cached.note }
  }
  const paneChurnKey = `${params.hostId}:${params.paneKey}`
  let seenIds = distinctReportedIdsSeenByPane.get(paneChurnKey)
  if (!seenIds) {
    seenIds = new Map()
    distinctReportedIdsSeenByPane.set(paneChurnKey, seenIds)
  }
  pruneAgedOutChurnEntries(seenIds, now)
  if (!seenIds.has(params.reportedSessionId) && seenIds.size >= DISTINCT_REPORTED_ID_CHURN_LIMIT) {
    writeIdChurnAuditOnce(db, params)
    return { ok: false, note: ID_CHURN_REFUSAL_NOTE }
  }
  seenIds.set(params.reportedSessionId, now)
  const verdict = await checkTranscriptConjunct(
    resolveResumeTranscript,
    agentType,
    params.reportedSessionId
  )
  if (
    !transcriptVerdictCache.has(key) &&
    transcriptVerdictCache.size >= TRANSCRIPT_VERDICT_CACHE_MAX
  ) {
    const oldest = transcriptVerdictCache.keys().next().value
    if (oldest !== undefined) {
      transcriptVerdictCache.delete(oldest)
    }
  }
  if (verdict.ok) {
    transcriptVerdictCache.set(key, { ok: true })
  } else {
    const backoffMs =
      cached && !cached.ok
        ? Math.min(cached.backoffMs * 2, NEGATIVE_TRANSCRIPT_BACKOFF_CAP_MS)
        : NEGATIVE_TRANSCRIPT_BACKOFF_INITIAL_MS
    transcriptVerdictCache.set(key, {
      ok: false,
      note: verdict.note,
      nextRetryAt: now + backoffMs,
      backoffMs
    })
  }
  return verdict
}

/** Test-only: module-scoped state survives across `it()` blocks — reset between cases. */
export function resetTranscriptVerdictCacheForTests(): void {
  transcriptVerdictGeneration = undefined
  transcriptVerdictCache.clear()
  distinctReportedIdsSeenByPane.clear()
}
