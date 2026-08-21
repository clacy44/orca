import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type { RuntimeClientEventStreamMessage } from '../../shared/runtime-client-events'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { RpcDispatcher } from './rpc/dispatcher'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import { terminalPresenceRegistry } from './terminal-presence-registry'

const TEST_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 5_000
const PTY_ID = 'pty-1'
const TERMINAL_HANDLE = 'term_presence_1'

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

function grantWriters(): string[] {
  return Array.from(terminalPresenceRegistry.grantWritesOf(PTY_ID).keys())
}

function sendTerminalText(connection: RemoteRuntimeRequestConnection): Promise<unknown> {
  return connection.request(
    'terminal.send',
    { terminal: TERMINAL_HANDLE, text: 'hello' },
    REQUEST_TIMEOUT_MS
  )
}

function pairingFor(pairingUrl: string) {
  const pairing = parsePairingCode(pairingUrl)
  if (!pairing) {
    throw new Error('invalid_pairing_url')
  }
  return pairing
}

describe('terminal.send presence attribution', () => {
  const cleanups: (() => void | Promise<void>)[] = []

  beforeEach(() => {
    terminalPresenceRegistry.reset()
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it(
    'stamps a desktop grant that holds a subscription and never a headless one-shot',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-presence-grant-write-'))
      cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
      const runtime = new OrcaRuntimeService()
      // Why patched rather than stubbed wholesale: the gate reads the REAL subscription index, which is
      // the only thing that separates a desktop's grant from a coordinator agent's.
      runtime.resolveLiveLeafForHandle = () => ({ ptyId: PTY_ID })
      runtime.sendTerminal = async () => ({ accepted: true, bytesWritten: 5 })
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      cleanups.push(() => server.stop())
      await server.start()

      // Why two mints: `reuse` hands the second caller the first pending grant, so both peers would be
      // one pairedDeviceId and the discriminator would pass without discriminating.
      const desktopOffer = server.createPairingOffer({
        name: 'Ana laptop',
        scope: 'runtime',
        mint: 'always'
      })
      const agentOffer = server.createPairingOffer({
        name: 'coordinator',
        scope: 'runtime',
        mint: 'always'
      })
      if (!desktopOffer.available || !agentOffer.available) {
        throw new Error('pairing_unavailable')
      }
      expect(desktopOffer.deviceId).not.toBe(agentOffer.deviceId)

      const events: RuntimeClientEventStreamMessage[] = []
      const subscription = await subscribeRemoteRuntimeRequest<RuntimeClientEventStreamMessage>(
        pairingFor(desktopOffer.pairingUrl),
        'runtime.clientEvents.subscribe',
        undefined,
        REQUEST_TIMEOUT_MS,
        {
          onResponse: (response) => {
            if (response.ok) {
              events.push(response.result)
            }
          },
          onError: () => {}
        }
      )
      cleanups.push(() => subscription.close())
      await waitFor(() => events.some((event) => event.type === 'ready'))

      // The desktop's own send rides a separate request socket, exactly as the renderer's does.
      const desktopRequest = new RemoteRuntimeRequestConnection(pairingFor(desktopOffer.pairingUrl))
      cleanups.push(() => desktopRequest.close())
      await sendTerminalText(desktopRequest)
      expect(grantWriters()).toEqual([desktopOffer.deviceId])

      // Why a real fresh socket: nulling the field would test a different code path — the coordinator
      // arrives with a valid pairedDeviceId and clientKind 'runtime', identical in every host-observed
      // field to the desktop above, and is separated only by holding no subscription.
      const agentRequest = new RemoteRuntimeRequestConnection(pairingFor(agentOffer.pairingUrl))
      cleanups.push(() => agentRequest.close())
      await sendTerminalText(agentRequest)
      expect(grantWriters()).toEqual([desktopOffer.deviceId])

      // Why: a local `orca terminal send` reaches the dispatcher with no identity slot at all (gap 4).
      await new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatch({
        id: 'local-1',
        authToken: 'local',
        method: 'terminal.send',
        params: { terminal: TERMINAL_HANDLE, text: 'hello' }
      })
      expect(grantWriters()).toEqual([desktopOffer.deviceId])

      // Site (d) never arms a hold: the interactive map stays empty through all three sends.
      expect(terminalPresenceRegistry.attachmentsOf(PTY_ID).size).toBe(0)
    }
  )
})
