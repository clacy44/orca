// Release-audit B3's transport adapter: the desktop's `LaneDelegationHostClient` implemented over
// the existing paired-environment layer (`runtime-environment-transport-routing.ts`). It is its own
// file only to keep `lane-delegation-desktop-service.ts` under the max-lines budget — there is no
// independent seam here, just the three calls the push client needs turned into environment RPCs.
import { app } from 'electron'
import type { LaneDelegationHostClient, LaneStatusFrameIn } from './lane-delegation-push-client'
import {
  callRuntimeEnvironment,
  getRuntimeEnvironmentStatus,
  subscribeRuntimeEnvironment
} from '../ipc/runtime-environment-transport-routing'

/** A refused/failed environment call, carrying the refusal code/message the push client reports. */
export class LaneDelegationHostCallError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LaneDelegationHostCallError'
  }
}

export function createLaneDelegationHostClient(environmentId: string): LaneDelegationHostClient {
  const userDataPath = (): string => app.getPath('userData')
  return {
    hostId: environmentId,
    async getCapabilities(): Promise<readonly string[]> {
      const response = await getRuntimeEnvironmentStatus(userDataPath(), environmentId)
      return response.ok ? (response.result.capabilities ?? []) : []
    },
    async call<T>(method: string, params?: unknown): Promise<T> {
      const response = await callRuntimeEnvironment(userDataPath(), environmentId, method, params)
      if (!response.ok) {
        throw new LaneDelegationHostCallError(response.error.code, response.error.message)
      }
      return response.result as T
    },
    async subscribeLaneStatus(onFrame: (frame: LaneStatusFrameIn) => void): Promise<() => void> {
      const subscription = await subscribeRuntimeEnvironment(
        userDataPath(),
        environmentId,
        'accounts.lane.statusSubscribe',
        undefined,
        undefined,
        {
          onEvent: (payload) => {
            if (payload.type === 'response' && payload.response.ok) {
              onFrame(payload.response.result as LaneStatusFrameIn)
            }
            if (payload.type === 'close') {
              onFrame({ type: 'end' })
            }
          },
          onClose: () => {}
        }
      )
      return subscription.close
    }
  }
}
