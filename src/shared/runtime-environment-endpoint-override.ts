// S10-4 rulings 6/7: address override for a tunnel deployment, and the stale-pairing marker the
// federation relay loop sets. Split out of runtime-environment-store.ts to stay under the
// max-lines ratchet — the store's own read/write/resolve primitives are exported for this file.
import {
  readEnvironmentStore,
  writeEnvironmentStore,
  resolveEnvironmentFromStore,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store'
import type { KnownRuntimeEnvironment } from './runtime-environments'

// S10-4 ruling 6: a tunnel deployment (SSH port-forward, Tailscale, etc.) needs an address
// override that doesn't touch the pairing's security material (deviceToken/publicKeyB64) or
// the peer's own identity — only where this host reaches it. Persists onto the environment's
// preferred endpoint; the caller (CLI) is responsible for probing reachability first (this
// function has no network access, matching every other function in this file).
// Split out so a caller (the CLI's reachability probe) can run the same refusal BEFORE any
// network call without persisting anything — setEnvironmentEndpoint below calls this too, so
// the two can never drift.
export function assertValidEnvironmentEndpointUrl(url: string): void {
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `Endpoint must be a ws:// or wss:// URL, not "${url}".`
    )
  }
}

export function setEnvironmentEndpoint(
  userDataPath: string,
  selector: string,
  args: { url: string; now?: number }
): KnownRuntimeEnvironment {
  assertValidEnvironmentEndpointUrl(args.url)
  const store = readEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  const next: KnownRuntimeEnvironment = {
    ...existing,
    updatedAt: now,
    // S10-16 R4.4: re-pointing a URL moves the destination without changing a credential, so a
    // binding must re-prove rather than stay "live" against a new address — bump exactly as
    // updateEnvironmentFromPairingCode does. S10-16 C1 review finding 5: this also reaches
    // runtime-status.ts's revision diff (drops the cached status, advances the connection
    // generation) — intentional, not "zero blast radius": the endpoint moved, so the cached
    // connection to the old one must not read as still live.
    pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
    endpoints: existing.endpoints.map((endpoint) =>
      endpoint.id === existing.preferredEndpointId ? { ...endpoint, endpoint: args.url } : endpoint
    )
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments
      .map((entry) => (entry.id === existing.id ? next : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return next
}

// S10-4 ruling 7: the relay loop's own marker — set when a saved environment's RPC came back
// with the peer rejecting our pairing token, so `orca environment list`/`show` can surface it
// instead of the next call re-throwing the same generic `unauthorized` from inside a loop.
export function markEnvironmentPairingStale(userDataPath: string, selector: string): void {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  if (environment.pairingState === 'stale_pairing') {
    return
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.map((entry) =>
      entry.id === environment.id ? { ...entry, pairingState: 'stale_pairing' as const } : entry
    )
  })
}
