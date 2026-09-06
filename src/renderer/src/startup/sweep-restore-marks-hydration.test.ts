// @vitest-environment happy-dom

// [S10-21a C15b, D-R129 F1/F3/F4] The `sweepRestoreMarksHydrated` gate must resolve on every
// terminal path of App.tsx's startup chain, a timed-out sweep read must be recorded loudly (not
// silently adopted), and a cancelled StrictMode pass must not flip the flag or replay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const resumeSpy = vi.fn((_worktreeId: string) => 0)
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: (worktreeId: string) => resumeSpy(worktreeId)
}))

// [S10-21a C15c, D-R131 N1] Spy on the breadcrumb channel instead of the real implementation —
// the real one is a no-op without `window.api`.
const recordBreadcrumbSpy = vi.fn()
vi.mock('../lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumbSpy(name, data)
}))

import {
  applySweepRestoreMarkListReply,
  finalizeSweepRestoreMarksHydration,
  finalizeSweepRestoreMarksHydrationFromCatch
} from './sweep-restore-marks-hydration'

const initialAppStoreState = useAppStore.getState()
const originalWindowApi = window.api

beforeEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  resumeSpy.mockClear()
  recordBreadcrumbSpy.mockClear()
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  window.api = originalWindowApi
  vi.restoreAllMocks()
})

describe('finalizeSweepRestoreMarksHydration (S10-21a C15b, F1/F4)', () => {
  it('(F1) a throw before hydration still resolves the gate: flag true, pending replayed', () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    useAppStore.getState().notePendingSweepMarksResumeWorktreeId('wt-1')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Simulates App.tsx's outer catch: the try's own finally never ran (the throw happened above
    // the sweep-restore-marks-hydrate step), so this catch is the ONLY writer that fires — at
    // base there is no such writer at all, so the flag stays false forever (F1).
    finalizeSweepRestoreMarksHydration(false, 'session-get rejected')

    expect(useAppStore.getState().sweepRestoreMarksHydrated).toBe(true)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-success startup path'),
      'session-get rejected'
    )
    // Replayed exactly once, not left pending forever.
    expect(resumeSpy).toHaveBeenCalledWith('wt-1')
    expect(useAppStore.getState().pendingSweepMarksResumeWorktreeIds.size).toBe(0)
  })

  it('(F1) is idempotent and silent when the success path already set the flag', () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: true } as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    finalizeSweepRestoreMarksHydration(false, 'some later throw')

    expect(errorSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('(F4) a cancelled StrictMode pass does not flip the flag or replay', () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    useAppStore.getState().notePendingSweepMarksResumeWorktreeId('wt-1')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    finalizeSweepRestoreMarksHydration(true, 'reason irrelevant when cancelled')

    expect(useAppStore.getState().sweepRestoreMarksHydrated).toBe(false)
    expect(useAppStore.getState().pendingSweepMarksResumeWorktreeIds.has('wt-1')).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('(F2 drain) replays a queued wake thunk exactly once alongside the id-keyed queue', () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    const wake = vi.fn()
    useAppStore.getState().notePendingSweepMarksResumeWake('wt-1', wake)

    finalizeSweepRestoreMarksHydration(false, null)

    expect(wake).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().pendingSweepMarksResumeWakes.size).toBe(0)
  })

  // [S10-21a C15c, D-R131 N4] Fails at base: base's queue is a plain array (`.push`), so two
  // wakes for one worktree would replay both, keyed test would fail to compile/assert dedupe.
  it('(N4) two wakes queued for the same worktree replay only the most recent, once', () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    const firstWake = vi.fn()
    const secondWake = vi.fn()
    useAppStore.getState().notePendingSweepMarksResumeWake('wt-1', firstWake)
    useAppStore.getState().notePendingSweepMarksResumeWake('wt-1', secondWake)

    finalizeSweepRestoreMarksHydration(false, null)

    expect(firstWake).not.toHaveBeenCalled()
    expect(secondWake).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().pendingSweepMarksResumeWakes.size).toBe(0)
  })

  // [S10-21a C15c, D-R131 N1] Fails at base: `finalizeSweepRestoreMarksHydration` at base only
  // `console.error`s, never reaching a durable channel.
  it('(N1) a forced finalize records a durable breadcrumb, not just console.error', () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    finalizeSweepRestoreMarksHydration(false, 'session-get rejected')

    expect(recordBreadcrumbSpy).toHaveBeenCalledWith('sweep_restore_marks_forced', {
      stepLabel: 'session-get rejected',
      paneCount: 0
    })
  })
})

describe('applySweepRestoreMarkListReply (S10-21a C15b, F3)', () => {
  it('adopts the reply marks silently on the normal (non-timeout) path', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    applySweepRestoreMarkListReply({ paneKeys: ['p1'] })

    expect(useAppStore.getState().sweepRestoredPaneKeys.has('p1')).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('(F3) a timed-out sweep read is adopted but recorded loudly, not silently', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    applySweepRestoreMarkListReply({ paneKeys: ['p1'], sweepIncomplete: true })

    // Chair call: adopt the pre-sweep view (deferring forever is F1's failure mode)...
    expect(useAppStore.getState().sweepRestoredPaneKeys.has('p1')).toBe(true)
    // ...but never silently — R52 must not reopen without a trace.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('timed out waiting for the sweep lock'),
      ['p1']
    )
  })

  // [S10-21a C15c, D-R131 N1] Fails at base: no breadcrumb call exists at base.
  it('(N1) a timed-out sweep read also records a durable breadcrumb', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    applySweepRestoreMarkListReply({ paneKeys: ['p1', 'p2'], sweepIncomplete: true })

    expect(recordBreadcrumbSpy).toHaveBeenCalledWith('sweep_restore_marks_incomplete', {
      paneCount: 2
    })
  })
})

describe('finalizeSweepRestoreMarksHydrationFromCatch (S10-21a C15c, D-R131 N5)', () => {
  // Fails at base: base's outer-catch path calls `finalizeSweepRestoreMarksHydration` directly,
  // never reading the marks first — the set stays at its empty default.
  it('reads and applies the marks before finalizing when a throw preceded the hydrate step', async () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.api = {
      session: {
        sweepRestoreMarkList: vi.fn(async () => ({ paneKeys: ['p1'], sweepIncomplete: false }))
      }
    } as never

    await finalizeSweepRestoreMarksHydrationFromCatch(false, 'session-get rejected')

    expect(useAppStore.getState().sweepRestoredPaneKeys.has('p1')).toBe(true)
    expect(useAppStore.getState().sweepRestoreMarksHydrated).toBe(true)
  })

  it('proceeds as before (finalizes anyway) when the best-effort read fails', async () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.api = {
      session: {
        sweepRestoreMarkList: vi.fn(async () => {
          throw new Error('ipc down')
        })
      }
    } as never

    await finalizeSweepRestoreMarksHydrationFromCatch(false, 'session-get rejected')

    expect(useAppStore.getState().sweepRestoreMarksHydrated).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('best-effort catch-path read failed'),
      expect.any(Error)
    )
  })

  it('does not re-read when the finally already hydrated (idempotent)', async () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: true } as never)
    const sweepRestoreMarkList = vi.fn(async () => ({ paneKeys: ['p1'], sweepIncomplete: false }))
    window.api = { session: { sweepRestoreMarkList } } as never

    await finalizeSweepRestoreMarksHydrationFromCatch(false, 'later throw')

    expect(sweepRestoreMarkList).not.toHaveBeenCalled()
  })

  it('does not read or finalize when cancelled', async () => {
    useAppStore.setState({ sweepRestoreMarksHydrated: false } as never)
    const sweepRestoreMarkList = vi.fn(async () => ({ paneKeys: ['p1'], sweepIncomplete: false }))
    window.api = { session: { sweepRestoreMarkList } } as never

    await finalizeSweepRestoreMarksHydrationFromCatch(true, 'reason irrelevant when cancelled')

    expect(sweepRestoreMarkList).not.toHaveBeenCalled()
    expect(useAppStore.getState().sweepRestoreMarksHydrated).toBe(false)
  })
})
