// R326 restart window (pure state): the spawn fence, the drain of spawns already past it, the snapshot
// generation, and the held exits. pty.ts owns the wiring; see pty-daemon-restart-race.test.ts.
import { describe, expect, it } from 'vitest'
import { createRestartExitHold } from './pty-daemon-restart-hold'

describe('hold module (pure state)', () => {
  it('captures the exit payload (with its incarnation) of a held id and reports it held', () => {
    const hold = createRestartExitHold()
    hold.begin(['a', 'b'])

    expect(hold.isHeld('a')).toBe(true)
    expect(hold.isHeld('zzz')).toBe(false)
    expect(hold.captureIfHeld({ id: 'a', incarnationId: 'i1' })).toBe(true)
    expect(hold.captureIfHeld({ id: 'zzz' })).toBe(false)
    expect(hold.release()?.captured).toEqual([{ id: 'a', incarnationId: 'i1' }])
  })

  it('keeps the first incarnation when a later exit for the same id carries none, and adopts one when the first lacked it', () => {
    const hold = createRestartExitHold()
    hold.begin(['a', 'b'])
    hold.captureIfHeld({ id: 'a', incarnationId: 'i1' })
    hold.captureIfHeld({ id: 'a' })
    hold.captureIfHeld({ id: 'b' })
    hold.captureIfHeld({ id: 'b', incarnationId: 'i2' })

    expect(hold.release()?.captured).toEqual([
      { id: 'a', incarnationId: 'i1' },
      { id: 'b', incarnationId: 'i2' }
    ])
  })

  it('has no pending settle when no hold is open, and a pending one while open that resolves on settle', async () => {
    const hold = createRestartExitHold()
    expect(hold.pendingSettle()).toBeNull()
    hold.begin(['a'])
    const pending = hold.pendingSettle()
    expect(pending).not.toBeNull()
    let resolved = false
    void pending!.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    const released = hold.release()!
    // Why: release alone must not settle — the announcement still has to run under the hold.
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(hold.isHeld('a')).toBe(true)
    released.settle()
    await pending
    expect(resolved).toBe(true)
    expect(hold.isHeld('a')).toBe(false)
    expect(hold.pendingSettle()).toBeNull()
  })

  it('a second release is a no-op (null)', () => {
    const hold = createRestartExitHold()
    hold.begin(['a'])
    const first = hold.release()
    expect(first).not.toBeNull()
    expect(hold.release()).toBeNull()
    first!.settle()
    expect(hold.release()).toBeNull()
  })

  it('release with no hold open is null', () => {
    expect(createRestartExitHold().release()).toBeNull()
  })

  it('begin while a hold is open merges into it (and says so) instead of replacing it', () => {
    const hold = createRestartExitHold()
    expect(hold.begin(['a'])).toEqual({ merged: false })
    const pending = hold.pendingSettle()
    expect(hold.begin(['b'])).toEqual({ merged: true })
    expect(hold.pendingSettle()).toBe(pending)
    expect(hold.isHeld('a')).toBe(true)
    expect(hold.isHeld('b')).toBe(true)
  })
})

describe('restart window: fence, drain and snapshot generation', () => {
  it('tryPassFence returns null in both phases (fenced, held) and a ticket once the window settles', () => {
    const hold = createRestartExitHold()
    hold.tryPassFence('x')!.leave()
    hold.closeFence()
    expect(hold.tryPassFence(null)).toBeNull()
    hold.begin(['a'])
    expect(hold.tryPassFence('a')).toBeNull()
    hold.release()!.settle()
    expect(hold.tryPassFence(null)).not.toBeNull()
  })

  it('closeFence opens one window and reports a merge when one is already open', () => {
    const hold = createRestartExitHold()
    expect(hold.closeFence()).toEqual({ merged: false })
    const pending = hold.pendingSettle()
    expect(pending).not.toBeNull()
    expect(hold.closeFence()).toEqual({ merged: true })
    expect(hold.pendingSettle()).toBe(pending)
  })

  it('awaitDrain resolves drained at zero tickets, and reports the pending count at the timeout', async () => {
    const hold = createRestartExitHold()
    const first = hold.tryPassFence('a')!
    const second = hold.tryPassFence('b')!
    hold.closeFence()

    const waiting = hold.awaitDrain(10_000)
    first.leave()
    second.leave()
    await expect(waiting).resolves.toEqual({ drained: true, pending: 0 })

    const timedOutHold = createRestartExitHold()
    const stuck = timedOutHold.tryPassFence('c')!
    timedOutHold.closeFence()
    await expect(timedOutHold.awaitDrain(15)).resolves.toEqual({ drained: false, pending: 1 })
    stuck.leave()
    await expect(timedOutHold.awaitDrain(15)).resolves.toEqual({ drained: true, pending: 0 })
  })

  it('awaitDrain with no tickets resolves immediately', async () => {
    const hold = createRestartExitHold()
    hold.closeFence()
    await expect(hold.awaitDrain(10_000)).resolves.toEqual({ drained: true, pending: 0 })
  })

  it('leave() is idempotent', async () => {
    const hold = createRestartExitHold()
    const ticket = hold.tryPassFence('a')!
    const other = hold.tryPassFence('b')!
    hold.closeFence()
    ticket.leave()
    ticket.leave()
    await expect(hold.awaitDrain(15)).resolves.toEqual({ drained: false, pending: 1 })
    other.leave()
    await expect(hold.awaitDrain(15)).resolves.toEqual({ drained: true, pending: 0 })
  })

  it('begin bumps the snapshot generation and marks outstanding tickets stale exactly once, by in-flight id', () => {
    const hold = createRestartExitHold()
    const before = hold.snapshotGeneration()
    const ticket = hold.tryPassFence('pty-s')!
    expect(ticket.generation).toBe(before)
    expect(hold.staleSpawnCount('pty-s')).toBe(0)
    hold.closeFence()

    hold.begin(['pty-s'])
    expect(hold.snapshotGeneration()).toBe(before + 1)
    expect(hold.staleSpawnCount('pty-s')).toBe(1)
    hold.begin(['pty-s'])
    expect(hold.staleSpawnCount('pty-s')).toBe(1)

    ticket.leave()
    expect(hold.staleSpawnCount('pty-s')).toBe(0)
  })

  it('a ticket issued after a settled window carries the new generation and is not stale', () => {
    const hold = createRestartExitHold()
    hold.begin(['a'])
    hold.release()!.settle()
    const ticket = hold.tryPassFence('a')!
    expect(ticket.generation).toBe(hold.snapshotGeneration())
    expect(hold.staleSpawnCount('a')).toBe(0)
  })

  it('release() is non-null in the fenced phase (before any snapshot) and its settle opens the fence', async () => {
    const hold = createRestartExitHold()
    hold.closeFence()
    const pending = hold.pendingSettle()!
    const released = hold.release()
    expect(released).not.toBeNull()
    expect(released!.captured).toEqual([])
    expect(hold.release()).toBeNull()
    released!.settle()
    await pending
    expect(hold.tryPassFence(null)).not.toBeNull()
  })

  it('captureIfHeld after release records no capture, reports the id as a late exit, and isHeld stays true until settle', () => {
    const hold = createRestartExitHold()
    hold.begin(['a', 'b'])
    expect(hold.captureIfHeld({ id: 'a', incarnationId: 'i1' })).toBe(true)
    const released = hold.release()!
    expect(released.isLateExit('b')).toBe(false)

    expect(hold.captureIfHeld({ id: 'b', incarnationId: 'i2' })).toBe(false)

    expect(released.isLateExit('b')).toBe(true)
    expect(released.isLateExit('a')).toBe(false)
    expect(released.captured).toEqual([{ id: 'a', incarnationId: 'i1' }])
    expect(hold.isHeld('b')).toBe(true)
    released.settle()
    expect(hold.isHeld('b')).toBe(false)
  })
})
