import { z } from 'zod'
import { getRegisteredSshState, listRegisteredSshTargets } from '../../../ipc/ssh'
import { getPublicSshState } from '../../public-ssh-state'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import { resolveStreamParticipant } from '../../terminal-presence-snapshot'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

let clientEventSubscriptionSeq = 0

const ClientEventsUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

export const CLIENT_EVENT_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'runtime.clientEvents.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId, clientKind, pairedDeviceId }, emit) => {
      // Why no mobile gate on presence (Q5): phones are participants and may see the roster, so the
      // roster crosses both paths for every client kind. The 32/64 caps and the membership-only
      // cadence bound what that costs on the relay — a filter is not what bounds it.
      // Why resolved here rather than at fan-out: the snapshot never enters emitClientEvent, so it
      // answers "which row is you" from the socket that is asking. A caller with no grant gets null,
      // and every row it receives reads self:false.
      const participantId =
        resolveStreamParticipant(terminalPresenceRegistry, { connectionId, pairedDeviceId })
          ?.participantId ?? null
      await new Promise<void>((resolve) => {
        // Why: mobile discards terminalSideEffects; excluding it stops the
        // per-OSC batch frames from crossing the relay.
        const unsubscribe = runtime.onClientEvent(
          (event) => {
            emit(event)
          },
          {
            consumesTerminalSideEffects: clientKind !== 'mobile',
            participantId
          }
        )

        const seq = ++clientEventSubscriptionSeq
        const subscriptionId = `runtime-client-events-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Why unconditional: this loop is the path the fan-out branch cannot see, and the two are kept
        // in sync by neither of them having a condition to drift on.
        for (const event of runtime.getTerminalPresenceClientEventSnapshot?.(participantId) ?? []) {
          emit(event)
        }
        // Why: listener-first snapshotting closes the subscribe race while restoring state missed during disconnects.
        for (const event of runtime.getTerminalSleepClientEventSnapshot?.() ?? []) {
          emit(event)
        }
        for (const event of runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot?.() ??
          []) {
          emit(event)
        }
        const sshStates = listRegisteredSshTargets().flatMap((target) => {
          const state = getPublicSshState(getRegisteredSshState(target.id) ?? null)
          return state ? [{ targetId: target.id, state }] : []
        })
        // Why: attaching the listener before snapshotting closes the reload gap without exposing HUB-private target configuration.
        emit({ type: 'ready', subscriptionId, snapshot: { sshStates } })
      })
    }
  }),
  defineMethod({
    name: 'runtime.clientEvents.unsubscribe',
    params: ClientEventsUnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      const expectedPrefix = `runtime-client-events-${connectionId ?? 'inproc'}-`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
