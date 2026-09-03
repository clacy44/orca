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
  // S10-19 W-6: matched positionally with pairNames — pairingProfiles[i] is the profile for
  // pairNames[i]. Required whenever pairNames is non-empty (enforced at the CLI, cli/handlers/
  // core.ts, and re-checked here as defense-in-depth since this process reads its own argv).
  // W-5..W-7 review finding 3 / Ruling 24 addendum 4(cc): typed `readonly string[]`, not
  // `('full'|'peer')[]` — argv is untyped text, and index.ts no longer lies about that with an
  // `as` cast. The enum is validated below, at the one place this process reads its own argv.
  pairingProfiles: readonly string[]
  noPairing: boolean
  mobilePairing: boolean
}

export type ServePairingOfferSource = {
  createPairingOffer: (args: {
    address: string | null
    name: string
    mint?: 'always' | 'reuse'
    scope: ServePairingScope
    // S10-16 R1.1: which minted-grant eviction budget this invite counts against.
    budgetClass?: 'host_auto' | 'serve_named'
    accessProfile: 'full' | 'peer'
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
  source: ServePairingOfferSource,
  profile: 'full' | 'peer'
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
    qr: scope === 'mobile' ? await source.renderPairingQr(offer.pairingUrl) : null,
    profile
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
  // W-5..W-7 review F7 / Ruling 24(y): zip raw name + raw profile BEFORE normalizing/filtering
  // names, so a name that normalizes away (blank/whitespace) cannot shift a later name onto an
  // earlier profile. Why: the readiness banner interpolates the name into its own lines, so a
  // name carrying a newline would forge readiness output. One that normalizes away is unnamed,
  // as a blank desktop field is.
  const rawPairings = request.pairNames.map((rawName, index) => ({
    name: normalizePairingDeviceName(rawName),
    profile: request.pairingProfiles[index]
  }))
  const namedPairs = rawPairings.filter((pair) => pair.name.length > 0)
  // S10-19 W-6 (ops MJ-1) / F8: required, matched positionally with --pair-name — but ONLY for
  // runtime-scope grants; a mobile grant is never 'peer', so named mobile pairing carries no
  // profile at all (the CLI refuses --pairing-profile beside --mobile-pairing). This process
  // reads its own argv independently of the CLI parent, so both checks are re-verified here
  // rather than trusted from the spawn — the CLI's own check is the primary UX, this is the
  // closed default.
  if (scope === 'runtime' && namedPairs.length > 0) {
    if (request.pairingProfiles.length !== request.pairNames.length) {
      throw new Error(
        '--pairing-profile must be given exactly once per --pair-name, in the same order.'
      )
    }
    if (namedPairs.some((pair) => pair.profile === undefined)) {
      // Never a silent full mint (F7): a misaligned name/profile pair is a refusal.
      throw new Error(
        '--pairing-profile must be given exactly once per --pair-name, in the same order.'
      )
    }
    // W-5..W-7 review finding 3 / Ruling 24 addendum 4(cc): the VALUE, not just its presence —
    // an unrecognized --serve-pairing-profile string must REFUSE (fail closed), never mint
    // 'full' via the `?? 'full'` fallback below (that fallback exists for the ABSENT-profile
    // case, mobile scope, which never reaches this branch).
    const invalid = namedPairs.find((pair) => pair.profile !== 'full' && pair.profile !== 'peer')
    if (invalid) {
      throw new Error(`--serve-pairing-profile must be 'full' or 'peer', got '${invalid.profile}'.`)
    }
  }
  const namedPairings = await Promise.all(
    namedPairs.map(async ({ name, profile }) => {
      const accessProfile: 'full' | 'peer' =
        scope === 'mobile' ? 'full' : profile === 'peer' ? 'peer' : 'full'
      return {
        name,
        pairing: await toPairingReadiness(
          // Why: one grant per person — a shared link makes two humans one indistinguishable device.
          source.createPairingOffer({
            address: request.pairingAddress,
            name,
            mint: 'always',
            scope,
            // S10-16 R1.1: the named `orca serve` mint lane's own eviction budget.
            budgetClass: 'serve_named',
            accessProfile
          }),
          scope,
          source,
          accessProfile
        )
      }
    })
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
        scope,
        budgetClass: 'host_auto',
        // S10-19 §10.4/Ruling 18(g): the unnamed host-minted offer is exempt from the
        // required-choice rule — it always mints 'full', unchanged from before this slice.
        accessProfile: 'full'
      }),
      scope,
      source,
      'full'
    ))
  // Why: key omitted when unused so an unnamed serve publishes exactly today's payload.
  return { pairing, ...(namedPairings.length > 0 ? { namedPairings } : {}) }
}
