import { describe, expect, it } from 'vitest'
import { deriveThreadSubject } from './thread-subject'

describe('deriveThreadSubject', () => {
  it('prefers an explicit subject, sanitized', () => {
    expect(deriveThreadSubject({ explicit: 'merge restructure\nplan', body: 'x' })).toBe(
      'merge restructure plan'
    )
  })

  it('falls back to the first non-empty line of the body', () => {
    expect(deriveThreadSubject({ body: '\n\nrebase onto 12ddb0a first\nmore detail' })).toBe(
      'rebase onto 12ddb0a first'
    )
  })

  it('cuts at 80 chars on a word boundary and appends an ellipsis', () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
    const subject = deriveThreadSubject({ body: long })
    expect(subject.length).toBeLessThanOrEqual(81)
    expect(subject.endsWith('…')).toBe(true)
    expect(subject.endsWith(' …')).toBe(false)
  })

  it('empty body and no explicit subject -> (no subject)', () => {
    expect(deriveThreadSubject({ body: '   \n  ' })).toBe('(no subject)')
  })
})
