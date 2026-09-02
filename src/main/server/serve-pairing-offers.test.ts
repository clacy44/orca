import { describe, expect, it, vi } from 'vitest'
import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '../../shared/pairing-device-name'
import { renderServeReadiness } from './serve-readiness'
import {
  resolveServePairingOffers,
  type ServePairingOffer,
  type ServePairingOfferSource
} from './serve-pairing-offers'

const offerFor = (name: string): ServePairingOffer => ({
  available: true,
  pairingUrl: `orca://pair#${name}`,
  endpoint: 'ws://100.64.1.20:6768',
  deviceId: `device-${name}`,
  webClientUrl: null
})

const sourceFor = (): ServePairingOfferSource & {
  createPairingOffer: ReturnType<typeof vi.fn>
  renderPairingQr: ReturnType<typeof vi.fn>
} => ({
  createPairingOffer: vi.fn((args: { name: string }) => offerFor(args.name)),
  renderPairingQr: vi.fn(async (pairingUrl: string) => `qr:${pairingUrl}`)
})

describe('resolveServePairingOffers', () => {
  it('mints one grant per name and never the shared unnamed one beside them', async () => {
    const source = sourceFor()

    const offers = await resolveServePairingOffers(
      {
        pairingAddress: '100.64.1.20',
        pairNames: ['Ana', 'Ben'],
        noPairing: false,
        mobilePairing: false
      },
      source
    )

    // The guard that carries the whole feature: exactly as many offers as people, each minted.
    expect(source.createPairingOffer).toHaveBeenCalledTimes(2)
    expect(source.createPairingOffer.mock.calls.map(([args]) => args)).toEqual([
      {
        address: '100.64.1.20',
        name: 'Ana',
        mint: 'always',
        scope: 'runtime',
        budgetClass: 'serve_named'
      },
      {
        address: '100.64.1.20',
        name: 'Ben',
        mint: 'always',
        scope: 'runtime',
        budgetClass: 'serve_named'
      }
    ])
    // Negative control: the dated host-minted fallback — the shared grant — is never created.
    expect(source.createPairingOffer).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^CLI /) })
    )
    expect(offers.namedPairings?.map((entry) => entry.name)).toEqual(['Ana', 'Ben'])
    // `pairing` is the first named block, so a reader that only knows that key sees a real offer.
    expect(offers.pairing).toEqual(offers.namedPairings?.[0]?.pairing)
  })

  it('creates the single dated grant of today when no name is given', async () => {
    const source = sourceFor()

    const offers = await resolveServePairingOffers(
      { pairingAddress: null, pairNames: [], noPairing: false, mobilePairing: false },
      source
    )

    expect(source.createPairingOffer).toHaveBeenCalledTimes(1)
    expect(source.createPairingOffer).toHaveBeenCalledWith({
      address: null,
      name: expect.stringMatching(/^CLI /),
      scope: 'runtime',
      budgetClass: 'host_auto'
    })
    // Negative control on the shape: no mint key, and no namedPairings key at all.
    expect(source.createPairingOffer.mock.calls[0]?.[0]).not.toHaveProperty('mint')
    expect(offers).not.toHaveProperty('namedPairings')
    expect(offers.pairing).toEqual({
      available: true,
      url: expect.stringContaining('orca://pair#CLI '),
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: expect.stringContaining('device-CLI '),
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    })
  })

  it('refuses to mint any grant when pairing is disabled, name or not', async () => {
    const source = sourceFor()

    const offers = await resolveServePairingOffers(
      {
        pairingAddress: null,
        pairNames: ['Ana'],
        noPairing: true,
        mobilePairing: false
      },
      source
    )

    // The gate a direct `<binary> --serve --serve-pair-name Ana --serve-no-pairing` bypasses at the CLI:
    // the operator's refusal to pair must not be overridden by a name.
    expect(source.createPairingOffer).not.toHaveBeenCalled()
    expect(offers).toEqual({
      pairing: {
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      }
    })
  })

  it('renders a QR per named mobile link and none on the runtime scope', async () => {
    const source = sourceFor()

    const mobile = await resolveServePairingOffers(
      { pairingAddress: null, pairNames: ['Ana', 'Ben'], noPairing: false, mobilePairing: true },
      source
    )

    expect(source.createPairingOffer.mock.calls.map(([args]) => args.scope)).toEqual([
      'mobile',
      'mobile'
    ])
    expect(
      mobile.namedPairings?.map((entry) => (entry.pairing.available ? entry.pairing.qr : null))
    ).toEqual(['qr:orca://pair#Ana', 'qr:orca://pair#Ben'])
  })

  it('normalizes a name before it reaches the registry or the banner', async () => {
    const source = sourceFor()

    const offers = await resolveServePairingOffers(
      {
        pairingAddress: null,
        pairNames: ['Ana\nPairing URL: orca://evil', '   ', 'B'.repeat(200)],
        noPairing: false,
        mobilePairing: false
      },
      source
    )

    // A whitespace-only name is the desktop blank field, so it mints nothing.
    expect(source.createPairingOffer.mock.calls.map(([args]) => args.name)).toEqual([
      'Ana Pairing URL: orca://evil',
      'B'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH)
    ])
    // The forging vector, asserted where it would have landed: one readiness line per real block.
    const rendered = renderServeReadiness(
      {
        runtimeId: 'runtime-1',
        boundEndpoint: 'ws://100.64.1.20:6768',
        advertisedEndpoint: 'ws://100.64.1.20:6768',
        managedWslCliReconciliation: 'settled',
        ...offers
      },
      { mode: 'human' }
    )
    expect(rendered.split('\n').filter((line) => line.startsWith('Pairing URL'))).toHaveLength(2)
  })

  it('carries an unavailable offer through instead of inventing a link', async () => {
    const source = sourceFor()
    source.createPairingOffer.mockReturnValue({
      available: false,
      reason: 'websocket_unavailable',
      guidance: 'Inspect preceding runtime errors.'
    })

    const offers = await resolveServePairingOffers(
      { pairingAddress: null, pairNames: ['Ana'], noPairing: false, mobilePairing: false },
      source
    )

    expect(source.renderPairingQr).not.toHaveBeenCalled()
    expect(offers.pairing).toEqual({
      available: false,
      reason: 'websocket_unavailable',
      guidance: 'Inspect preceding runtime errors.'
    })
  })
})
