// Why a module and not inline in index.ts: the guards here are the ones that carry S1's security
// property — no unnamed shared grant beside named ones, and no named grant at all under --no-pairing —
// and index.ts is an Electron entrypoint no test can load.
import { normalizePairingDeviceName } from '../../shared/pairing-device-name'
import type { PairingOfferUnavailableReason } from '../runtime/runtime-rpc'
import type { ServeNamedPairingReadiness, ServePairingReadiness } from './serve-readiness'

export type ServePairingScope = 'runtime' | 'mobile'

export type ServePairingOffer =
  | {
      available: true
      pairingUrl: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
    }
  | { available: false; reason: PairingOfferUnavailableReason; guidance: string }

export type ServePairingRequest = {
  pairingAddress: string | null
  pairNames: readonly string[]
  noPairing: boolean
  mobilePairing: boolean
}

export type ServePairingOfferSource = {
  createPairingOffer: (args: {
    address: string | null
    name: string
    mint?: boolean
    scope: ServePairingScope
  }) => ServePairingOffer
  renderPairingQr: (pairingUrl: string) => Promise<string | null>
}

export type ServePairingOffers = {
  pairing: ServePairingReadiness
  namedPairings?: readonly ServeNamedPairingReadiness[]
}

async function toPairingReadiness(
  offer: ServePairingOffer,
  scope: ServePairingScope,
  source: ServePairingOfferSource
): Promise<ServePairingReadiness> {
  if (!offer.available) {
    return offer
  }
  return {
    available: true,
    url: offer.pairingUrl,
    endpoint: offer.endpoint,
    deviceId: offer.deviceId,
    webClientUrl: offer.webClientUrl,
    scope,
    // Why: a QR per named link is the point — each person scans their own, not a shared one.
    qr: scope === 'mobile' ? await source.renderPairingQr(offer.pairingUrl) : null
  }
}

/** One pairing block per `--pair-name`, or today's single unnamed block when no name was given. */
export async function resolveServePairingOffers(
  request: ServePairingRequest,
  source: ServePairingOfferSource
): Promise<ServePairingOffers> {
  if (request.noPairing) {
    // Why first: --no-pairing wins outright — a direct `<binary> --serve` launch can carry both, and the
    // operator's refusal to pair must not be overridden by a name that never reached the CLI's check.
    return {
      pairing: {
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      }
    }
  }
  const scope: ServePairingScope = request.mobilePairing ? 'mobile' : 'runtime'
  // Why: the readiness banner interpolates this name into its own lines, so a name carrying a newline
  // would forge readiness output. One that normalizes away is unnamed, as a blank desktop field is.
  const pairNames = request.pairNames
    .map((name) => normalizePairingDeviceName(name))
    .filter((name) => name.length > 0)
  const namedPairings = await Promise.all(
    pairNames.map(async (name) => ({
      name,
      pairing: await toPairingReadiness(
        // Why: one grant per person — a shared link makes two humans one indistinguishable device.
        source.createPairingOffer({ address: request.pairingAddress, name, mint: true, scope }),
        scope,
        source
      )
    }))
  )
  const first = namedPairings[0]?.pairing
  const pairing =
    // Why: with names given, the unnamed host-minted offer is never created — creating it would add
    // exactly the shared grant --pair-name exists to avoid.
    first ??
    (await toPairingReadiness(
      source.createPairingOffer({
        address: request.pairingAddress,
        name: `${request.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope
      }),
      scope,
      source
    ))
  // Why: key omitted when unused so an unnamed serve publishes exactly today's payload.
  return { pairing, ...(namedPairings.length > 0 ? { namedPairings } : {}) }
}
