// S10-21a C7f/C7g (Ruling 34 Addenda 24/25): pty.ts's :6939 gate — the pure decision, split out
// for direct unit coverage (the surrounding IPC handler is not unit-testable in isolation).
import { describe, expect, it } from 'vitest'
import { resolveDaemonRespawnGateAction } from './daemon-respawn-gate-action'

describe('S10-21a C7f/C7g: resolveDaemonRespawnGateAction', () => {
  it('daemon_died newest + HOST_RESUME -> refresh', () => {
    expect(resolveDaemonRespawnGateAction('daemon_died', 'host_resume')).toEqual({
      kind: 'refresh'
    })
  })

  it('daemon_died newest + SELF_RESUME(host) -> refresh, same as HOST_RESUME', () => {
    expect(resolveDaemonRespawnGateAction('daemon_died', 'self_resume_host')).toEqual({
      kind: 'refresh'
    })
  })

  it('daemon_died newest + HOST_MINTED -> refuse the fresh session, never refresh', () => {
    expect(resolveDaemonRespawnGateAction('daemon_died', 'host_minted')).toEqual({
      kind: 'refuse_fresh_session'
    })
  })

  it('daemon_died newest + SELF_RESUME(caller) -> notice only (the contest path already fires)', () => {
    expect(resolveDaemonRespawnGateAction('daemon_died', 'self_resume_caller')).toEqual({
      kind: 'notice_only'
    })
  })

  it("a newer 'rebind' than 'daemon_died' -> no action, regardless of classification", () => {
    expect(resolveDaemonRespawnGateAction('rebind', 'host_resume')).toEqual({ kind: 'none' })
    expect(resolveDaemonRespawnGateAction('rebind', 'host_minted')).toEqual({ kind: 'none' })
  })

  it('no daemon_died/rebind audit at all (null) -> no action', () => {
    expect(resolveDaemonRespawnGateAction(null, 'host_resume')).toEqual({ kind: 'none' })
  })

  it('a non-covered launch (no classification, e.g. a plain shell) -> no action, matching "no wait and no gate"', () => {
    expect(resolveDaemonRespawnGateAction('daemon_died', undefined)).toEqual({ kind: 'none' })
  })

  it('daemon_died newest + UNRECORDED -> no action (only the four named classifications act)', () => {
    expect(resolveDaemonRespawnGateAction('daemon_died', 'unrecorded')).toEqual({ kind: 'none' })
  })
})
