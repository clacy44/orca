// [S10-21c B4c, D-R154-b4b findings 1/2/4] Split out of agent-lineage-mismatch.ts to stay under
// the max-lines ratchet — same precedent as agent-lineage-contest-audit.ts's chore split.
// Conjunct (iii)'s transcript check (one recursive filesystem walk) memoized per (host, pane,
// reported id) for the CURRENT launch generation: POSITIVE cached for the whole generation (a
// transcript that carries a turn cannot lose it), NEGATIVE on a short doubling backoff (a
// transcript may still gain its first turn later — B4b cached negatives permanently, which made
// that unobservable, D-R154 finding 1). A per-pane distinct-reported-id counter bounds how many
// DIFFERENT ids can ever pay a walk in one generation (D-R154 finding 4). Structural params
// (not imported from agent-lineage-mismatch.ts) so this split introduces no import cycle.
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
/** At most this many DISTINCT reported ids per pane, per generation, ever pay a walk. */
const DISTINCT_REPORTED_ID_CHURN_LIMIT = 8
const ID_CHURN_AUDIT_VERB = 'live_report_id_churn_bounded'
const ID_CHURN_REFUSAL_NOTE = 'live_report_id_churn_bounded'

type CachedTranscriptVerdict =
  | { ok: true }
  | { ok: false; note?: string; nextRetryAt: number; backoffMs: number }

let transcriptVerdictGeneration: string | undefined
const transcriptVerdictCache = new Map<string, CachedTranscriptVerdict>()
const distinctReportedIdsSeenByPane = new Map<string, Set<string>>()

/** [D-R154 finding 4] Audited ONCE, deduped on (verb, outcome) — NOT the reason code, unlike the
 * mismatch/bootstrap audits, since a varying reported id would otherwise defeat that dedupe too. */
function writeIdChurnAuditOnce(
  db: Database.Database,
  params: { hostId: string; paneKey: string }
): void {
  const newest = db
    .prepare(
      `SELECT outcome FROM agent_audit
         WHERE actor_pane_key = ? AND verb = ?
         ORDER BY seq DESC LIMIT 1`
    )
    .get(params.paneKey, ID_CHURN_AUDIT_VERB) as { outcome: string } | undefined
  if (newest?.outcome === 'refused') {
    return
  }
  writeAgentAudit(db, {
    agentId: null,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: ID_CHURN_AUDIT_VERB,
    outcome: 'refused',
    reasonCode: `distinct_ids_exceeded limit=${DISTINCT_REPORTED_ID_CHURN_LIMIT}`
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
  const key = `${params.hostId}:${params.paneKey}:${params.reportedSessionId}`
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
    seenIds = new Set()
    distinctReportedIdsSeenByPane.set(paneChurnKey, seenIds)
  }
  if (!seenIds.has(params.reportedSessionId) && seenIds.size >= DISTINCT_REPORTED_ID_CHURN_LIMIT) {
    writeIdChurnAuditOnce(db, params)
    return { ok: false, note: ID_CHURN_REFUSAL_NOTE }
  }
  seenIds.add(params.reportedSessionId)
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
