import { describe, expect, it } from 'vitest'
import {
  DISPATCH_INPUT_OBSERVATION_DWELL_MS,
  evaluateDispatchInputObservation,
  tailStillHoldsUnansweredTask,
  type DispatchInputObservationEvidence
} from './dispatch-input-observation'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')
const MINUTE_MS = 60_000

const TASK_SPEC = [
  'Refactor the dispatch mailbox resolver and add tests.',
  'Do not change the wire protocol.'
].join('\n')

// Why two fixtures and not one: A1 section 2 records the submit gap as platform-varying with the
// cause still open, so a single synthetic tail would pin the classifier to whichever platform the
// author happened to picture. Both strings below are SYNTHESIZED from the prose in
// docs/reference/federation-live-test-findings.md (F5 and the measured platform difference at
// lines 78-91) — they are not captured console output, and are labeled here so nobody reads them
// as measurements.
const SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ > You are working inside Orca, a multi-agent IDE. You are a  │',
  '│   dispatched worker.                                         │',
  '│                                                              │',
  '│   === TASK ===                                               │',
  '│   Refactor the dispatch mailbox resolver and add tests.      │',
  '│   Do not change the wire protocol.                           │',
  '╰──────────────────────────────────────────────────────────────╯'
].join('\n')

// A TUI that soft-wraps a spec line renders it as two lines, so the wrapped halves do not compare
// equal to anything in the spec. A1 section 2 asks which way that fails; these two fixtures answer
// it, and the answer must be a miss (no report), never a report about a healthy worker.
const SYNTHESIZED_WRAPPED_SPEC_LINE_TAIL = [
  '╭──────────────────────────────────────╮',
  '│ > You are a dispatched worker.       │',
  '│                                      │',
  '│   === TASK ===                       │',
  '│   Refactor the dispatch mailbox      │',
  '│   resolver and add tests.            │',
  '│   Do not change the wire protocol.   │',
  '╰──────────────────────────────────────╯'
].join('\n')

// Some agents print a composer hint under the pasted prompt before they take a turn.
const SYNTHESIZED_COMPOSER_HINT_TAIL = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ > You are working inside Orca, a multi-agent IDE. You are a  │',
  '│   dispatched worker.                                         │',
  '│                                                              │',
  '│   === TASK ===                                               │',
  '│   Refactor the dispatch mailbox resolver and add tests.      │',
  '│   Do not change the wire protocol.                           │',
  '╰──────────────────────────────────────────────────────────────╯',
  '  ? for shortcuts                                    Context left: 94%'
].join('\n')

const SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL = [
  '> You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
  '',
  '  === TASK ===',
  '  Refactor the dispatch mailbox resolver and add tests.',
  '  Do not change the wire protocol.',
  '',
  "⏺ I'll start by reading the dispatch mailbox resolver.",
  '⏺ Read(src/main/runtime/orchestration/dispatch-mailbox-terminal.ts)'
].join('\n')

function evidence(
  overrides: Partial<DispatchInputObservationEvidence> = {}
): DispatchInputObservationEvidence {
  return {
    now: NOW,
    submittedAt: NOW - 10 * MINUTE_MS,
    heartbeated: false,
    agentStatus: null,
    blockedSince: null,
    terminalStatus: 'running',
    processLiveness: 'live',
    tailText: SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL,
    taskSpec: TASK_SPEC,
    ...overrides
  }
}

describe('dispatch input observation', () => {
  it('reports input_not_consumed for the Linux/AppImage shape once the dwell has passed', () => {
    expect(evaluateDispatchInputObservation(evidence())).toEqual({
      kind: 'input_not_consumed',
      observedForMs: 10 * MINUTE_MS
    })
  })

  it('reports blocked_on_gate only after the dwell, never at the measured 20s boot figure', () => {
    const atGate = (blockedForMs: number) =>
      evaluateDispatchInputObservation(
        evidence({ agentStatus: 'permission', blockedSince: NOW - blockedForMs })
      )

    expect(atGate(20_000)?.kind).not.toBe('blocked_on_gate')
    expect(atGate(DISPATCH_INPUT_OBSERVATION_DWELL_MS - 1)?.kind).not.toBe('blocked_on_gate')
    expect(atGate(DISPATCH_INPUT_OBSERVATION_DWELL_MS)).toMatchObject({
      kind: 'blocked_on_gate',
      agentStatus: 'permission',
      blockedForMs: DISPATCH_INPUT_OBSERVATION_DWELL_MS
    })
  })

  it('reports worker_process_gone for a dead incarnation and for an exited terminal', () => {
    expect(evaluateDispatchInputObservation(evidence({ processLiveness: 'dead' }))).toMatchObject({
      kind: 'worker_process_gone',
      processLiveness: 'dead'
    })
    expect(
      evaluateDispatchInputObservation(
        evidence({ terminalStatus: 'exited', tailText: null, heartbeated: true })
      )
    ).toMatchObject({ kind: 'worker_process_gone', terminalStatus: 'exited' })
  })

  describe('negative controls', () => {
    it('says nothing about a spinner-titled worker quiet for thirty minutes', () => {
      // A1's separability ceiling: (a) booting and (c) thinking silently are not separable, and a
      // real task runs 15-60 minutes. Silence alone must produce nothing.
      for (let minute = 1; minute <= 30; minute += 1) {
        expect(
          evaluateDispatchInputObservation(
            evidence({
              now: NOW + minute * MINUTE_MS,
              agentStatus: 'working',
              tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
            })
          )
        ).toBeNull()
      }
    })

    it('says nothing in the first sixty seconds', () => {
      expect(evaluateDispatchInputObservation(evidence({ submittedAt: NOW - 59_000 }))).toBeNull()
    })

    it('says nothing once the worker has sent any heartbeat', () => {
      expect(evaluateDispatchInputObservation(evidence({ heartbeated: true }))).toBeNull()
    })

    it('says nothing about a manual-permission agent awaiting approval after a heartbeat', () => {
      expect(
        evaluateDispatchInputObservation(
          evidence({
            heartbeated: true,
            agentStatus: 'permission',
            blockedSince: NOW - 45 * MINUTE_MS,
            tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
          })
        )
      ).toBeNull()
    })

    it('says nothing about the Windows-shaped self-submit at twenty seconds', () => {
      expect(
        evaluateDispatchInputObservation(
          evidence({
            submittedAt: NOW - 20_000,
            tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
          })
        )
      ).toBeNull()
      // Still nothing an hour later: the tail shows the agent answered, so no dwell can make it a
      // report.
      expect(
        evaluateDispatchInputObservation(
          evidence({
            submittedAt: NOW - 60 * MINUTE_MS,
            tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
          })
        )
      ).toBeNull()
    })

    it('says nothing when the tail could not be read', () => {
      expect(evaluateDispatchInputObservation(evidence({ tailText: null }))).toBeNull()
    })

    it('says nothing when process liveness is unknown', () => {
      expect(
        evaluateDispatchInputObservation(
          evidence({
            processLiveness: 'unknown',
            terminalStatus: null,
            heartbeated: true,
            tailText: null
          })
        )
      ).toBeNull()
    })

    it('says nothing about a gate the runtime never dated', () => {
      expect(
        evaluateDispatchInputObservation(
          evidence({
            agentStatus: 'permission',
            blockedSince: null,
            tailText: SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL
          })
        )
      ).toBeNull()
    })

    it('says nothing when the prompt was never dated', () => {
      expect(evaluateDispatchInputObservation(evidence({ submittedAt: null }))).toBeNull()
    })

    it('says nothing about a working agent whose tail still shows the prompt', () => {
      expect(evaluateDispatchInputObservation(evidence({ agentStatus: 'working' }))).toBeNull()
    })
  })

  describe('tail evidence', () => {
    it('holds for the synthesized Linux/AppImage tail and not for the Windows one', () => {
      expect(
        tailStillHoldsUnansweredTask(SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL, TASK_SPEC)
      ).toBe(true)
      expect(
        tailStillHoldsUnansweredTask(SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL, TASK_SPEC)
      ).toBe(false)
    })

    it('does not hold for a tail truncated at the marker', () => {
      expect(tailStillHoldsUnansweredTask('some earlier output\n=== TASK ===', TASK_SPEC)).toBe(
        false
      )
    })

    it('does not hold when the marker never appears', () => {
      expect(tailStillHoldsUnansweredTask('$ ls\nREADME.md', TASK_SPEC)).toBe(false)
    })

    // Why these are pinned as misses rather than fixed: recovering them needs a per-agent allowlist
    // of chrome strings, which eventually mistakes a real transcript for chrome and reports a
    // healthy worker as stuck — the failure A1's separability ceiling forbids outright.
    it.each([
      ['a soft-wrapped spec line', SYNTHESIZED_WRAPPED_SPEC_LINE_TAIL],
      ['an agent composer hint under the prompt', SYNTHESIZED_COMPOSER_HINT_TAIL]
    ])('fails toward silence, not a report, for %s', (_label, tailText) => {
      expect(tailStillHoldsUnansweredTask(tailText, TASK_SPEC)).toBe(false)
      expect(evaluateDispatchInputObservation(evidence({ tailText }))).toBeNull()
    })

    it('reads the last dispatch when a terminal was reused for a second one', () => {
      const reused = [
        SYNTHESIZED_WINDOWS_INSTALLED_SUBMITTED_TAIL,
        SYNTHESIZED_LINUX_APPIMAGE_UNSUBMITTED_TAIL
      ].join('\n')
      expect(tailStillHoldsUnansweredTask(reused, TASK_SPEC)).toBe(true)
    })
  })
})
