// S10-1 resolver (A3): deterministic, host-side, no model call. Scores a plain-English query
// against directory candidates by token overlap, cascading role > display_name > title >
// worktree/branch — the first field with any match wins, so a keyword-stuffed role cannot
// borrow relevance from a field the honest candidate would have scored on instead. The
// denominator `max(|Q|, min(|F|,12))` caps how much a long stuffed field can dilute its own
// score down, while a short honest field still normalizes against the query length.

export const AGENT_RESOLVER_THRESHOLD = 0.45
export const AGENT_RESOLVER_MARGIN = 0.15
export const AGENT_RESOLVER_DERIVED_PENALTY = 0.85
export const AGENT_RESOLVER_MAX_FIELD_TOKENS = 12

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

type ScoredField = { field: FieldName; score: number; matchedTokens: string[] }
type FieldName = 'role' | 'name' | 'title' | 'worktree'

// Priority order: the first field with any overlap wins (cascade) — this IS the "role, then
// name, then title, then worktree/branch" ordering. worktree/branch carries a lower weight on
// top of that ordering because it is the weakest identity signal (many agents can share a
// branch or worktree naming convention); the other three are equally trustworthy once reached.
const FIELD_WEIGHTS: Record<FieldName, number> = {
  role: 1,
  name: 1,
  title: 1,
  worktree: 0.7
}

function scoreField(field: FieldName, text: string, queryTokens: string[]): ScoredField | null {
  const fieldTokens = tokenize(text)
  if (fieldTokens.length === 0 || queryTokens.length === 0) {
    return null
  }
  const fieldTokenSet = new Set(fieldTokens)
  const matchedTokens = queryTokens.filter((token) => fieldTokenSet.has(token))
  if (matchedTokens.length === 0) {
    return null
  }
  const denominator = Math.max(
    queryTokens.length,
    Math.min(fieldTokens.length, AGENT_RESOLVER_MAX_FIELD_TOKENS)
  )
  const overlap = matchedTokens.length / denominator
  return {
    field,
    score: overlap * FIELD_WEIGHTS[field],
    matchedTokens: [...new Set(matchedTokens)]
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
  const worktreeText = [candidate.worktreePath, candidate.branch].filter(Boolean).join(' ')
  const fields: [FieldName, string | null][] = [
    ['role', candidate.role],
    ['name', candidate.displayName],
    ['title', candidate.title],
    ['worktree', worktreeText || null]
  ]
  let best: ScoredField | null = null
  for (const [field, text] of fields) {
    if (!text) {
      continue
    }
    const scored = scoreField(field, text, queryTokens)
    if (scored) {
      best = scored
      break // cascade: first field with any match wins, per the spec's field priority order
    }
  }
  if (!best) {
    return { score: 0, why: [] }
  }
  const liveness = LIVENESS_MULTIPLIER[candidate.state]
  const derivedPenalty = candidate.derived ? AGENT_RESOLVER_DERIVED_PENALTY : 1
  const score = Math.min(1, best.score * liveness * derivedPenalty)
  return { score, why: best.matchedTokens }
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
