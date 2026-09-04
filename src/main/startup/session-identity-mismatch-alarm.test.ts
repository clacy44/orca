// S10-21a C6b (D-R107 fix item 6, D-R108 fix items ii/iii; Ruling 34 Addendum 18/19): a direct
// fence for the runtime-layer mismatch-alarm wiring, extracted from index.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { raiseSessionIdentityMismatchAlarms } from './session-identity-mismatch-alarm'
import type { AgentHookProviderSessionIdentity } from '../agent-hooks/server'
import type { LiveHookReportMismatchResult } from '../runtime/orchestration/agent-lineage-mismatch'

function identity(paneKey: string, sessionId: string): AgentHookProviderSessionIdentity {
  return { paneKey, sessionId, anchorCorroborated: false }
}

describe('S10-21a C6b: raiseSessionIdentityMismatchAlarms', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drives audit (via evaluateLiveHookReportMismatch) + notice for foreign_mismatch', () => {
    const evaluateLiveHookReportMismatch = vi.fn(
      (): LiveHookReportMismatchResult => ({ kind: 'foreign_mismatch' })
    )
    const writeHostNoticeToPane = vi.fn()
    raiseSessionIdentityMismatchAlarms(
      {
        hostId: 'local',
        launchGeneration: 'gen-1',
        evaluateLiveHookReportMismatch,
        writeHostNoticeToPane
      },
      [identity('tab1:leaf-a', 'sess-b')]
    )
    expect(evaluateLiveHookReportMismatch).toHaveBeenCalledWith({
      hostId: 'local',
      paneKey: 'tab1:leaf-a',
      reportedSessionId: 'sess-b',
      anchorCorroborated: false,
      sessionStartSource: undefined,
      launchGeneration: 'gen-1'
    })
    expect(writeHostNoticeToPane).toHaveBeenCalledTimes(1)
    expect(writeHostNoticeToPane).toHaveBeenCalledWith(
      'tab1:leaf-a',
      expect.any(String),
      expect.objectContaining({
        rateKey: 'session_identity_mismatch',
        windowMs: expect.any(Number)
      })
    )
  })

  it('drives a distinct notice text for unrecorded_launch, naming the reason', () => {
    const evaluateLiveHookReportMismatch = vi.fn(
      (): LiveHookReportMismatchResult => ({ kind: 'unrecorded_launch', reason: 'pane_key_owned' })
    )
    const writeHostNoticeToPane = vi.fn()
    raiseSessionIdentityMismatchAlarms(
      {
        hostId: 'local',
        launchGeneration: 'gen-1',
        evaluateLiveHookReportMismatch,
        writeHostNoticeToPane
      },
      [identity('tab1:leaf-a', 'sess-b')]
    )
    expect(writeHostNoticeToPane).toHaveBeenCalledTimes(1)
    const [, text, opts] = writeHostNoticeToPane.mock.calls[0]
    expect(text).toContain('pane_key_owned')
    expect(opts).toMatchObject({ rateKey: 'session_identity_unrecorded_launch' })
  })

  it('never notices on match/no_row/rotated — the audit call still always happens (unconditional per Addendum 18) but no notice text is generated', () => {
    for (const result of [{ kind: 'match' } as const, { kind: 'no_row' } as const]) {
      const evaluateLiveHookReportMismatch = vi.fn(() => result as LiveHookReportMismatchResult)
      const writeHostNoticeToPane = vi.fn()
      raiseSessionIdentityMismatchAlarms(
        {
          hostId: 'local',
          launchGeneration: 'gen-1',
          evaluateLiveHookReportMismatch,
          writeHostNoticeToPane
        },
        [identity('tab1:leaf-a', 'sess-a')]
      )
      expect(evaluateLiveHookReportMismatch).toHaveBeenCalledTimes(1)
      expect(writeHostNoticeToPane).not.toHaveBeenCalled()
    }
  })

  it("the notice fires once only within the window — a caller-side clamp (simulating writeHostNoticeToPane's own real rate limiter) suppresses a second call for the same pane while the evaluator itself is still invoked every time (audit stays unconditional)", () => {
    const evaluateLiveHookReportMismatch = vi.fn(
      (): LiveHookReportMismatchResult => ({ kind: 'foreign_mismatch' })
    )
    // Stand-in for orca-runtime.ts's real writeHostNoticeToPane, which owns the actual 24h
    // per-pane/rateKey clamp (tested separately there) — this fake reproduces just enough of
    // that contract (one delivery per (paneKey, rateKey) pair) to prove the wiring here always
    // passes a STABLE rateKey/windowMs a real clamp could key off of.
    const alreadyNotified = new Set<string>()
    const delivered: string[] = []
    const writeHostNoticeToPane = vi.fn(
      (paneKey: string, _text: string, opts: { rateKey: string }) => {
        const key = `${paneKey}\0${opts.rateKey}`
        if (alreadyNotified.has(key)) {
          return
        }
        alreadyNotified.add(key)
        delivered.push(key)
      }
    )
    const deps = {
      hostId: 'local',
      launchGeneration: 'gen-1',
      evaluateLiveHookReportMismatch,
      writeHostNoticeToPane
    }
    raiseSessionIdentityMismatchAlarms(deps, [identity('tab1:leaf-a', 'sess-b')])
    raiseSessionIdentityMismatchAlarms(deps, [identity('tab1:leaf-a', 'sess-c')])

    // The evaluator (and therefore the unconditional audit row it writes) ran BOTH times.
    expect(evaluateLiveHookReportMismatch).toHaveBeenCalledTimes(2)
    // writeHostNoticeToPane was CALLED twice (this module never self-clamps)...
    expect(writeHostNoticeToPane).toHaveBeenCalledTimes(2)
    // ...but only delivered once, because both calls carried the SAME (paneKey, rateKey) pair —
    // exactly what lets the real downstream clamp dedupe them.
    expect(delivered).toEqual(['tab1:leaf-a\0session_identity_mismatch'])
  })

  it('D-R108 fix item ii: one identity throwing does not abort the batch — the next identity still gets its notice', () => {
    const evaluateLiveHookReportMismatch = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('boom')
      })
      .mockImplementationOnce((): LiveHookReportMismatchResult => ({ kind: 'foreign_mismatch' }))
    const writeHostNoticeToPane = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    raiseSessionIdentityMismatchAlarms(
      {
        hostId: 'local',
        launchGeneration: 'gen-1',
        evaluateLiveHookReportMismatch,
        writeHostNoticeToPane
      },
      [identity('tab1:leaf-a', 'sess-a'), identity('tab2:leaf-b', 'sess-b')]
    )
    expect(evaluateLiveHookReportMismatch).toHaveBeenCalledTimes(2)
    expect(writeHostNoticeToPane).toHaveBeenCalledTimes(1)
    expect(writeHostNoticeToPane).toHaveBeenCalledWith(
      'tab2:leaf-b',
      expect.any(String),
      expect.anything()
    )
    expect(errorSpy).toHaveBeenCalled()
  })
})
