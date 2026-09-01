// S10-15 MF-2: direct, deterministic coverage of the mechanism the Enter-timer rollback path
// already reuses (orca-runtime.ts's `mailPointerRepointScheduler.schedule(mailboxHandle)` call
// at the rollback site) — a bounded, stack-guarded retry that calls the real delivery entry
// point, independent of any renderer graph edge. No source change was made to this file for
// MF-2 (it was already wired at the rollback site); this test is new coverage.
import { describe, expect, it, vi } from 'vitest'
import { MailPointerRepointScheduler } from './mail-pointer-repoint-scheduler'

describe('MailPointerRepointScheduler', () => {
  it('calls repoint(handle) after its fixed delay, with no further trigger needed', () => {
    vi.useFakeTimers()
    try {
      const repoint = vi.fn()
      const scheduler = new MailPointerRepointScheduler(repoint)
      scheduler.schedule('term_a')
      expect(repoint).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2_000)
      expect(repoint).toHaveBeenCalledExactlyOnceWith('term_a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('guards against stacking: a second schedule() for the same handle while one is pending does not arm a second timer', () => {
    vi.useFakeTimers()
    try {
      const repoint = vi.fn()
      const scheduler = new MailPointerRepointScheduler(repoint)
      scheduler.schedule('term_a')
      vi.advanceTimersByTime(500)
      scheduler.schedule('term_a') // no-op: already armed
      vi.advanceTimersByTime(1_500)
      expect(repoint).toHaveBeenCalledTimes(1)
      // The clock keeps running past the original 2s mark with no second firing.
      vi.advanceTimersByTime(2_000)
      expect(repoint).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fresh schedule() after the prior one fired arms a genuinely new retry', () => {
    vi.useFakeTimers()
    try {
      const repoint = vi.fn()
      const scheduler = new MailPointerRepointScheduler(repoint)
      scheduler.schedule('term_a')
      vi.advanceTimersByTime(2_000)
      expect(repoint).toHaveBeenCalledTimes(1)

      scheduler.schedule('term_a')
      vi.advanceTimersByTime(2_000)
      expect(repoint).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('independent handles get independent timers', () => {
    vi.useFakeTimers()
    try {
      const repoint = vi.fn()
      const scheduler = new MailPointerRepointScheduler(repoint)
      scheduler.schedule('term_a')
      scheduler.schedule('term_b')
      vi.advanceTimersByTime(2_000)
      expect(repoint).toHaveBeenCalledWith('term_a')
      expect(repoint).toHaveBeenCalledWith('term_b')
      expect(repoint).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clear() cancels every pending timer', () => {
    vi.useFakeTimers()
    try {
      const repoint = vi.fn()
      const scheduler = new MailPointerRepointScheduler(repoint)
      scheduler.schedule('term_a')
      scheduler.schedule('term_b')
      scheduler.clear()
      vi.advanceTimersByTime(10_000)
      expect(repoint).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
