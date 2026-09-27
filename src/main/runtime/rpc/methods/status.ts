import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { peekRuntimeHostIntegrity } from '../../../host-integrity/host-integrity-guard'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: async (_params, { runtime, pairedDeviceId }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      // [N8, INV-P-023] Never await the first probe — status.get's RPC timeout is shorter than
      // the probe's settle guard on a slow Windows host.
      const hostIntegrity = peekRuntimeHostIntegrity()
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support,
        ...(hostIntegrity ? { hostIntegrity } : {})
      }
    }
  })
]
