import { describe, expect, it } from 'vitest'
import {
  AGENT_RESOLVER_MARGIN,
  AGENT_RESOLVER_THRESHOLD,
  type AgentResolverCandidateInput,
  resolveAgentQuery,
  scoreAgentCandidate
} from './agent-resolver'
import { deriveDisplayName } from './agent-derivation'

function candidate(
  overrides: Partial<AgentResolverCandidateInput> = {}
): AgentResolverCandidateInput {
  return {
    id: 'agt_1',
    displayName: 'merge-restructure-backend',
    role: null,
    title: null,
    worktreePath: null,
    branch: null,
    state: 'idle',
    derived: false,
    ...overrides
  }
}

describe('resolveAgentQuery', () => {
  it('S1: honest fixture resolves with high confidence and names matched tokens', () => {
    const honest = candidate({
      id: 'agt_honest',
      role: 'backend for the merge restructure'
    })
    const result = resolveAgentQuery('the merge-restructure backend agent', [honest])
    expect(result.outcome).toBe('resolved')
    expect(result.candidates[0]?.id).toBe('agt_honest')
    expect(result.candidates[0]?.confidence).toBeGreaterThanOrEqual(0.9)
    expect(result.candidates[0]?.why.length).toBeGreaterThan(0)
  })

  it('S2: two registered lookalikes are ambiguous, both candidates printed, nothing addressed', () => {
    const a = candidate({
      id: 'agt_a',
      displayName: 'merge-restructure-backend',
      role: 'backend for the merge restructure'
    })
    const b = candidate({
      id: 'agt_b',
      displayName: 'merge-restructure-frontend',
      role: 'frontend for the merge restructure'
    })
    const result = resolveAgentQuery('the merge-restructure agent', [a, b])
    expect(result.outcome).toBe('ambiguous')
    expect(result.candidates.map((c) => c.id).sort()).toEqual(['agt_a', 'agt_b'])
    // JSON shape parity (owner decision 2): ambiguous candidates carry the same shape as resolved.
    for (const c of result.candidates) {
      expect(c).toHaveProperty('confidence')
      expect(c).toHaveProperty('why')
    }
  })

  it('S3: a stuffed role loses to the honest 3-token role on every fixture query', () => {
    const stuffedTopics = [
      'security',
      'audit',
      'vulnerability',
      'exploit',
      'backend',
      'frontend',
      'database',
      'network',
      'deploy',
      'release',
      'testing',
      'review',
      'merge',
      'restructure',
      'schema',
      'migration',
      'auth',
      'payments',
      'billing',
      'infra',
      'monitoring',
      'logging'
    ]
    const stuffed = candidate({
      id: 'agt_stuffed',
      displayName: 'stuffed-role-agent',
      role: stuffedTopics.join(' ')
    })
    const honest = candidate({
      id: 'agt_honest',
      displayName: 'merge-restructure-backend',
      role: 'backend for the merge restructure'
    })

    const queries = [
      'the merge-restructure backend agent',
      'who handles the backend for the merge restructure',
      'find the backend agent for the merge restructure',
      'merge restructure backend',
      'the agent handling merge and restructure backend work'
    ]

    for (const query of queries) {
      const stuffedScore = scoreAgentCandidate(query, stuffed).score
      const honestScore = scoreAgentCandidate(query, honest).score
      expect(stuffedScore).toBeLessThanOrEqual(0.3)
      expect(honestScore).toBeGreaterThan(stuffedScore)
    }
  })

  it('S4: a derived idle row for the right branch scores at or above threshold', () => {
    // Why deriveDisplayName and not a hand-built displayName: a hand-built fixture can drift
    // from what production actually mints (this is exactly what happened before — a fixture
    // shaped 'merge-restructure-claude-code-a1b2' passed while the real deriveAgentLabelSlug
    // truncated the branch name to fit the long product label and scored below threshold).
    const displayName = deriveDisplayName({
      branch: 'merge-restructure',
      worktreePath: '/home/ubuntu/worktrees/merge-restructure',
      title: '* working on the schema freeze'
    })
    const derivedRow = candidate({
      id: 'agt_derived',
      displayName,
      role: null,
      title: '* working on the schema freeze',
      branch: 'merge-restructure',
      derived: true,
      state: 'idle'
    })
    const result = resolveAgentQuery('find the merge-restructure claude agent', [derivedRow])
    expect(result.candidates[0]?.confidence).toBeGreaterThanOrEqual(AGENT_RESOLVER_THRESHOLD)
  })

  it('no_match when nothing clears the threshold', () => {
    const unrelated = candidate({
      displayName: 'docs-reviewer-agent',
      role: 'reviews unrelated documentation'
    })
    const result = resolveAgentQuery('the merge-restructure backend agent', [unrelated])
    expect(result.outcome).toBe('no_match')
  })

  it('a gone/quarantined-looking low-liveness candidate scores lower than a live one', () => {
    const live = candidate({
      id: 'agt_live',
      role: 'backend for the merge restructure',
      state: 'live'
    })
    const gone = candidate({
      id: 'agt_gone',
      role: 'backend for the merge restructure',
      state: 'gone'
    })
    const liveScore = scoreAgentCandidate('the merge-restructure backend agent', live).score
    const goneScore = scoreAgentCandidate('the merge-restructure backend agent', gone).score
    expect(liveScore).toBeGreaterThan(goneScore)
  })

  it('derived rows are penalized relative to an otherwise-identical registered row', () => {
    const registered = candidate({
      id: 'agt_reg',
      role: 'backend for the merge restructure',
      derived: false
    })
    const derived = candidate({
      id: 'agt_der',
      role: 'backend for the merge restructure',
      derived: true
    })
    const registeredScore = scoreAgentCandidate(
      'the merge-restructure backend agent',
      registered
    ).score
    const derivedScore = scoreAgentCandidate('the merge-restructure backend agent', derived).score
    expect(registeredScore).toBeGreaterThan(derivedScore)
  })

  it('never auto-addresses: resolved still returns the full candidate list (owner decision 2)', () => {
    const only = candidate({ role: 'backend for the merge restructure' })
    const result = resolveAgentQuery('the merge-restructure backend agent', [only])
    expect(result.outcome).toBe('resolved')
    expect(result.candidates).toHaveLength(1)
  })

  // Mutation proof: reverting the denominator to matched/|Q| (the original A3 bug) makes a
  // heavily-stuffed role score 1.0 whenever every query token happens to appear in it.
  it('MUTATION PROOF: denominator cap defeats the naive matched/|Q| scoring', () => {
    const stuffed = candidate({
      role: Array.from({ length: 20 }, (_, i) => `topic${i}`)
        .concat(['merge', 'restructure'])
        .join(' ')
    })
    const query = 'merge restructure'
    const { score } = scoreAgentCandidate(query, stuffed)
    // Naive matched/|Q| would score (2/2)*0.9(idle) = 0.9 here (both query tokens present).
    // The denominator cap (max(|Q|, min(|F|,12))) instead divides by 12, giving ~0.15.
    expect(score).toBeLessThan(0.5)
  })
})

describe('AGENT_RESOLVER_MARGIN threshold behavior', () => {
  it('two candidates within the margin are ambiguous even if both clear the threshold', () => {
    const a = candidate({ id: 'agt_a', role: 'backend for the merge restructure work' })
    const b = candidate({ id: 'agt_b', role: 'backend for the merge restructure task' })
    const result = resolveAgentQuery('backend for the merge restructure', [a, b])
    if (result.candidates.length > 1) {
      const gap = (result.candidates[0]?.confidence ?? 0) - (result.candidates[1]?.confidence ?? 0)
      if (gap < AGENT_RESOLVER_MARGIN) {
        expect(result.outcome).toBe('ambiguous')
      }
    }
  })
})
