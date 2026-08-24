// Release-audit B3's transport adapter: the desktop's `LaneDelegationHostClient` implemented over
// the existing paired-environment layer (`runtime-environment-transport-routing.ts`). It is its own
// file only to keep `lane-delegation-desktop-service.ts` under the max-lines budget — there is no
// independent seam here, just the three calls the push client needs turned into environment RPCs.
import { app } from 'electron'
import type { LaneDelegationHostClient, LaneStatusFrameIn } from './lane-delegation-push-client'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environment-connectivity-handlers'
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

/** A host the user explicitly disconnected: never dialled from this adapter (see below). */
class LaneDelegationHostDisconnectedError extends LaneDelegationHostCallError {
  constructor() {
    super('runtime_manually_disconnected', 'Runtime environment is manually disconnected.')
  }
}

export function createLaneDelegationHostClient(environmentId: string): LaneDelegationHostClient {
  const userDataPath = (): string => app.getPath('userData')
  // Why: `isRuntimeEnvironmentManuallyDisconnected` is enforced only by the IPC handler layer —
  // this adapter calls the transport-routing functions directly, bypassing that gate, so an
  // explicit "Disconnect" was silently undone by the next unrelated selection change (release-
  // audit B3 follow-up). Checked before every call, not just at construction: the flag can be set
  // after the client already exists.
  const assertReachable = (): void => {
    if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      throw new LaneDelegationHostDisconnectedError()
    }
  }
  return {
    hostId: environmentId,
    // Why (chair decision, capability-probe stickiness): a transport failure/timeout/non-ok status
    // must read as "no answer yet", never as "this host lacks the capability" — so this throws
    // instead of folding every non-answer into `[]`. Only a genuine ok `status.get` reaches the
    // `return`, and its `capabilities` (present or not) is the one true explicit answer.
    async getCapabilities(): Promise<readonly string[]> {
      if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
        throw new LaneDelegationHostDisconnectedError()
      }
      const response = await getRuntimeEnvironmentStatus(userDataPath(), environmentId)
      if (!response.ok) {
        throw new LaneDelegationHostCallError(response.error.code, response.error.message)
      }
      return response.result.capabilities ?? []
    },
    async call<T>(method: string, params?: unknown): Promise<T> {
      assertReachable()
      const response = await callRuntimeEnvironment(userDataPath(), environmentId, method, params)
      if (!response.ok) {
        throw new LaneDelegationHostCallError(response.error.code, response.error.message)
      }
      return response.result as T
    },
    async subscribeLaneStatus(onFrame: (frame: LaneStatusFrameIn) => void): Promise<() => void> {
      assertReachable()
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
            // `error` (a mid-stream drop) and `close` both end the subscription the same way: the
            // push client treats `end` as teardown so the next reachable notification resubscribes
            // instead of believing a dead subscription is still live (release-audit B3 follow-up).
            if (payload.type === 'error' || payload.type === 'close') {
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
