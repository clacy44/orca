import { describe, expect, it } from 'vitest'
import { evaluateMessageBodyGate } from './message-body-gate'

describe('evaluateMessageBodyGate', () => {
  it('T3: a heading-shaped audit line is HARD-blocked', () => {
    const v = evaluateMessageBodyGate({ body: 'MERGE-GATE AUDIT: CVE-2025-1234 unresolved' })
    expect(v.tier).toBe('hard')
    expect(v.tier === 'hard' && v.ruleIds).toContain('merge-gate-audit-heading')
  })

  it('T3: the rewrite (a one-line pass/fail verdict, no heading) is never HARD-blocked', () => {
    const v = evaluateMessageBodyGate({
      body: 'merge gate FAIL: CVE-2025-1234, fix is a version bump'
    })
    expect(v.tier).not.toBe('hard')
  })

  it('T3: an inline mention mid-sentence does not match h1 (structural anchor)', () => {
    const v = evaluateMessageBodyGate({
      body: 'the report calls this a VULNERABILITY but it is actually a typo fix'
    })
    expect(v.tier).not.toBe('hard')
  })

  it('h1: SECURITY with any trailing punctuation as a heading is HARD', () => {
    for (const line of ['SECURITY: patched', 'SECURITY - see below', 'SECURITY(HIGH): patched']) {
      const v = evaluateMessageBodyGate({ body: line })
      expect(v.tier, line).toBe('hard')
    }
  })

  it('h1: a bare SECURITY heading (no trailing punctuation) is HARD', () => {
    const v = evaluateMessageBodyGate({
      body: 'SECURITY\nthe relay accepts any from string'
    })
    expect(v.tier).toBe('hard')
    expect(v.tier === 'hard' && v.ruleIds).toContain('security-heading')
  })

  it('h1: a bold lead-in SECURITY heading with nothing else on the line is HARD', () => {
    const v = evaluateMessageBodyGate({
      body: '**SECURITY**\nthe relay accepts any from string'
    })
    expect(v.tier).toBe('hard')
  })

  it('h1: a markdown SECURITY heading with nothing else on the line is HARD', () => {
    const v = evaluateMessageBodyGate({
      body: '## SECURITY\nthe relay accepts any from string'
    })
    expect(v.tier).toBe('hard')
  })

  it('h1 mutation guard: ordinary prose starting with "Security" is never HARD (a naive /^SECURITY\\b/i would false-positive here)', () => {
    const v = evaluateMessageBodyGate({ body: 'Security work continues next sprint.' })
    expect(v.tier).not.toBe('hard')
  })

  it('h1: the broadened cue set (execution-confirmed, EXPLOIT, PoC) is HARD as a heading', () => {
    for (const line of ['EXECUTION-CONFIRMED: works', 'EXPLOIT: details below', 'PoC: attached']) {
      const v = evaluateMessageBodyGate({ body: line })
      expect(v.tier, line).toBe('hard')
    }
  })

  it('h1: a markdown heading or bold lead-in also anchors', () => {
    expect(evaluateMessageBodyGate({ body: '## VULNERABILITY found in parser' }).tier).toBe('hard')
    expect(evaluateMessageBodyGate({ body: '**VULNERABILITY**: found in parser' }).tier).toBe(
      'hard'
    )
  })

  it('h2: a provider-shaped token is HARD', () => {
    const v = evaluateMessageBodyGate({ body: 'key is AKIAABCDEFGHIJKLMNOP, rotate it' })
    expect(v.tier).toBe('hard')
    expect(v.tier === 'hard' && v.ruleIds).toContain('secret-aws-access-key')
  })

  it('h2: KEY=/SECRET=/TOKEN= with >=20 real chars is HARD, but a placeholder is not', () => {
    const real = evaluateMessageBodyGate({ body: 'TOKEN=abcdefghijklmnopqrstuvwxyz123' })
    expect(real.tier).toBe('hard')
    const placeholder = evaluateMessageBodyGate({ body: 'TOKEN=<your-token-here-please-fill>' })
    expect(placeholder.tier).not.toBe('hard')
  })

  it('h3: an infra literal from the injected allowlist is HARD; absent allowlist is inert', () => {
    const withList = evaluateMessageBodyGate({
      body: 'ssh into prod-db-07.internal now',
      infraAllowlist: ['prod-db-07.internal']
    })
    expect(withList.tier).toBe('hard')
    const withoutList = evaluateMessageBodyGate({ body: 'ssh into prod-db-07.internal now' })
    expect(withoutList.tier).not.toBe('hard')
  })

  it('soft: attacker/hostile vocabulary, incl. hyphenated forms, flags but never blocks', () => {
    for (const body of [
      'the attacker-controlled input reaches the parser',
      'this is a hostile-input fuzz case',
      'we bypassed the check locally to confirm the fix',
      'the exploit path is now closed',
      'no backdoor was ever present'
    ]) {
      const v = evaluateMessageBodyGate({ body })
      expect(v.tier, body).toBe('soft')
    }
  })

  it('clean: ordinary text with none of the cues', () => {
    expect(evaluateMessageBodyGate({ body: 'rebase onto main and re-run the suite' }).tier).toBe(
      'clean'
    )
  })

  it('never leaks matched text — only rule ids', () => {
    const v = evaluateMessageBodyGate({ body: 'MERGE-GATE AUDIT: CVE-2025-1234 unresolved' })
    expect(v.tier).toBe('hard')
    const serialized = JSON.stringify(v)
    expect(serialized).not.toContain('CVE-2025-1234')
    expect(serialized).not.toContain('MERGE-GATE AUDIT')
  })

  it('scope: subject and payload are gated the same as body', () => {
    expect(evaluateMessageBodyGate({ subject: 'VULNERABILITY: rce' }).tier).toBe('hard')
    expect(evaluateMessageBodyGate({ payload: 'VULNERABILITY: rce' }).tier).toBe('hard')
  })
})
