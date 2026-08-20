import { OrchestrationError } from './orchestration-error'

export const FEDERATION_RELAY_BASE_INTERVAL_MS = 1_000
export const FEDERATION_RELAY_MAX_INTERVAL_MS = 60_000

// Why: worker-show reads these to answer "is the relay still pulling, and why not"
// without the coordinator having to tail runtime logs.
export type FederationSyncHealth = {
  lastSyncAt: string | null
  lastError: string | null
  consecutiveFailures: number
}

export function initialFederationSyncHealth(): FederationSyncHealth {
  return { lastSyncAt: null, lastError: null, consecutiveFailures: 0 }
}

export function recordFederationSyncSuccess(at: string): FederationSyncHealth {
  return { lastSyncAt: at, lastError: null, consecutiveFailures: 0 }
}

export function recordFederationSyncFailure(
  previous: FederationSyncHealth | undefined,
  error: unknown
): FederationSyncHealth {
  return {
    lastSyncAt: previous?.lastSyncAt ?? null,
    lastError: describeFederationSyncError(error),
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
  }
}

// Why: a peer that is unreachable must not be re-dialed every second for the life of
// the Dispatch; back off toward the cap and snap back to base on the first success.
export function federationRelayIntervalMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return FEDERATION_RELAY_BASE_INTERVAL_MS
  }
  return Math.min(
    FEDERATION_RELAY_BASE_INTERVAL_MS * 2 ** consecutiveFailures,
    FEDERATION_RELAY_MAX_INTERVAL_MS
  )
}

function describeFederationSyncError(error: unknown): string {
  if (error instanceof OrchestrationError) {
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
