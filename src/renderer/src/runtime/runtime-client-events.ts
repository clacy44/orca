import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../shared/runtime-client-events'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { admitSshConnectionState } from '../../../shared/ssh-retained-payload-admission'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export type RuntimeClientEventSubscription = {
  unsubscribe: () => void
}

export async function subscribeRuntimeClientEvents(
  environmentId: string,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void = console.warn,
  // Why: client events emitted while the shared-control transport was down are
  // lost, not queued. The replay tag on the first post-reconnect response is
  // the renderer's only signal that mirrored event-derived state (e.g. the
  // per-environment SSH bucket) may have missed transitions and must resync.
  onReplayedAfterReconnect?: () => void
): Promise<RuntimeClientEventSubscription> {
  const handle = await window.api.runtimeEnvironments.subscribe(
    {
      selector: environmentId,
      method: 'runtime.clientEvents.subscribe',
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
    },
    {
      onResponse: (response) => {
        handleRuntimeClientEventResponse(response, onEvent, onError, onReplayedAfterReconnect)
      },
      onError
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

function handleRuntimeClientEventResponse(
  response: RuntimeRpcResponse<unknown>,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void,
  onReplayedAfterReconnect?: () => void
): void {
  if (response.ok === false) {
    onError(response.error)
    return
  }
  if (isRuntimeSubscriptionReplayResponse(response)) {
    onReplayedAfterReconnect?.()
  }
  const message = response.result as RuntimeClientEventStreamMessage
  if (message.type === 'ready') {
    for (const sshState of message.snapshot?.sshStates ?? []) {
      const state = admitSshConnectionState(sshState.state, sshState.targetId)
      if (state) {
        onEvent({ type: 'sshStateChanged', targetId: sshState.targetId, state })
      } else {
        onError(new Error('Invalid retained SSH connection state'))
      }
    }
    return
  }
  if (message.type === 'end') {
    return
  }
  if (message.type === 'sshStateChanged') {
    const state = admitSshConnectionState(message.state, message.targetId)
    if (state) {
      onEvent({ type: 'sshStateChanged', targetId: message.targetId, state })
    } else {
      onError(new Error('Invalid retained SSH connection state'))
    }
    return
  }
  if (isRuntimeClientEvent(message)) {
    onEvent(message)
  }
}

// Why an allowlist and not a shape check: unknown event types must fall through silently, which is what
// lets the host publish a new one without a protocol bump. `terminalPresence` (W8) is Rule 3 — every
// client that predates this entry drops the roster right here.
const ADMITTED_CLIENT_EVENT_TYPES = new Set<RuntimeClientEvent['type']>([
  'reposChanged',
  'worktreesChanged',
  'nativeChatLaunchDraftResolved',
  'terminalSideEffects',
  'sshStateChanged',
  'linearLinkedIssueUpdated',
  'activateWorktree',
  'worktreeTerminalSleepState',
  'terminalPresence'
])

/** Exported so a skew test can hold the shipped set against a frozen pre-change copy of it. */
export function isAdmittedRuntimeClientEventType(type: string): boolean {
  return ADMITTED_CLIENT_EVENT_TYPES.has(type as RuntimeClientEvent['type'])
}

function isRuntimeClientEvent(
  message: RuntimeClientEventStreamMessage
): message is RuntimeClientEvent {
  return isAdmittedRuntimeClientEventType(message.type)
}
