// S10-21a C3-v2 (errata 5(p) v2.1 §C.3/§C.4): pure predicate coverage for the argv-token
// classifiers admission and the resume-command guard share.
import { describe, expect, it } from 'vitest'
import {
  COVERED_LAUNCH_AGENTS,
  isCoveredLaunchAgent,
  isContinueSelectorToken,
  isForkSessionRefusalToken,
  isResumeSelectorToken,
  isSessionIdRefusalToken,
  resumeSelectorJoinedId
} from './covered-launch-agents'

describe('S10-21a C3-v2, errata 5(p) §B/§C.3: COVERED_LAUNCH_AGENTS', () => {
  it('is exactly {claude}, per errata 5(o)', () => {
    expect([...COVERED_LAUNCH_AGENTS]).toEqual(['claude'])
  })

  it('isCoveredLaunchAgent: claude is covered, everything else and undefined are not', () => {
    expect(isCoveredLaunchAgent('claude')).toBe(true)
    expect(isCoveredLaunchAgent('codex')).toBe(false)
    expect(isCoveredLaunchAgent(undefined)).toBe(false)
  })
})

describe('S10-21a C3-v2, errata 5(p) §C.4 step 5a/5b: hard-refusal tokens (exact match only)', () => {
  it('isSessionIdRefusalToken matches --session-id and --session-id=<v> only', () => {
    expect(isSessionIdRefusalToken('--session-id')).toBe(true)
    expect(isSessionIdRefusalToken('--session-id=abc')).toBe(true)
    expect(isSessionIdRefusalToken('--session-idx')).toBe(false)
    expect(isSessionIdRefusalToken('--session-id-decoy')).toBe(false)
  })

  it('isForkSessionRefusalToken matches --fork-session and --fork-session=<v> only', () => {
    expect(isForkSessionRefusalToken('--fork-session')).toBe(true)
    expect(isForkSessionRefusalToken('--fork-session=x')).toBe(true)
    expect(isForkSessionRefusalToken('--fork-sessions')).toBe(false)
  })
})

describe('S10-21a C3-v2, errata 5(p) §C.4 "Effective resume id": selector superset', () => {
  it('matches --resume/--continue exact and = forms', () => {
    for (const t of ['--resume', '--resume=x', '--continue', '--continue=x']) {
      expect(isResumeSelectorToken(t)).toBe(true)
    }
  })

  it('matches the conservative single-dash r/c superset, including joined -r<id>/-c<id>', () => {
    for (const t of ['-r', '-r=x', '-rABC', '-c', '-c=x', '-cABC']) {
      expect(isResumeSelectorToken(t)).toBe(true)
    }
  })

  it('does not match unrelated flags', () => {
    for (const t of ['--verbose', '-v', 'claude', '--model']) {
      expect(isResumeSelectorToken(t)).toBe(false)
    }
  })

  it('isContinueSelectorToken: --continue family only, never --resume/-r', () => {
    expect(isContinueSelectorToken('--continue')).toBe(true)
    expect(isContinueSelectorToken('--continue=x')).toBe(true)
    expect(isContinueSelectorToken('-c')).toBe(true)
    expect(isContinueSelectorToken('-cABC')).toBe(true)
    expect(isContinueSelectorToken('--resume')).toBe(false)
    expect(isContinueSelectorToken('-r')).toBe(false)
  })

  it('resumeSelectorJoinedId extracts the joined id from --resume=<v>/-r<v>/-r=<v>', () => {
    expect(resumeSelectorJoinedId('--resume=sess-1')).toBe('sess-1')
    expect(resumeSelectorJoinedId('-rsess-1')).toBe('sess-1')
    expect(resumeSelectorJoinedId('-r=sess-1')).toBe('sess-1')
    expect(resumeSelectorJoinedId('--resume')).toBeUndefined()
    expect(resumeSelectorJoinedId('-r')).toBeUndefined()
  })
})
