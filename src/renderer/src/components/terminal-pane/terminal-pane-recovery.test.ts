import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalPaneRecoveryForTests,
  captureTerminalPaneRecoveryGeneration,
  registerTerminalPaneRecoveryInstance,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'
import { isTerminalInputQuarantined } from './terminal-input-quarantine'
import {
  _resetDaemonSessionLostRelaunchForTests,
  isDaemonSessionLostRelaunch
} from './pty-daemon-session-loss-registry'

const mocks = vi.hoisted(() => ({
  remountTerminalTabForRecovery: vi.fn<(tabId: string) => boolean>(() => true),
  captureSleepingAgentSessionForDaemonDeath:
    vi.fn<(paneKey: string, opts?: { reanchor?: boolean }) => void>(),
  recordRendererCrashBreadcrumb: vi.fn(),
  hasPty: vi.fn<(id: string) => Promise<boolean | null>>(async () => true)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      remountTerminalTabForRecovery: mocks.remountTerminalTabForRecovery,
      captureSleepingAgentSessionForDaemonDeath: mocks.captureSleepingAgentSessionForDaemonDeath
    })
  }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

beforeEach(() => {
  _resetTerminalPaneRecoveryForTests()
  _resetDaemonSessionLostRelaunchForTests()
  mocks.remountTerminalTabForRecovery.mockClear()
  mocks.remountTerminalTabForRecovery.mockReturnValue(true)
  mocks.captureSleepingAgentSessionForDaemonDeath.mockClear()
  mocks.recordRendererCrashBreadcrumb.mockClear()
  mocks.hasPty.mockClear()
  mocks.hasPty.mockResolvedValue(true)
  vi.stubGlobal('window', {
    api: { pty: { hasPty: mocks.hasPty } }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('requestTerminalPaneRecovery', () => {
  it('remounts the tab and records a breadcrumb for a certified-dead pipeline', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled'
    })

    expect(result).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_remount',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
    // Pipeline-death reasons are already probe-certified — no liveness gate.
    expect(mocks.hasPty).not.toHaveBeenCalled()
  })

  it('records a breadcrumb when the tab cannot be remounted, without consuming budget', async () => {
    mocks.remountTerminalTabForRecovery.mockReturnValue(false)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-gone',
      ptyId: 'pty-1',
      reason: 'restore-blocked'
    })

    expect(result).toBe(false)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_remount_unavailable',
      { tabId: 'tab-gone', reason: 'restore-blocked' }
    )
    // Budget untouched: a later request for the same tab may still remount.
    mocks.remountTerminalTabForRecovery.mockReturnValue(true)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-gone',
        ptyId: 'pty-1',
        reason: 'restore-blocked'
      })
    ).toBe(true)
  })

  it('coalesces repeat requests inside the cooldown window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(true)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    vi.setSystemTime(16_000)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('caps recoveries per window to prevent remount storms', async () => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
  })

  it('a window-cap decline schedules a retry that heals when the window reopens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // Cap-declined: without a retry this pane is a permanent zombie — its
    // certified-dead xterm no longer produces write signals to re-request.
    vi.setSystemTime(60_000)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(false)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // One retry (deduped across the two declines) fires once the first
    // attempt ages out of the window, and remounts.
    await vi.advanceTimersByTimeAsync(250_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(400_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })

  it('does not retry a cooldown decline from the xterm replaced by the remount', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const replacedGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: replacedGeneration
    })
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'replay-wedged',
        terminalRecoveryGeneration: replacedGeneration
      })
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
  })

  it('retries a fresh replacement xterm that wedges during the cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1')
    })
    const replacementGeneration = captureTerminalPaneRecoveryGeneration('tab-1')

    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'replay-wedged',
        terminalRecoveryGeneration: replacementGeneration
      })
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('does not let an awaited scheduled retry remount a newer generation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1')
    })
    const replacementGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    let resolveLiveness: ((live: boolean) => void) | undefined
    mocks.hasPty.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLiveness = resolve
        })
    )
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable',
      terminalRecoveryGeneration: replacementGeneration
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.hasPty).toHaveBeenCalledTimes(1)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled',
        terminalRecoveryGeneration: replacementGeneration
      })
    ).toBe(true)
    resolveLiveness?.(true)
    await Promise.resolve()

    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('cancels a retry when a non-recovery lifecycle replaces its xterm', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const originalInstance = registerTerminalPaneRecoveryInstance('tab-1')
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1'),
      terminalRecoveryInstanceId: originalInstance.id
    })
    originalInstance.unregister()

    const wedgedReplacement = registerTerminalPaneRecoveryInstance('tab-1')
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'replay-wedged',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1'),
      terminalRecoveryInstanceId: wedgedReplacement.id
    })
    expect(vi.getTimerCount()).toBe(1)

    // Cold parking, SSH reconnect, and ordinary remounts dispose the binding
    // without changing the recovery epoch; disposal owns timer invalidation.
    wedgedReplacement.unregister()
    const healthySuccessor = registerTerminalPaneRecoveryInstance('tab-1')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)

    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    healthySuccessor.unregister()
  })

  it('keeps a sibling pane retry when the first requesting split is disposed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled'
    })
    const recoveryGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    const firstSplit = registerTerminalPaneRecoveryInstance('tab-1')
    const secondSplit = registerTerminalPaneRecoveryInstance('tab-1')
    for (const instance of [firstSplit, secondSplit]) {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: `pty-${instance.id}`,
        reason: 'replay-wedged',
        terminalRecoveryGeneration: recoveryGeneration,
        terminalRecoveryInstanceId: instance.id
      })
    }

    firstSplit.unregister()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
    secondSplit.unregister()
  })

  it('does not abandon a certified sibling behind a failed liveness retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-initial',
      reason: 'write-stalled'
    })
    const recoveryGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    const livenessSplit = registerTerminalPaneRecoveryInstance('tab-1')
    const certifiedSplit = registerTerminalPaneRecoveryInstance('tab-1')
    mocks.hasPty.mockResolvedValue(false)

    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-not-live',
      reason: 'input-undeliverable',
      terminalRecoveryGeneration: recoveryGeneration,
      terminalRecoveryInstanceId: livenessSplit.id,
      requireAuthoritativeLiveness: true
    })
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-certified-dead',
      reason: 'write-stalled',
      terminalRecoveryGeneration: recoveryGeneration,
      terminalRecoveryInstanceId: certifiedSplit.id
    })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.hasPty).toHaveBeenCalledWith('pty-not-live')
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenLastCalledWith(
      'terminal_pane_recovery_remount',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
    livenessSplit.unregister()
    certifiedSplit.unregister()
  })

  it('budgets tabs independently', async () => {
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(true)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-2', ptyId: 'pty-2', reason: 'write-stalled' })
    ).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('skips input-undeliverable recovery when the PTY is confirmed dead', async () => {
    mocks.hasPty.mockResolvedValue(false)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable'
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('recovers input-undeliverable panes when the PTY is alive', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable'
    })

    expect(result).toBe(true)
    expect(mocks.hasPty).toHaveBeenCalledWith('pty-1')
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
  })

  it('proceeds when PTY liveness is unknown (probe threw)', async () => {
    mocks.hasPty.mockRejectedValue(new Error('ipc down'))

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable'
    })

    expect(result).toBe(true)
  })

  it('requires a ptyId for input-undeliverable recovery', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: null,
      reason: 'input-undeliverable'
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('requires authoritative liveness for remote panes (null hasPty blocks recovery)', async () => {
    mocks.hasPty.mockResolvedValue(null)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'remote:pty-1',
      reason: 'input-undeliverable',
      requireAuthoritativeLiveness: true
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('recovers a remote pane when liveness is authoritative true', async () => {
    mocks.hasPty.mockResolvedValue(true)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'remote:pty-1',
      reason: 'input-undeliverable',
      requireAuthoritativeLiveness: true
    })

    expect(result).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
  })

  it('blocks remote recovery when the liveness probe throws', async () => {
    mocks.hasPty.mockRejectedValue(new Error('runtime unreachable'))

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'remote:pty-1',
      reason: 'input-undeliverable',
      requireAuthoritativeLiveness: true
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  // A `remote:` id has no entry in main's registry, so pty:hasPty routes it to
  // the local provider. Every answer that path can produce blocked the remount
  // this signal exists to trigger (STA-2830); none of them is evidence.
  describe('host-rejected input', () => {
    for (const [label, liveness] of [
      ['a fabricated dead answer', async () => false],
      ['an explicit unknown', async () => null],
      [
        'a failed probe',
        async () => {
          throw new Error('ipc down')
        }
      ]
    ] as [string, () => Promise<boolean | null>][]) {
      it(`recovers even though the local probe would give ${label}`, async () => {
        mocks.hasPty.mockImplementation(liveness)

        const result = await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'remote:env-1@@terminal-1',
          reason: 'input-rejected-by-host',
          requireAuthoritativeLiveness: true,
          endpointReplaced: true
        })

        expect(result).toBe(true)
        expect(mocks.hasPty).not.toHaveBeenCalled()
        expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
      })
    }

    it('still coalesces under the shared cooldown', async () => {
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'remote:env-1@@terminal-1',
          reason: 'input-rejected-by-host'
        })
      ).toBe(true)
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'remote:env-1@@terminal-1',
          reason: 'input-rejected-by-host'
        })
      ).toBe(false)
      expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    })
  })

  it('never throws when the store surface is partial (timer/callback contexts)', async () => {
    // Regression: recovery fires from stall-watch timers and write callbacks;
    // an environment with a partial store (mocked suites, teardown races) must
    // get a false return, not an unhandled TypeError.
    mocks.remountTerminalTabForRecovery.mockImplementation(() => {
      throw new TypeError('remountTerminalTabForRecovery is not a function')
    })

    await expect(
      requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).resolves.toBe(false)
    // The failure must leave a trace — it is the only forensic signal for a
    // production remount-failure loop (budget unconsumed → cooldown retries).
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_failed',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
  })

  it('does not consume budget when the tab no longer exists', async () => {
    mocks.remountTerminalTabForRecovery.mockReturnValue(false)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-gone',
      ptyId: 'pty-1',
      reason: 'write-stalled'
    })

    expect(result).toBe(false)
    // Not silent anymore: the missing-tab outcome is breadcrumbed (see the
    // dedicated test above), but no remount breadcrumb may fire.
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalledWith(
      'terminal_pane_recovery_remount',
      expect.anything()
    )
  })

  // Why: quarantine suppresses real keystrokes, so arming it on a recovery that
  // kept the same shell would eat a legitimate command (#10065 follow-up).
  describe('input quarantine arming', () => {
    it('arms after a replaced endpoint so the mangled line cannot be submitted', async () => {
      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        endpointReplaced: true
      })

      expect(result).toBe(true)
      expect(isTerminalInputQuarantined('tab-1')).toBe(true)
    })

    it('does not arm when the same live shell is reattached', async () => {
      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable'
      })

      expect(result).toBe(true)
      expect(isTerminalInputQuarantined('tab-1')).toBe(false)
    })

    it('does not arm for a stalled write pipeline', async () => {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })

      expect(isTerminalInputQuarantined('tab-1')).toBe(false)
    })

    it('does not arm when the remount never happened', async () => {
      mocks.remountTerminalTabForRecovery.mockReturnValue(false)

      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-gone',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        endpointReplaced: true
      })

      expect(result).toBe(false)
      expect(isTerminalInputQuarantined('tab-gone')).toBe(false)
    })
  })

  // R315: main's authoritative "this pty died with the daemon" — evidence from the host on a
  // healthy replacement daemon, so the local liveness probe (which reads a stale cache) is skipped.
  describe('daemon-session-lost', () => {
    it('remounts even when hasPty answers false, without probing', async () => {
      mocks.hasPty.mockResolvedValue(false)

      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'daemon-session-lost'
      })

      expect(result).toBe(true)
      expect(mocks.hasPty).not.toHaveBeenCalled()
      expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    })

    it('captures the pane with the re-anchor verdict before the remount', async () => {
      const order: string[] = []
      mocks.captureSleepingAgentSessionForDaemonDeath.mockImplementation(() => {
        order.push('capture')
      })
      mocks.remountTerminalTabForRecovery.mockImplementation(() => {
        order.push('remount')
        return true
      })

      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'daemon-session-lost',
        paneKey: 'tab-1:leaf-1',
        reanchor: true
      })

      expect(mocks.captureSleepingAgentSessionForDaemonDeath).toHaveBeenCalledWith('tab-1:leaf-1', {
        reanchor: true
      })
      expect(order).toEqual(['capture', 'remount'])
    })

    it('captures without the flag when the pane is not a chair', async () => {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'daemon-session-lost',
        paneKey: 'tab-1:leaf-1',
        reanchor: false
      })

      expect(mocks.captureSleepingAgentSessionForDaemonDeath).toHaveBeenCalledWith('tab-1:leaf-1', {
        reanchor: false
      })
    })

    it('leaves the input-undeliverable capture unchanged (no options)', async () => {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        paneKey: 'tab-1:leaf-1'
      })

      expect(mocks.captureSleepingAgentSessionForDaemonDeath).toHaveBeenCalledWith('tab-1:leaf-1')
    })

    it('invalidates a later input-undeliverable request from the pre-remount instance', async () => {
      const instance = registerTerminalPaneRecoveryInstance('tab-1')
      const generation = captureTerminalPaneRecoveryGeneration('tab-1')

      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'pty-1',
          reason: 'daemon-session-lost',
          terminalRecoveryGeneration: generation,
          terminalRecoveryInstanceId: instance.id
        })
      ).toBe(true)

      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'pty-1',
          reason: 'input-undeliverable',
          terminalRecoveryGeneration: generation,
          terminalRecoveryInstanceId: instance.id
        })
      ).toBe(false)
      expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    })

    it('marks the lost panes as a recovery relaunch only once the remount happened', async () => {
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'pty-1',
          reason: 'daemon-session-lost',
          paneKey: 'tab-1:leaf-a',
          relaunchPaneKeys: ['tab-1:leaf-a', 'tab-1:leaf-b']
        })
      ).toBe(true)
      expect(isDaemonSessionLostRelaunch('tab-1:leaf-a')).toBe(true)
      expect(isDaemonSessionLostRelaunch('tab-1:leaf-b')).toBe(true)

      mocks.remountTerminalTabForRecovery.mockReturnValue(false)
      await requestTerminalPaneRecovery({
        tabId: 'tab-2',
        ptyId: 'pty-2',
        reason: 'daemon-session-lost',
        paneKey: 'tab-2:leaf-a',
        relaunchPaneKeys: ['tab-2:leaf-a']
      })
      expect(isDaemonSessionLostRelaunch('tab-2:leaf-a')).toBe(false)
    })

    it('never marks a relaunch for any other recovery reason', async () => {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        paneKey: 'tab-1:leaf-a'
      })
      expect(isDaemonSessionLostRelaunch('tab-1:leaf-a')).toBe(false)
    })

    it('remounts nothing for a duplicate request inside the cooldown', async () => {
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'pty-1',
          reason: 'daemon-session-lost'
        })
      ).toBe(true)
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'pty-2',
          reason: 'daemon-session-lost'
        })
      ).toBe(false)
      expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    })
  })
})
