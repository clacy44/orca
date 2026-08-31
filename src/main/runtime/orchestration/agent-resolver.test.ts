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
  //
  // displayName is explicitly overridden (not the shared 'merge-restructure-backend' default)
  // so this stays an isolated test of the role field's own denominator cap. Under F-A's
  // multi-field scoring (S10-7) the default displayName would itself exact-match the query and
  // dominate via the name field's 2x weight, masking the role-field regression this test guards.
  it('MUTATION PROOF: denominator cap defeats the naive matched/|Q| scoring', () => {
    const stuffed = candidate({
      displayName: 'unrelated-fixture-name',
      role: Array.from({ length: 20 }, (_, i) => `topic${i}`)
        .concat(['merge', 'restructure'])
        .join(' ')
    })
    const query = 'merge restructure'
    const { score } = scoreAgentCandidate(query, stuffed)
    // Naive matched/|Q| would score (2/2)*0.9(idle) = 0.9 here (both query tokens present).
    // The denominator cap (weight * min(|F|,16)) instead divides by 16, giving ~0.125.
    expect(score).toBeLessThan(0.5)
  })
})

// F-A acceptance tests (owner ruling, non-negotiable). Fixed field text lifted verbatim from
// the live measurement cited in the ruling where practical, so these stay tied to the reported
// regression rather than a convenient synthetic case.
describe('F-A acceptance tests', () => {
  // Live evidence: name 'vps-services-live', role a nine-clause description of the job. Under
  // the old cascade this scored 0.15 for "vps services" because role (checked first) matched
  // and diluted against its own length, and name never got a chance to score at all.
  const vpsServicesLive = candidate({
    id: 'agt_vps_live',
    displayName: 'vps-services-live',
    role: 'production VPS: services, deploys, watchers, routing, certs, backups, docs-bus watcher, box half of every rollout',
    state: 'live'
  })

  it('T1: the live vps-services-live case resolves at or above threshold for all three fixture queries', () => {
    for (const query of [
      'vps services',
      'the VPS services agent',
      'production VPS services and deploys'
    ]) {
      const { score } = scoreAgentCandidate(query, vpsServicesLive)
      expect(score).toBeGreaterThanOrEqual(AGENT_RESOLVER_THRESHOLD)
    }
  })

  it('T2: parity — the S1 honest fixture stays at or above 0.85', () => {
    const honest = candidate({
      id: 'agt_honest_parity',
      displayName: 'merge-restructure-backend',
      role: 'backend for the merge restructure'
    })
    const { score } = scoreAgentCandidate('the merge restructure backend agent', honest)
    expect(score).toBeGreaterThanOrEqual(0.85)
  })

  it('T3: a 50-keyword-stuffed role never outscores an exact-name-match candidate on a 2-3 token query', () => {
    const stuffedTopics = Array.from({ length: 50 }, (_, i) => `stuffedkeyword${i}`)
    // Splice a handful of real-looking topical tokens in among the noise so 2-3 of them can
    // legitimately match a query, same as a real (if overzealous) role write-up would.
    stuffedTopics.splice(10, 0, 'metrics', 'deploy', 'pipeline')
    const stuffed = candidate({
      id: 'agt_stuffed_50',
      displayName: 'stuffed-agent-zz',
      role: stuffedTopics.join(' ')
    })
    const exactName = candidate({
      id: 'agt_exact_metrics',
      displayName: 'metrics-deploy-pipeline',
      role: null
    })

    for (const query of ['metrics deploy', 'metrics deploy pipeline', 'deploy pipeline']) {
      const stuffedScore = scoreAgentCandidate(query, stuffed).score
      const exactScore = scoreAgentCandidate(query, exactName).score
      expect(stuffedScore).toBeLessThan(exactScore)
    }

    // A query matching ONLY stuffed-role tokens (nothing a real name/title would plausibly
    // contain) must stay under threshold — stuffing alone cannot buy a resolve.
    const stuffedOnlyQuery = 'stuffedkeyword3 stuffedkeyword4'
    expect(scoreAgentCandidate(stuffedOnlyQuery, stuffed).score).toBeLessThan(
      AGENT_RESOLVER_THRESHOLD
    )
  })

  it('T4: each of the four charter agents resolves from a natural phrasing of its own name', () => {
    const charterAgents: [string, AgentResolverCandidateInput, string][] = [
      [
        'backend-dll',
        candidate({
          id: 'agt_backend_dll',
          displayName: 'backend-dll',
          role: 'backend DLL: native module boundary, IPC bridge, build packaging, native rebuilds across platforms, worker threads'
        }),
        'the backend dll agent'
      ],
      [
        'frontend-stack',
        candidate({
          id: 'agt_frontend_stack',
          displayName: 'frontend-stack',
          role: 'frontend stack: renderer UI, component library, IPC client, theming, terminal panes'
        }),
        'the frontend agent'
      ],
      [
        'player-overlay',
        candidate({
          id: 'agt_player_overlay',
          displayName: 'player-overlay',
          role: 'player overlay: in-game HUD, capture pipeline, overlay window management, hotkeys, streaming layer'
        }),
        'the player overlay agent'
      ],
      [
        'vps-services',
        candidate({
          id: 'agt_vps_services',
          displayName: 'vps-services',
          role: 'production VPS: services, deploys, watchers, routing, certs, backups, docs-bus watcher, box half of every rollout'
        }),
        'the vps services agent'
      ]
    ]

    for (const [name, agent, query] of charterAgents) {
      const result = resolveAgentQuery(query, [agent])
      expect(result.outcome, `${name} should resolve for "${query}"`).toBe('resolved')
      expect(result.candidates[0]?.confidence ?? 0).toBeGreaterThanOrEqual(AGENT_RESOLVER_THRESHOLD)
    }
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
