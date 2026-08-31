// S10-4 ruling 7: an `unauthorized` from a saved environment's RPC (the peer rejected our
// pairing token) surfaces a typed, environment-named error and marks the link — never a
// generic `unauthorized` buried in the federation relay loop.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import type { OrchestrationEnvironmentTransport } from './orchestration/environment-transport'

describe('callOrchestrationWorkerServer: stale pairing (S10-4 ruling 7)', () => {
  function buildRuntime(transport: OrchestrationEnvironmentTransport): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    runtime.setOrchestrationDb(new OrchestrationDb(':memory:'))
    return runtime
  }

  it('translates an unauthorized RPC response into a typed error naming the environment and the fix', async () => {
    const markPairingStale = vi.fn()
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'env_1',
        name: 'work-laptop',
        peerFingerprint: 'fp_1'
      }),
      call: async () => ({
        id: 'req',
        ok: false,
        error: { code: 'unauthorized', message: 'Remote Orca runtime rejected the pairing token.' }
      }),
      markPairingStale
    }
    const runtime = buildRuntime(transport)

    await expect(
      runtime.callOrchestrationWorkerServer('work-laptop', 'orchestration.federationPull', {})
    ).rejects.toMatchObject({
      code: 'stale_environment_pairing',
      message: expect.stringContaining('work-laptop')
    })
    expect(markPairingStale).toHaveBeenCalledWith('work-laptop')
  })

  it('the typed error names both recovery verbs (rm+re-add, or set-endpoint)', async () => {
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({ environmentId: 'env_1', name: 'work-laptop', peerFingerprint: 'fp_1' }),
      call: async () => ({
        id: 'req',
        ok: false,
        error: { code: 'unauthorized', message: 'Remote Orca runtime rejected the pairing token.' }
      })
    }
    const runtime = buildRuntime(transport)

    await expect(
      runtime.callOrchestrationWorkerServer('work-laptop', 'orchestration.federationPull', {})
    ).rejects.toMatchObject({
      message: expect.stringMatching(/orca environment rm.*orca environment set-endpoint/s)
    })
  })

  it('leaves an unrelated error code untranslated', async () => {
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({ environmentId: 'env_1', name: 'work-laptop', peerFingerprint: 'fp_1' }),
      call: async () => ({
        id: 'req',
        ok: false,
        error: { code: 'dispatch_not_found', message: 'Federated Dispatch x was not found.' }
      })
    }
    const runtime = buildRuntime(transport)

    await expect(
      runtime.callOrchestrationWorkerServer('work-laptop', 'orchestration.federationPull', {})
    ).rejects.toMatchObject({ code: 'dispatch_not_found' })
  })
})
