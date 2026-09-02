import type { PairingOfferUnavailableReason } from '../runtime/runtime-rpc'

export type ServePairingUnavailableReason = PairingOfferUnavailableReason | 'disabled_by_operator'

export type ServePairingReadiness =
  | {
      available: true
      url: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
      scope: 'runtime' | 'mobile'
      qr: string | null
      // S10-19 W-6: printed on the banner/--json so an operator can see what was minted without
      // a separate `orca lane status` round trip.
      profile: 'full' | 'peer'
    }
  | {
      available: false
      reason: ServePairingUnavailableReason
      guidance: string
    }

export type ServeNamedPairingReadiness = {
  name: string
  pairing: ServePairingReadiness
}

export type ServeReadiness = {
  runtimeId: string
  boundEndpoint: string | null
  advertisedEndpoint: string | null
  managedWslCliReconciliation: 'pending' | 'settled' | 'failed'
  pairing: ServePairingReadiness
  // Why: one entry per `--pair-name`, each a separately revocable grant. Absent when no name was given,
  // so an unnamed serve emits exactly the payload it always has. The first entry is also `pairing`, so
  // every reader that only knows about `pairing` still sees a real offer.
  namedPairings?: readonly ServeNamedPairingReadiness[]
}

export type ServeReadinessOutput =
  | { mode: 'human' | 'json' }
  | { mode: 'recipe-json'; projectRoot: string }

type ReadinessWrite = (output: string) => Promise<void>

export class ServeReadinessPublisher {
  private state: 'pending' | 'publishing' | 'published' | 'failed' = 'pending'

  constructor(private readonly write: ReadinessWrite = writeStdout) {}

  async publish(readiness: ServeReadiness, output: ServeReadinessOutput): Promise<void> {
    if (this.state !== 'pending') {
      throw new Error(`Serve readiness publication already ${this.state}`)
    }
    this.state = 'publishing'
    try {
      await this.write(`${renderServeReadiness(readiness, output)}\n`)
      this.state = 'published'
    } catch (error) {
      this.state = 'failed'
      throw error
    }
  }
}

export function renderServeReadiness(
  readiness: ServeReadiness,
  output: ServeReadinessOutput
): string {
  if (output.mode === 'recipe-json') {
    if (!readiness.pairing.available) {
      throw new Error(
        `Recipe JSON output requires runtime pairing: ${readiness.pairing.reason}. ${readiness.pairing.guidance}`
      )
    }
    return JSON.stringify({
      schemaVersion: 1,
      pairingCode: readiness.pairing.url,
      projectRoot: output.projectRoot
    })
  }
  if (output.mode === 'json') {
    return JSON.stringify({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: readiness.runtimeId,
      endpoint: readiness.boundEndpoint,
      boundEndpoint: readiness.boundEndpoint,
      advertisedEndpoint: readiness.advertisedEndpoint,
      managedWslCliReconciliation: readiness.managedWslCliReconciliation,
      pairing: readiness.pairing,
      // Why: key omitted when unused so an unnamed serve's JSON line is byte-identical to today's.
      ...(readiness.namedPairings ? { namedPairings: readiness.namedPairings } : {})
    })
  }
  return renderHumanReadiness(readiness)
}

function renderHumanReadiness(readiness: ServeReadiness): string {
  const lines = [
    'Orca server ready',
    `Bound endpoint: ${readiness.boundEndpoint ?? 'websocket unavailable'}`,
    `Advertised endpoint: ${readiness.advertisedEndpoint ?? 'unavailable'}`
  ]
  // Why: an unnamed serve renders one unlabelled block, exactly as before; a named one renders a block
  // per person so each human can be handed their own line rather than all of them one link.
  const blocks: readonly { name: string | null; pairing: ServePairingReadiness }[] =
    readiness.namedPairings ?? [{ name: null, pairing: readiness.pairing }]
  for (const block of blocks) {
    lines.push(...renderPairingLines(block.pairing, block.name))
  }
  return lines.join('\n')
}

function renderPairingLines(pairing: ServePairingReadiness, name: string | null): string[] {
  const suffix = name === null ? '' : ` (${name})`
  if (!pairing.available) {
    return [
      `Pairing unavailable${suffix}: ${pairing.reason}`,
      `Pairing guidance${suffix}: ${pairing.guidance}`
    ]
  }
  const lines: string[] = []
  if (pairing.webClientUrl) {
    lines.push(`Web client URL${suffix}: ${pairing.webClientUrl}`)
  }
  if (pairing.scope === 'mobile' && pairing.qr) {
    lines.push(`Mobile pairing QR${suffix}:\n${pairing.qr}`)
  }
  lines.push(`Pairing URL${suffix}: ${pairing.url}`)
  lines.push(`Access profile${suffix}: ${pairing.profile}`)
  return lines
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
