import { OrchestrationError } from './orchestration-error'

export const FEDERATION_RELAY_BASE_INTERVAL_MS = 1_000
export const FEDERATION_RELAY_MAX_INTERVAL_MS = 60_000

// Why a duration and not a bare count: a count of five elapses in ~31s on the doubling curve, so it
// escalates an ordinary peer restart or a tunnel re-dial — routine events that would then wake every
// parked `check --wait`, which is the noise the brief exists to avoid.
export const FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS = FEDERATION_RELAY_MAX_INTERVAL_MS * 2

// Why derived rather than written down: the count only means "the outage lasted this long" while the
// backoff curve is what it is, so a curve change has to move the count with it. The schedule is a
// lower bound — a failure that times out rather than refusing takes longer still.
export function federationRelayFailuresToOutlast(outageMs: number): number {
  let failures = 1
  let elapsedMs = 0
  while (elapsedMs < outageMs) {
    elapsedMs += federationRelayIntervalMs(failures)
    failures += 1
  }
  return failures
}

export const FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD = federationRelayFailuresToOutlast(
  FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS
)

export type FederationRelayHealthTransition = 'unreachable' | 'recovered' | null

// Why an edge and not a level: the notice is one per outage, so it fires on the crossing and stays
// silent for every failure after it until a success resets the count. The recovery notice is gated
// on the same threshold — a coordinator never told the transport died is not told it came back.
export function classifyFederationRelayHealthTransition(
  previous: FederationSyncHealth | undefined,
  next: FederationSyncHealth,
  threshold: number = FEDERATION_RELAY_UNREACHABLE_FAILURE_THRESHOLD
): FederationRelayHealthTransition {
  const before = previous?.consecutiveFailures ?? 0
  if (before < threshold && next.consecutiveFailures >= threshold) {
    return 'unreachable'
  }
  if (before >= threshold && next.consecutiveFailures === 0) {
    return 'recovered'
  }
  return null
}

// Why: worker-show reads these to answer "is the relay still pulling, and why not"
// without the coordinator having to tail runtime logs.
export type FederationSyncHealth = {
  lastSyncAt: string | null
  lastError: string | null
  consecutiveFailures: number
}

// Why the health survives the process: A1 section 9 measured a restart laundering a peer that had
// been dead for days into `never / 0`, which reads to a coordinator as "this Dispatch never
// federated" rather than "nothing has reached it".
export type FederationSyncHealthRow = {
  last_sync_at: string | null
  last_error: string | null
  consecutive_failures: number
}

// Why null rather than a zeroed record for an untouched row: `sync` may only widen — the same field
// and shape, non-null more often — so a Dispatch the relay has never settled on keeps reporting the
// null it reports today instead of gaining a fabricated "healthy" reading.
export function federationSyncHealthFromRow(
  row: FederationSyncHealthRow | undefined
): FederationSyncHealth | null {
  if (!row || (row.last_sync_at === null && row.last_error === null && !row.consecutive_failures)) {
    return null
  }
  return {
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures
  }
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
