import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

// Why a sibling of mobile.test.ts rather than a case inside it: that file sits within 14 counted lines of
// the 800-line test ceiling, and AGENTS.md forbids raising it.
const { defaultRouteInterfaceNamesMock, handleMock, networkInterfacesMock } = vi.hoisted(() => ({
  defaultRouteInterfaceNamesMock: vi.fn(),
  handleMock: vi.fn(),
  networkInterfacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: defaultRouteInterfaceNamesMock
}))

import { registerMobileHandlers } from './mobile'

describe('naming a runtime pairing link', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const createPairingOffer = vi.fn()
  const ensureNetworkExposure = vi.fn()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset().mockImplementation((channel: string, handler: () => unknown) => {
      handlers.set(channel, handler)
    })
    networkInterfacesMock.mockReset().mockReturnValue({})
    defaultRouteInterfaceNamesMock.mockReset().mockResolvedValue(new Set())
    ensureNetworkExposure.mockReset().mockResolvedValue(undefined)
    createPairingOffer.mockReset().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#named',
      webClientUrl: null,
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'runtime-named'
    })
    registerMobileHandlers({ createPairingOffer, ensureNetworkExposure } as never)
  })

  const generate = async (args: Record<string, unknown>): Promise<unknown> =>
    await handlers.get('mobile:getRuntimePairingUrl')?.(null, args)

  it('mints a distinct grant for each named link', async () => {
    await generate({ address: '100.64.1.20', name: 'Ana', accessProfile: 'full' })
    await generate({ address: '100.64.1.20', name: 'Ben', accessProfile: 'peer' })

    expect(createPairingOffer.mock.calls.map(([args]) => args)).toEqual([
      {
        address: '100.64.1.20',
        rotate: undefined,
        name: 'Ana',
        mint: 'always',
        scope: 'runtime',
        reach: 'network',
        accessProfile: 'full'
      },
      {
        address: '100.64.1.20',
        rotate: undefined,
        name: 'Ben',
        mint: 'always',
        scope: 'runtime',
        reach: 'network',
        accessProfile: 'peer'
      }
    ])
  })

  // S10-19 W-6 (M5-1): a named link with no accessProfile is refused before any offer is minted.
  it('refuses a named link with no accessProfile', async () => {
    const result = await generate({ address: '100.64.1.20', name: 'Ana' })
    expect(result).toEqual({
      available: false,
      reason: 'profile_required',
      guidance: 'Choose Full runtime access or Federation peer before generating a named link.'
    })
    expect(createPairingOffer).not.toHaveBeenCalled()
  })

  it('treats a blank or whitespace-only name as unnamed', async () => {
    // Negative control: without a real name the call must stay byte-identical to today's — no `mint` key
    // at all, and the host-minted date label.
    await generate({ address: '100.64.1.20', name: '   ' })

    expect(createPairingOffer).toHaveBeenCalledWith({
      address: '100.64.1.20',
      rotate: undefined,
      name: expect.stringMatching(/^Runtime /),
      scope: 'runtime',
      reach: 'network',
      accessProfile: 'full'
    })
  })
})
