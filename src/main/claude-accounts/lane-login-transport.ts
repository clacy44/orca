// S9-L2 (design rev 38 §2l/§3): the transport adapter for the lane-login RPCs, implemented over
// the same paired-environment layer `lane-delegation-host-client.ts` uses for the push model —
// mirrors that file's shape on purpose so the two clients are easy to compare, and so S9-L3 can
// delete the push half without touching this one. `call` carries the seven RPCs; `subscribeStatus`
// carries the three new `LaneStatusFrame` members (login-started/-completed/-failed) alongside the
// pre-existing status/account rows.
import { app } from 'electron'
import type { LaneAccountRow, LaneLoginStatusFrame } from '../../shared/claude-lane-login-rpc'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environment-connectivity-handlers'
import {
  callRuntimeEnvironment,
  getRuntimeEnvironmentStatus,
  subscribeRuntimeEnvironment
} from '../ipc/runtime-environment-transport-routing'

export class LaneLoginTransportError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LaneLoginTransportError'
  }
}

/** A subset of `accounts.lane.status`'s reply: only what the login client needs (§3 row 2). */
export type LaneLoginHostStatus = {
  laneState: 'absent' | 'loaded' | 'reauth-required' | 'restart-required'
  accounts: LaneAccountRow[]
  delegatedGrantId: string | null
  callerIsDelegatedGrant: boolean
}

export type LaneLoginTransport = {
  hostId: string
  getCapabilities(): Promise<readonly string[]>
  call<T>(method: string, params?: unknown): Promise<T>
  subscribeStatus(
    onFrame: (
      frame:
        | LaneLoginStatusFrame
        // The host's `accounts.lane.statusSubscribe` pushes this synchronously on subscribe
        // (`lane-wire-service.ts`/`claude-credential-lanes.ts`) — the client's initial-status
        // source, so no separate one-shot status read is needed.
        | { type: 'ready'; subscriptionId: string; status: LaneLoginHostStatus }
        | { type: 'status'; status: LaneLoginHostStatus }
        | { type: 'end' }
    ) => void
  ): Promise<() => void>
}

export function createLaneLoginTransport(environmentId: string): LaneLoginTransport {
  const userDataPath = (): string => app.getPath('userData')
  const assertReachable = (): void => {
    if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      throw new LaneLoginTransportError(
        'runtime_manually_disconnected',
        'Runtime environment is manually disconnected.'
      )
    }
  }
  return {
    hostId: environmentId,
    async getCapabilities(): Promise<readonly string[]> {
      assertReachable()
      const response = await getRuntimeEnvironmentStatus(userDataPath(), environmentId)
      if (!response.ok) {
        throw new LaneLoginTransportError(response.error.code, response.error.message)
      }
      return response.result.capabilities ?? []
    },
    async call<T>(method: string, params?: unknown): Promise<T> {
      assertReachable()
      const response = await callRuntimeEnvironment(userDataPath(), environmentId, method, params)
      if (!response.ok) {
        throw new LaneLoginTransportError(response.error.code, response.error.message)
      }
      return response.result as T
    },
    async subscribeStatus(onFrame): Promise<() => void> {
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
              onFrame(payload.response.result as LaneLoginStatusFrame)
            }
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
