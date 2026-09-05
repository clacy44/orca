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

import {
  applySweepRestoreMarkListReply,
  finalizeSweepRestoreMarksHydration
} from './sweep-restore-marks-hydration'

const initialAppStoreState = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  resumeSpy.mockClear()
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
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
    useAppStore.getState().notePendingSweepMarksResumeWake(wake)

    finalizeSweepRestoreMarksHydration(false, null)

    expect(wake).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().pendingSweepMarksResumeWakes.length).toBe(0)
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
})
