// S10-1 resolver (A3), rebalanced under S10-7 fix F-A: deterministic, host-side, no model call.
// Scores a plain-English query against directory candidates by weighted token overlap.
//
// F-A field evidence: the original cascade ("first field with any match wins, role > name >
// title > worktree") let a long, honest, detailed role win the cascade over a short exact-name
// match purely because role happened to be checked first — then diluted its own score against
// that field's size. A live pane named `vps-services-live` with a nine-clause role describing
// its job scored 0.15 for the query "vps services" even though the name itself was an exact
// two-token match, because the cascade never let the name field score at all once role matched.
//
// Fix shape (owner ruling F-A, builder-refined): stopword-filter the query; distinct-token
// matching only (repeated tokens in a field never add extra credit); score every field
// independently instead of cascading, weighting a NAME token match 2x a role/title/worktree
// token match; take the best-scoring field per candidate; then multiply by a global
// `queryCoverage` term (the fraction of the query's distinct tokens found in ANY field) so a
// detailed role that corroborates a partial name match still lifts the score — detail helps
// findability instead of only diluting it. Each field's own denominator
// (`weight * distinct field tokens`, capped at AGENT_RESOLVER_MAX_FIELD_TOKENS) keeps a
// stuffed field from claiming an exact-match-sized score just because it happens to contain
// every query token somewhere in a wall of keywords.

export const AGENT_RESOLVER_THRESHOLD = 0.45
export const AGENT_RESOLVER_MARGIN = 0.15
export const AGENT_RESOLVER_DERIVED_PENALTY = 0.85
// Cap on a single field's *weighted* size (weight * distinct token count) used as that field's
// scoring denominator. A short honest field (typically name) normalizes against its own small
// size; a long stuffed field (typically role) is capped here so its score-per-match floor stays
// bounded no matter how many extra keywords are piled on.
export const AGENT_RESOLVER_MAX_FIELD_TOKENS = 16

// Liveness multiplier: a spamming/idle-forever agent cannot outrank a live one purely by
// existing longer; 'gone' candidates are expected to be filtered out by the caller before
// scoring, but a defensive low multiplier is applied if one slips through.
const LIVENESS_MULTIPLIER: Record<'live' | 'idle' | 'gone', number> = {
  live: 1,
  idle: 0.9,
  gone: 0.5
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'is',
  'are',
  'to',
  'and',
  'agent',
  'that',
  'which',
  'this',
  'one'
])

function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
}

type FieldName = 'role' | 'name' | 'title' | 'worktree'

// name-token matches count 2x a role/title/worktree match (owner ruling F-A): the name is the
// field an operator actually types back at the CLI, so an exact or partial name hit is stronger
// identity evidence per token than the same token showing up in free-text role prose. worktree
// stays discounted below role/title — the weakest identity signal, since many agents can share
// a branch or worktree naming convention.
const FIELD_WEIGHTS: Record<FieldName, number> = {
  name: 2,
  role: 1,
  title: 1,
  worktree: 0.7
}

type FieldMatch = { field: FieldName; score: number; matchedTokens: string[] }

// Scores one field independently (no cascade): distinct query tokens matched in this field,
// weighted by FIELD_WEIGHTS, over this field's own weighted-and-capped size. Returns null when
// nothing in the field matches.
function scoreField(field: FieldName, text: string, queryTokenSet: Set<string>): FieldMatch | null {
  const fieldTokens = tokenize(text)
  if (fieldTokens.length === 0 || queryTokenSet.size === 0) {
    return null
  }
  const fieldTokenSet = new Set(fieldTokens)
  const matchedTokens = [...queryTokenSet].filter((token) => fieldTokenSet.has(token))
  if (matchedTokens.length === 0) {
    return null
  }
  const weight = FIELD_WEIGHTS[field]
  const weightedFieldSize = Math.min(weight * fieldTokenSet.size, AGENT_RESOLVER_MAX_FIELD_TOKENS)
  const weightedMatched = weight * matchedTokens.length
  return {
    field,
    score: weightedMatched / weightedFieldSize,
    matchedTokens
  }
}

export type AgentResolverCandidateInput = {
  id: string
  displayName: string
  role: string | null
  title: string | null
  worktreePath: string | null
  branch: string | null
  state: 'live' | 'idle' | 'gone'
  derived: boolean
}

export type AgentResolverScoredCandidate = {
  id: string
  displayName: string
  confidence: number
  derived: boolean
  state: 'live' | 'idle' | 'gone'
  why: string[]
}

export type AgentResolverOutcome = 'resolved' | 'ambiguous' | 'no_match'

export type AgentResolverResult = {
  outcome: AgentResolverOutcome
  query: string
  threshold: number
  margin: number
  candidates: AgentResolverScoredCandidate[]
}

/** Scores one candidate against a query. Exported standalone so S3's stuffed-role fixture and
 * S1's honest fixture can be asserted per-candidate, independent of the resolve() cascade. */
export function scoreAgentCandidate(
  query: string,
  candidate: AgentResolverCandidateInput
): { score: number; why: string[] } {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) {
    return { score: 0, why: [] }
  }
  const queryTokenSet = new Set(queryTokens)
  const worktreeText = [candidate.worktreePath, candidate.branch].filter(Boolean).join(' ')
  const fields: [FieldName, string | null][] = [
    ['name', candidate.displayName],
    ['role', candidate.role],
    ['title', candidate.title],
    ['worktree', worktreeText || null]
  ]

  let best: FieldMatch | null = null
  const matchedAnywhere = new Set<string>()
  for (const [field, text] of fields) {
    if (!text) {
      continue
    }
    const scored = scoreField(field, text, queryTokenSet)
    if (!scored) {
      continue
    }
    for (const token of scored.matchedTokens) {
      matchedAnywhere.add(token)
    }
    if (!best || scored.score > best.score) {
      best = scored
    }
  }
  if (!best) {
    return { score: 0, why: [] }
  }

  // Detail helps findability: a query whose tokens are corroborated across more of the
  // candidate's fields scores higher, even when no single field alone contains every token.
  const queryCoverage = matchedAnywhere.size / queryTokenSet.size

  const liveness = LIVENESS_MULTIPLIER[candidate.state]
  const derivedPenalty = candidate.derived ? AGENT_RESOLVER_DERIVED_PENALTY : 1
  const score = Math.min(1, queryCoverage * best.score * liveness * derivedPenalty)
  // Report matched tokens in query order, deduped, across every field that contributed —
  // richer explainability than a single field's matches now that fields aren't cascaded away.
  const why = queryTokens.filter(
    (token, index) => matchedAnywhere.has(token) && queryTokens.indexOf(token) === index
  )
  return { score, why }
}

/**
 * Resolves a plain-English query against a set of candidates. Never auto-addresses (owner
 * decision 2): `resolved` still returns the full candidate list, just with a single entry that
 * cleared the margin over the runner-up.
 */
export function resolveAgentQuery(
  query: string,
  candidates: AgentResolverCandidateInput[]
): AgentResolverResult {
  const scored = candidates
    .map((candidate) => {
      const { score, why } = scoreAgentCandidate(query, candidate)
      const result: AgentResolverScoredCandidate = {
        id: candidate.id,
        displayName: candidate.displayName,
        confidence: score,
        derived: candidate.derived,
        state: candidate.state,
        why
      }
      return result
    })
    .filter((candidate) => candidate.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)

  if (scored.length === 0 || (scored[0]?.confidence ?? 0) < AGENT_RESOLVER_THRESHOLD) {
    return {
      outcome: 'no_match',
      query,
      threshold: AGENT_RESOLVER_THRESHOLD,
      margin: AGENT_RESOLVER_MARGIN,
      candidates: scored
    }
  }

  const top = scored[0] as AgentResolverScoredCandidate
  const runnerUp = scored[1]
  const ambiguous =
    runnerUp !== undefined && top.confidence - runnerUp.confidence < AGENT_RESOLVER_MARGIN
  return {
    outcome: ambiguous ? 'ambiguous' : 'resolved',
    query,
    threshold: AGENT_RESOLVER_THRESHOLD,
    margin: AGENT_RESOLVER_MARGIN,
    candidates: scored
  }
}
