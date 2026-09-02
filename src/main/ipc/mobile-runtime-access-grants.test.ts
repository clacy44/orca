// Split out of mobile.test.ts (max-lines): merging the S10-19 integration tip into the S10-16
// link-binding branch widened this projection test with both slices' fields at once, pushing
// mobile.test.ts past the 800-line test budget. The block below is byte-identical to the one it
// replaces; the mock/setup above is the minimal slice `registerMobileHandlers` needs, mirroring
// mobile-pairing-access-profile.test.ts rather than mobile.test.ts's full network/QR mocking.
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

describe('mobile:listRuntimeAccessGrants', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  // S10-16 C1 review round 2 D3: grantClass/expiresAt added to the projection so a dead (expired,
  // never-consumed) legacy_coalesced grant is distinguishable from a live one — strictly stronger
  // than the prior pin, which asserted only deviceId/name/createdAt/lastSeenAt.
  it('lists runtime access grants including unused generated links, with grant class and expiry', () => {
    const rpcServer = {
      getDeviceRegistry: () => ({
        listDevices: () => [
          { deviceId: 'mobile-1', name: 'Phone', scope: 'mobile', pairedAt: 1, lastSeenAt: 2 },
          { deviceId: 'runtime-1', name: 'Browser', scope: 'runtime', pairedAt: 3, lastSeenAt: 4 },
          {
            deviceId: 'pending-runtime',
            name: 'Copied link',
            scope: 'runtime',
            pairedAt: 5,
            lastSeenAt: 0
          },
          {
            deviceId: 'minted-runtime',
            name: 'Ana',
            scope: 'runtime',
            pairedAt: 6,
            lastSeenAt: 0,
            grantClass: 'minted',
            pendingExpiresAt: 6_000
          }
        ]
      }),
      getLegacyGrantProfile: () => 'full' as const
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:listRuntimeAccessGrants')?.()).toEqual({
      grants: [
        {
          deviceId: 'minted-runtime',
          name: 'Ana',
          createdAt: 6,
          lastSeenAt: null,
          grantClass: 'minted',
          expiresAt: 6_000,
          effective: 'full',
          enforcedByThisRuntime: true
        },
        {
          deviceId: 'pending-runtime',
          name: 'Copied link',
          createdAt: 5,
          lastSeenAt: null,
          grantClass: 'legacy_coalesced',
          expiresAt: null,
          effective: 'full',
          enforcedByThisRuntime: true
        },
        {
          deviceId: 'runtime-1',
          name: 'Browser',
          createdAt: 3,
          lastSeenAt: 4,
          grantClass: 'legacy_coalesced',
          expiresAt: null,
          effective: 'full',
          enforcedByThisRuntime: true
        }
      ]
    })
  })
})
