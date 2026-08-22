import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type {
  RuntimeClientEventStreamMessage,
  RuntimeTerminalPresenceClientEvent
} from '../../shared/runtime-client-events'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { terminalPresenceRegistry } from './terminal-presence-registry'

const TEST_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 5_000

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for condition')
}

function pairingFor(pairingUrl: string) {
  const pairing = parsePairingCode(pairingUrl)
  if (!pairing) {
    throw new Error('invalid_pairing_url')
  }
  return pairing
}

function presenceOf(
  events: RuntimeClientEventStreamMessage[]
): RuntimeTerminalPresenceClientEvent[] {
  return events.filter(
    (event): event is RuntimeTerminalPresenceClientEvent => event.type === 'terminalPresence'
  )
}

function selfLabels(event: RuntimeTerminalPresenceClientEvent | undefined): string[] {
  return (event?.participants ?? []).filter((row) => row.self).map((row) => row.label)
}

function peerLabels(event: RuntimeTerminalPresenceClientEvent | undefined): string[] {
  return (event?.participants ?? [])
    .filter((row) => row.kind !== 'host')
    .map((row) => row.label)
    .toSorted()
}

describe('terminalPresence roster over a real socket', () => {
  const cleanups: (() => void | Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
    terminalPresenceRegistry.reset()
  })

  it(
    'names every established grant, marks each listener itself, and never names a one-shot socket',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-roster-'))
      cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
      const runtime = new OrcaRuntimeService()
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      cleanups.push(() => server.stop())
      await server.start()

      // Why three always-minted grants: `reuse` would hand all three callers one pairedDeviceId, and
      // every per-participant assertion below would pass without distinguishing anybody.
      const offers = ['Ana laptop', 'Ben laptop', 'coordinator'].map((name) => {
        const offer = server.createPairingOffer({ name, scope: 'runtime', mint: 'always' })
        if (!offer.available) {
          throw new Error('pairing_unavailable')
        }
        return offer
      })
      const [ana, ben, agent] = offers

      const anaEvents: RuntimeClientEventStreamMessage[] = []
      const anaSubscription = await subscribeRemoteRuntimeRequest<RuntimeClientEventStreamMessage>(
        pairingFor(ana!.pairingUrl),
        'runtime.clientEvents.subscribe',
        undefined,
        REQUEST_TIMEOUT_MS,
        {
          onResponse: (response) => {
            if (response.ok) {
              anaEvents.push(response.result)
            }
          },
          onError: () => {}
        }
      )
      cleanups.push(() => anaSubscription.close())
      await waitFor(() => anaEvents.some((event) => event.type === 'ready'))

      // Ana's own subscribe snapshot: the host row plus herself, marked self by her own connection.
      const anaSnapshot = presenceOf(anaEvents).at(0)
      expect(anaSnapshot?.participants.map((row) => row.kind).toSorted()).toEqual([
        'host',
        'runtime'
      ])
      expect(selfLabels(anaSnapshot)).toEqual(['Ana laptop'])

      // §4.4: a fresh authenticated socket that registers no subscription must reach no roster.
      const agentRequest = new RemoteRuntimeRequestConnection(pairingFor(agent!.pairingUrl))
      cleanups.push(() => agentRequest.close())
      await agentRequest.request('status.get', {}, REQUEST_TIMEOUT_MS)

      const benEvents: RuntimeClientEventStreamMessage[] = []
      const benSubscription = await subscribeRemoteRuntimeRequest<RuntimeClientEventStreamMessage>(
        pairingFor(ben!.pairingUrl),
        'runtime.clientEvents.subscribe',
        undefined,
        REQUEST_TIMEOUT_MS,
        {
          onResponse: (response) => {
            if (response.ok) {
              benEvents.push(response.result)
            }
          },
          onError: () => {}
        }
      )
      cleanups.push(() => benSubscription.close())
      await waitFor(() => benEvents.some((event) => event.type === 'ready'))

      const benSnapshot = presenceOf(benEvents).at(0)
      // Why partitioned by kind rather than sorted as one list: the host row's label is this machine's
      // hostname, so a sorted-position assertion passes or fails on what the build agent is called.
      expect(peerLabels(benSnapshot)).toEqual(['Ana laptop', 'Ben laptop'])
      expect(benSnapshot?.participants.filter((row) => row.kind === 'host')).toHaveLength(1)
      expect(benSnapshot?.participants.some((row) => row.label === 'coordinator')).toBe(false)
      expect(selfLabels(benSnapshot)).toEqual(['Ben laptop'])

      // Ben joining is the membership change Ana is told about through the fan-out. Same membership,
      // different `self` — resolved per listener, and the one-shot is absent from that payload too.
      await waitFor(() => presenceOf(anaEvents).length > 1)
      const anaFanOut = presenceOf(anaEvents).at(-1)
      expect(peerLabels(anaFanOut)).toEqual(['Ana laptop', 'Ben laptop'])
      expect(anaFanOut?.participants.filter((row) => row.kind === 'host')).toHaveLength(1)
      expect(selfLabels(anaFanOut)).toEqual(['Ana laptop'])
      expect(anaFanOut?.seq).toBeGreaterThan(0)
    }
  )
})
