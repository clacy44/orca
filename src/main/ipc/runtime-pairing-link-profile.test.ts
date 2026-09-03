import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

// Why a sibling of mobile.test.ts rather than a case inside it: that file sits at the 800-line
// test ceiling, and AGENTS.md forbids raising it (same precedent as runtime-pairing-link-name.test.ts).
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

// S10-19 W-6 (M5-1/M5-2): a named link is handed to one person, so its profile must be an
// explicit choice — never inferred, never defaulted.
describe('S10-19 W-6: naming a runtime pairing link requires an access profile', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset().mockImplementation((channel: string, handler: () => unknown) => {
      handlers.set(channel, handler)
    })
    networkInterfacesMock.mockReset().mockReturnValue({})
    defaultRouteInterfaceNamesMock.mockReset().mockResolvedValue(new Set())
  })

  it('refuses a named runtime link with no accessProfile, before any network exposure', async () => {
    const createPairingOffer = vi.fn()
    const ensureNetworkExposure = vi.fn().mockResolvedValue(undefined)
    registerMobileHandlers({ createPairingOffer, ensureNetworkExposure } as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, { name: 'Ana' })
    ).resolves.toEqual({
      available: false,
      reason: 'profile_required',
      guidance: 'Choose Full runtime access or Federation peer before generating a named link.'
    })
    expect(ensureNetworkExposure).not.toHaveBeenCalled()
    expect(createPairingOffer).not.toHaveBeenCalled()
  })

  it('mints a named runtime link once accessProfile is given', async () => {
    const createPairingOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#ana',
      webClientUrl: null,
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'ana-1'
    })
    const ensureNetworkExposure = vi.fn().mockResolvedValue(undefined)
    registerMobileHandlers({ createPairingOffer, ensureNetworkExposure } as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '100.64.1.20',
        name: 'Ana',
        accessProfile: 'peer'
      })
    ).resolves.toMatchObject({ available: true, deviceId: 'ana-1' })

    expect(createPairingOffer).toHaveBeenCalledWith({
      address: '100.64.1.20',
      rotate: undefined,
      name: 'Ana',
      mint: 'always',
      // S10-16 C1 R1.1 (merge of the S10-16 link-binding branch): the named desktop link mints
      // into its own eviction budget. Still an exact-shape assertion, one key wider.
      budgetClass: 'ui_named',
      scope: 'runtime',
      reach: 'network',
      accessProfile: 'peer'
    })
  })
})
