// R316: terminal.hibernationGuard — the host's protected-pane set and background-work verdicts.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { HIBERNATION_GUARD_MAX_PANE_KEYS } from '../../../shared/hibernation-guard-types'

const request = (params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.hibernationGuard',
  params
})

function dispatcherFor(runtime: Partial<OrcaRuntimeService>): RpcDispatcher {
  return new RpcDispatcher({
    runtime: { getRuntimeId: () => 'test-runtime', ...runtime } as OrcaRuntimeService,
    methods: TERMINAL_METHODS
  })
}

describe('terminal.hibernationGuard RPC', () => {
  it('returns the runtime guard for the requested pane keys', async () => {
    const guard = {
      protectedPaneKeys: ['tab-1:leaf-a'],
      backgroundWork: { 'tab-1:leaf-a': 'idle' }
    }
    const hibernationGuardForPanes = vi.fn().mockResolvedValue(guard)

    const response = await dispatcherFor({ hibernationGuardForPanes }).dispatch(
      request({ paneKeys: ['tab-1:leaf-a'] })
    )

    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.result).toEqual(guard)
    }
    expect(hibernationGuardForPanes).toHaveBeenCalledWith(['tab-1:leaf-a'])
  })

  it('refuses more pane keys than the cap, and non-string or empty keys', async () => {
    const hibernationGuardForPanes = vi.fn()
    const dispatcher = dispatcherFor({ hibernationGuardForPanes })

    const tooMany = await dispatcher.dispatch(
      request({
        paneKeys: Array.from({ length: HIBERNATION_GUARD_MAX_PANE_KEYS + 1 }, (_, i) => `k${i}`)
      })
    )
    const empty = await dispatcher.dispatch(request({ paneKeys: [''] }))
    const wrongType = await dispatcher.dispatch(request({ paneKeys: [7] }))

    expect([tooMany.ok, empty.ok, wrongType.ok]).toEqual([false, false, false])
    expect(hibernationGuardForPanes).not.toHaveBeenCalled()
  })

  it('surfaces a guard failure as an error so the caller fails closed', async () => {
    const hibernationGuardForPanes = vi.fn().mockRejectedValue(new Error('directory unavailable'))

    const response = await dispatcherFor({ hibernationGuardForPanes }).dispatch(
      request({ paneKeys: ['tab-1:leaf-a'] })
    )

    expect(response.ok).toBe(false)
  })
})
