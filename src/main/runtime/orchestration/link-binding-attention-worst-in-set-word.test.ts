// S10-16 C8b, Ruling 28(i)/ML-4: the attention line's worst-IN-SET-word selection (never
// masked by a worse-but-out-of-set word) and resolveEnvironmentName's code-point-safe clamp.
// Split out of link-binding-attention.test.ts to stay under max-lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  describeLinkBindingHealth,
  describeLinkBindingAttention,
  resolveEnvironmentName
} from './link-binding-attention'
import { LINK_BINDING_ATTENTION_ENVIRONMENT_NAME_CLAMP } from './link-binding-constants'
import type { LinkBindingSelfView } from '../device-registry-link-credential'

function workingSelfView(): LinkBindingSelfView {
  return {
    registryCredentialFingerprint: () => null,
    ownKeyFingerprint: () => null,
    macWithRegistryToken: () => null,
    listRuntimeLinkCandidates: () => [],
    listRuntimeScopeDeviceIds: () => [],
    registryLoadSucceeded: () => true
  }
}

describe('describeLinkBindingAttention: worst in-set word / resolveEnvironmentName clamp', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {} as never
    })
    runtime.setOrchestrationDb(db)
    runtime.linkBindingSelfView = workingSelfView()
    runtime.getLinkBindingProver()
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(
      (selector: string) => ({ name: `desktop`, id: selector }) as never
    )
  })

  afterEach(() => {
    db.close()
  })

  // Ruling 28(i): a test per masking pair — a word OUTSIDE LINK_BINDING_ATTENTION_HEALTH that
  // outranks (is earlier in LINK_BINDING_HEALTH_PRECEDENCE than) an in-set word also present on
  // the same link must never suppress the in-set word from the attention line. `word` (the total-
  // precedence pick, used elsewhere) still reads the masking word; `attentionWord` and the line
  // must read the in-set one.
  describe('Ruling 28(i): the attention line selects the worst IN-SET word, never a masking one', () => {
    it('excluded (not in-set) does not mask parked (in-set)', () => {
      db.putContainment({
        subjectKind: 'link',
        subjectId: 'link_excl_parked',
        action: 'scan_exclude',
        reasonCode: 'test',
        reasonText: 'test',
        detail: null,
        createdAt: Date.now(),
        expiresAt: null
      })
      db.putBindingAttempt('link_excl_parked')
      db.settleBindingAttempt('link_excl_parked', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'unpaired_parked',
        lastDetail: null,
        consecutiveFailures: 0,
        consecutiveNoWinner: 3,
        nextAttemptAfter: null
      })
      const health = describeLinkBindingHealth(db, runtime, 'link_excl_parked')
      expect(health.word).toBe('excluded')
      expect(health.attentionWord).toBe('parked')
      const line = describeLinkBindingAttention(db, runtime)
      expect(line).toContain('1 parked')
      expect(line).not.toMatch(/excluded/)
    })

    it('peer_duplicate (not in-set) does not mask unavailable (in-set)', () => {
      runtime.linkBindingSelfView = null
      db.putBindingAttempt('link_pd_unavail')
      db.settleBindingAttempt('link_pd_unavail', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'peer_duplicate',
        lastDetail: null,
        consecutiveFailures: 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: null
      })
      const health = describeLinkBindingHealth(db, runtime, 'link_pd_unavail')
      expect(health.word).toBe('peer_duplicate')
      expect(health.attentionWord).toBe('unavailable')
      const line = describeLinkBindingAttention(db, runtime)
      expect(line).toContain('1 unavailable')
      expect(line).not.toMatch(/peer_duplicate|peer reports a duplicate/)
    })

    it('peer_no_environments (not in-set) does not mask unavailable (in-set)', () => {
      runtime.linkBindingSelfView = null
      db.putBindingAttempt('link_pne_unavail')
      db.settleBindingAttempt('link_pne_unavail', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'unavailable',
        lastDetail: 'peer_no_environments',
        consecutiveFailures: 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: null
      })
      const health = describeLinkBindingHealth(db, runtime, 'link_pne_unavail')
      expect(health.word).toBe('peer_no_environments')
      expect(health.attentionWord).toBe('unavailable')
      const line = describeLinkBindingAttention(db, runtime)
      expect(line).toContain('1 unavailable')
      expect(line).not.toMatch(/no environments/)
    })

    it('duplicate_environment (not in-set) does not mask unavailable (in-set)', () => {
      runtime.linkBindingSelfView = null
      db.putBindingAttempt('link_de_unavail')
      db.settleBindingAttempt('link_de_unavail', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'duplicate_environment',
        lastDetail: null,
        consecutiveFailures: 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: null
      })
      const health = describeLinkBindingHealth(db, runtime, 'link_de_unavail')
      expect(health.word).toBe('duplicate_environment')
      expect(health.attentionWord).toBe('unavailable')
      const line = describeLinkBindingAttention(db, runtime)
      expect(line).toContain('1 unavailable')
      expect(line).not.toMatch(/duplicate environment/)
    })

    it('multi_grant (not in-set) does not mask unavailable (in-set)', () => {
      runtime.linkBindingSelfView = null
      db.putBindingAttempt('link_mg_unavail')
      db.settleBindingAttempt('link_mg_unavail', {
        lastAttemptAt: Date.now(),
        lastRoundAt: Date.now(),
        lastOutcome: 'multi_grant',
        lastDetail: null,
        consecutiveFailures: 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: null
      })
      const health = describeLinkBindingHealth(db, runtime, 'link_mg_unavail')
      expect(health.word).toBe('multi_grant')
      expect(health.attentionWord).toBe('unavailable')
      const line = describeLinkBindingAttention(db, runtime)
      expect(line).toContain('1 unavailable')
      expect(line).not.toMatch(/multiple grants/)
    })
  })

  // ML-4/F12: resolveEnvironmentName strips U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR — a
  // line-terminator many renderers split on but \r\n stripping alone misses) and clamps over
  // CODE POINTS, never UTF-16 units, so the clamp cannot split a surrogate pair.
  it('strips U+2028/U+2029 in addition to \\r\\n', () => {
    const evilName = 'evil' + '\u2028' + 'name' + '\u2029' + 'here'
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(
      () => ({ name: evilName, id: 'env_x' }) as never
    )
    const name = resolveEnvironmentName(runtime, 'env_x', 'link_x')
    expect(name).not.toMatch(/[\u2028\u2029]/)
    expect(name).toBe('evil name here')
  })

  it('clamps over code points, never splitting a surrogate pair at the boundary', () => {
    // U+1F600 (an astral emoji) is 2 UTF-16 code units; place it straddling the clamp boundary.
    const prefix = 'x'.repeat(LINK_BINDING_ATTENTION_ENVIRONMENT_NAME_CLAMP - 1)
    const astral = '\u{1F600}'
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(
      () => ({ name: prefix + astral, id: 'env_y' }) as never
    )
    const name = resolveEnvironmentName(runtime, 'env_y', 'link_y')
    // Exactly CLAMP code points, and the astral char at the boundary is kept WHOLE (its surrogate
    // pair together) — a UTF-16-unit slice would instead produce CLAMP *units*, i.e. CLAMP - 1
    // code points plus one lone leading surrogate.
    expect([...name]).toHaveLength(LINK_BINDING_ATTENTION_ENVIRONMENT_NAME_CLAMP)
    expect(name).toBe(prefix + astral)
    // No lone (unpaired) surrogate anywhere in the result.
    const hasLoneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)
    expect(hasLoneSurrogate).toBe(false)
  })
})
