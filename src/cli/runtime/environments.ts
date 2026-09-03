import {
  addEnvironmentFromPairingCode as addEnvironmentFromPairingCodeInStore,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed as markEnvironmentUsedInStore,
  removeEnvironment as removeEnvironmentFromStore,
  resolveEnvironment as resolveEnvironmentFromStore,
  resolveEnvironmentPairingOffer as resolveEnvironmentPairingOfferFromStore,
  updateEnvironmentFromPairingCode as updateEnvironmentFromPairingCodeInStore,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from '../../shared/runtime-environment-store'
import {
  setEnvironmentEndpoint as setEnvironmentEndpointInStore,
  assertValidEnvironmentEndpointUrl
} from '../../shared/runtime-environment-endpoint-override'
import type {
  KnownRuntimeEnvironment,
  PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import type { PairingOffer } from '../../shared/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { sendWebSocketRequest } from './websocket-transport'
import { RuntimeClientError } from './types'

const DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS = 15_000

export type EnvironmentAddResult = {
  environment: PublicKnownRuntimeEnvironment
}

export type EnvironmentRemoveResult = {
  removed: PublicKnownRuntimeEnvironment
}

export { getEnvironmentStorePath, listEnvironments }

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: { name: string; pairingCode: string; now?: number }
): KnownRuntimeEnvironment {
  return translateStoreError(() => addEnvironmentFromPairingCodeInStore(userDataPath, args))
}

// R22.2: re-pairs an EXISTING record in place (preserves createdAt, bumps pairingRevision, R15's
// old-binding kill), rather than `add`'s new-record path.
export function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number }
): KnownRuntimeEnvironment {
  return translateStoreError(() =>
    updateEnvironmentFromPairingCodeInStore(userDataPath, selector, args)
  )
}

export function removeEnvironment(userDataPath: string, selector: string): KnownRuntimeEnvironment {
  return translateStoreError(() => removeEnvironmentFromStore(userDataPath, selector))
}

export function resolveEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  return translateStoreError(() => resolveEnvironmentFromStore(userDataPath, selector))
}

export function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): PairingOffer {
  return translateStoreError(() => resolveEnvironmentPairingOfferFromStore(userDataPath, selector))
}

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; now?: number } = {}
): void {
  translateStoreError(() => markEnvironmentUsedInStore(userDataPath, selector, args))
}

export type EnvironmentSetEndpointResult = {
  environment: PublicKnownRuntimeEnvironment
}

// S10-4 ruling 6: refuses a non-ws/wss scheme (translateStoreError below, no network touched)
// then probes the NEW address before persisting it — an override that leaves the store
// pointing at a dead endpoint is worse than refusing the command outright, and the same
// deviceToken/publicKeyB64 the environment already trusts rides the probe unchanged.
export async function setEnvironmentEndpoint(
  userDataPath: string,
  selector: string,
  args: { url: string; timeoutMs?: number }
): Promise<EnvironmentSetEndpointResult> {
  const environment = translateStoreError(() => resolveEnvironmentFromStore(userDataPath, selector))
  // Cheap input validation shares the store's refusal wording, run before any network call and
  // before anything is persisted.
  translateStoreError(() => assertValidEnvironmentEndpointUrl(args.url))
  const currentOffer = getPreferredPairingOffer(environment)
  const probeOffer: PairingOffer = {
    v: PAIRING_OFFER_VERSION,
    endpoint: args.url,
    deviceToken: currentOffer.deviceToken,
    publicKeyB64: currentOffer.publicKeyB64,
    ...(currentOffer.pairedDeviceId ? { pairedDeviceId: currentOffer.pairedDeviceId } : {})
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS
  let response
  try {
    response = await sendWebSocketRequest<RuntimeStatus>(
      probeOffer,
      'status.get',
      undefined,
      timeoutMs
    )
  } catch (error) {
    throw new RuntimeClientError(
      'runtime_unavailable',
      `Cannot reach Orca at ${args.url}: ${error instanceof Error ? error.message : String(error)}. The endpoint was not saved.`
    )
  }
  if (response.ok !== true) {
    throw new RuntimeClientError(
      'runtime_unavailable',
      `Cannot reach Orca at ${args.url}: ${response.error.message}. The endpoint was not saved.`
    )
  }
  const saved = translateStoreError(() =>
    setEnvironmentEndpointInStore(userDataPath, selector, { url: args.url })
  )
  return { environment: redactRuntimeEnvironmentForSetEndpoint(saved) }
}

function redactRuntimeEnvironmentForSetEndpoint(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  return {
    ...environment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _deviceToken, publicKeyB64: _key, ...rest }) => rest
    )
  }
}

function translateStoreError<TResult>(fn: () => TResult): TResult {
  try {
    return fn()
  } catch (error) {
    if (error instanceof RuntimeEnvironmentStoreError) {
      throw new RuntimeClientError(toRuntimeClientErrorCode(error.code), error.message)
    }
    throw error
  }
}

function toRuntimeClientErrorCode(
  code: RuntimeEnvironmentStoreErrorCode
): 'invalid_argument' | 'runtime_error' {
  return code
}
