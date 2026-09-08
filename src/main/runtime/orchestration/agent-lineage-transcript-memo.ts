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
//
// [S10-21d R107, chair decision, diag-r106-r110-2026-09-08.md] A THIRD verdict shape, `pending`
// (no file yet, or a zero-turn stub — never an observed negative), gets its own FIXED 10s retry
// (PENDING_TRANSCRIPT_RETRY_MS) instead of the escalating negative ladder above: a fork stub or a
// session seconds old may legitimately gain its first turn on the very next report, so treating
// it as an increasingly-unlikely-to-change negative was the exact staleness this fixes. Coexists
// with, rather than supersedes, D-R152-b4 finding 2 (a report inside the retry window still hits
// the cache and never re-walks) and D-R156 finding 3 (the churn budget is still charged
// unconditionally, pending or not — an id that will never produce a real transcript is exactly
// what that bound must keep catching).
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
/** [S10-21d R107, chair decision] A `pending` verdict (stub/zero-turn/not-yet-written transcript)
 * is cached as a negative on a FIXED 10s retry, never the escalating 60s->15min ladder above —
 * it is not an observed negative, so it must not be treated as increasingly unlikely to change.
 * Fixed, not doubling: a stub that stays a stub keeps retrying every 10s for as long as it is
 * seen (bounded overall by the churn budget below, which a pending verdict still charges — D-R156
 * finding 3 is unchanged; a new launch generation still clears the cache outright — D-R154
 * finding 1's generation-clear half is unaffected). Chosen to keep D-R152-b4 finding 2's own test
 * timing (an immediate re-report, elapsed 0) inside the cache window. */
const PENDING_TRANSCRIPT_RETRY_MS = 10_000
/** At most this many DISTINCT (reported id, agent type) PAIRS per pane may pay a walk inside the
 * rolling window below [D-R156 finding 3; S10-21c B-final, D-R158-b4d finding 2] — older pairs
 * age out on their own, so the bound refills over time instead of sitting dead for the rest of
 * the generation. Keyed on the PAIR, not the id alone: agentType selects the file search inside
 * the resolver (same reason the verdict-cache key covers it, D-R156 finding 1), so the same id
 * reported under a second agent type is a genuinely new walk, not a re-walk of the first. */
const DISTINCT_REPORTED_ID_CHURN_LIMIT = 8
/** [D-R156 finding 3] The rolling window matches the negative backoff cap: a churn-refused id is
 * always retryable again within the same span a stuck negative verdict would recover on its own. */
const DISTINCT_REPORTED_ID_CHURN_WINDOW_MS = NEGATIVE_TRANSCRIPT_BACKOFF_CAP_MS
const ID_CHURN_AUDIT_VERB = 'live_report_id_churn_bounded'
export const ID_CHURN_REFUSAL_NOTE = 'live_report_id_churn_bounded'

type CachedTranscriptVerdict =
  | { ok: true }
  | { ok: false; note?: string; nextRetryAt: number; backoffMs: number; pending?: boolean }

let transcriptVerdictGeneration: string | undefined
const transcriptVerdictCache = new Map<string, CachedTranscriptVerdict>()
/** pane churn key -> (`<reported id>:<agent type>` pair -> when it FIRST paid a walk, this
 * window — [S10-21c B-final, D-R158-b4d finding 4] never refreshed on a later re-walk of the
 * same pair, so this is a rate window ("N new pairs per window"), not an occupancy gauge that
 * a pane can hold full forever by keeping the same pairs hot). */
const distinctReportedIdsSeenByPane = new Map<string, Map<string, number>>()

/** [D-R156 finding 3] Drops entries older than the rolling window in place — called before every
 * size check so an aged-out pair no longer counts against the budget. */
function pruneAgedOutChurnEntries(seenIds: Map<string, number>, now: number): void {
  for (const [pairKey, seenAt] of seenIds) {
    if (now - seenAt >= DISTINCT_REPORTED_ID_CHURN_WINDOW_MS) {
      seenIds.delete(pairKey)
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
 * whether to believe an id the PANE authored, so an unverifiable transcript is no check at all).
 *
 * [S10-21d R107] `pending: true` distinguishes "no observation yet" (no file at all, or a
 * zero-turn stub — resolveResumeTranscript never reports `hasTurn:true` until a real record
 * lands, diag-r106-r110-2026-09-08.md) from `uncovered`'s genuine, stable negative: a fork stub
 * or a session only seconds old will legitimately gain its first turn on the very next report, so
 * it gets its own fixed, short retry (PENDING_TRANSCRIPT_RETRY_MS) rather than the escalating
 * 60s->15min ladder a genuine negative earns. */
async function checkTranscriptConjunct(
  resolveResumeTranscript: ResolveLiveReportTranscript,
  agentType: string,
  sessionId: string
): Promise<{ ok: true } | { ok: false; note?: string; pending?: boolean }> {
  const transcript = await resolveResumeTranscript(agentType, sessionId)
  if (transcript !== null && 'coverage' in transcript) {
    return { ok: false, note: `resume_preflight_uncovered ${agentType}` }
  }
  if (!transcript || !transcript.hasTurn) {
    return { ok: false, pending: true }
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
  // [S10-21c B-final, D-R158-b4d findings 2/4] Keyed on the (id, agentType) PAIR — the same
  // reported id under a different agent type is a new entry — and the timestamp is set ONLY the
  // FIRST time a pair is seen: a later re-walk of the same pair (e.g. a negative retrying off its
  // backoff) must not push its age-out further away, or a pane cycling the same handful of pairs
  // could hold the budget full indefinitely instead of the window actually refilling.
  const idChurnPairKey = `${params.reportedSessionId}:${agentType}`
  if (!seenIds.has(idChurnPairKey) && seenIds.size >= DISTINCT_REPORTED_ID_CHURN_LIMIT) {
    writeIdChurnAuditOnce(db, params)
    return { ok: false, note: ID_CHURN_REFUSAL_NOTE }
  }
  // [D-R156 finding 3 UNCHANGED by R107] Charged unconditionally, BEFORE the verdict is known —
  // the distinct-id churn bound exists to rate-limit how many DIFFERENT ids a pane may ever pay a
  // walk for (an anti-churn/anti-spoof property), which a pending verdict does not exempt: an id
  // that will NEVER produce a real transcript is exactly the case this bound must still catch, or
  // it stops bounding anything. R107 changes ONLY the negative-cache/backoff branch below.
  if (!seenIds.has(idChurnPairKey)) {
    seenIds.set(idChurnPairKey, now)
  }
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
  } else if (verdict.pending === true) {
    // [S10-21d R107] Fixed 10s retry, never the escalating ladder below — see
    // PENDING_TRANSCRIPT_RETRY_MS. Coexists with D-R152-b4 finding 2 (a report inside this
    // window still hits the cache, so it never re-walks) and D-R154 finding 1 (a new generation
    // still clears this entry, same as any other cache entry).
    transcriptVerdictCache.set(key, {
      ok: false,
      note: verdict.note,
      nextRetryAt: now + PENDING_TRANSCRIPT_RETRY_MS,
      backoffMs: PENDING_TRANSCRIPT_RETRY_MS,
      pending: true
    })
  } else {
    // [D-R154 finding 1] Doubling only carries forward from a PRIOR genuine negative — a cached
    // `pending` entry's fixed 10s must never seed the escalating ladder if this pair later
    // resolves to a genuine (non-pending) negative instead.
    const backoffMs =
      cached && !cached.ok && cached.pending !== true
        ? Math.min(cached.backoffMs * 2, NEGATIVE_TRANSCRIPT_BACKOFF_CAP_MS)
        : NEGATIVE_TRANSCRIPT_BACKOFF_INITIAL_MS
    transcriptVerdictCache.set(key, {
      ok: false,
      note: verdict.note,
      nextRetryAt: now + backoffMs,
      backoffMs
    })
  }
  // Never leak the internal `pending` discriminator past this function's own contract.
  return verdict.ok ? { ok: true } : { ok: false, note: verdict.note }
}

/** Test-only: module-scoped state survives across `it()` blocks — reset between cases. */
export function resetTranscriptVerdictCacheForTests(): void {
  transcriptVerdictGeneration = undefined
  transcriptVerdictCache.clear()
  distinctReportedIdsSeenByPane.clear()
}
