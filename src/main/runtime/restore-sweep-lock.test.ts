// S10-21a C7 (design v3.2 §2.1a): the sweep's own in-process lock.
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireRestoreSweepLock,
  isRestoreSweepLockHeld,
  releaseRestoreSweepLock,
  _resetRestoreSweepLockForTest
} from './restore-sweep-lock'

describe('S10-21a C7: restore-sweep-lock', () => {
  afterEach(() => {
    _resetRestoreSweepLockForTest()
  })

  it('is unheld by default, held after acquire, unheld after release', () => {
    expect(isRestoreSweepLockHeld()).toBe(false)
    acquireRestoreSweepLock()
    expect(isRestoreSweepLockHeld()).toBe(true)
    releaseRestoreSweepLock()
    expect(isRestoreSweepLockHeld()).toBe(false)
  })

  it('a second acquisition while held throws rather than granting a second holder', () => {
    acquireRestoreSweepLock()
    expect(() => acquireRestoreSweepLock()).toThrow('restore_sweep_lock_already_held')
    expect(isRestoreSweepLockHeld()).toBe(true)
  })

  it('release is idempotent (a second release does not throw)', () => {
    acquireRestoreSweepLock()
    releaseRestoreSweepLock()
    expect(() => releaseRestoreSweepLock()).not.toThrow()
    expect(isRestoreSweepLockHeld()).toBe(false)
  })
})
