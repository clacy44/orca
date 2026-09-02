// W-5..W-7 review finding 3 / Ruling 24 addendum 4(cc): the IPC arg's TS type
// (`accessProfile?: 'full' | 'peer'`) on mobile:getRuntimePairingUrl is compile-time only — a
// real IPC caller is not bound by it. Split out of mobile.test.ts (max-lines) — the shared
// mock/setup below is the minimal slice `registerMobileHandlers` needs, not the full
// network/QR mocking mobile.test.ts carries for its own suite.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('qrcode', () => ({
  default: {
    create: vi.fn().mockReturnValue({ modules: { size: 21 } }),
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

import { registerMobileHandlers } from './mobile'

describe('mobile:getRuntimePairingUrl access-profile validation', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  // A named mint with a junk accessProfile string must refuse profile_required, never cast it
  // through to createPairingOffer as if it were 'full' or 'peer'.
  it("finding 3 / 24(cc): refuses a named mint with an accessProfile that is neither 'full' nor 'peer'", async () => {
    const createPairingOffer = vi.fn()
    const ensureNetworkExposure = vi.fn().mockResolvedValue(undefined)
    const rpcServer = { createPairingOffer, ensureNetworkExposure }

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '100.64.1.20',
        name: 'Ben',
        accessProfile: 'peerx'
      })
    ).resolves.toEqual({
      available: false,
      reason: 'profile_required',
      guidance: 'Choose Full runtime access or Federation peer before generating a named link.'
    })
    expect(createPairingOffer).not.toHaveBeenCalled()
  })
})
