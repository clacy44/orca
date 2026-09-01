import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-file'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  KnownRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentSource,
  type RuntimeEnvironmentStore
} from './runtime-environments'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

// Why: `parseHostAccessLink` (the desktop dialog's door) already refuses a mobile-scope link with
// this sentence, but this store's own `parsePairingCode` call is indifferent to scope — so
// `orca environment add` would happily save a mobile-scope invite whose non-allowlisted RPCs then
// fail per-method with `forbidden`, read as a broken host rather than a wrong-scope link. Refuse it
// here with the same words so the CLI and UI doors agree.
function assertNotMobileScope(offer: PairingOffer): void {
  if (offer.scope === 'mobile') {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'This link grants mobile-only access. Generate a link for another Orca client.'
    )
  }
}

// S10-15 finding 16: `@` and `:` are the two characters `name@host` addressing (agents-shared.ts
// parseAgentSelector, splitting on the LAST `@`) and the `agent:`/`run:`/`dispatch:` prefix
// namespace both rely on being absent from a saved environment's own name — an environment named
// `a@b` cannot round-trip through `orca agents find --all-hosts`'s own `addressOf`, and one
// containing `:` collides with a mailbox prefix. `local` is the reserved sentinel
// (LOCAL_FIND_HOST/LOCAL_PEER_HOST) that means "this host, not a saved environment" — an
// environment genuinely named `local` would silently address the wrong host on every `name@local`
// send. Refused at the door (name is chosen once, at `add`); the door is a NAME-shape check only
// — it never re-validates an existing store, so a name saved before this check keeps working
// exactly as it does today.
export function validateEnvironmentNameCandidate(
  name: string
): { ok: true } | { ok: false; reason: string } {
  if (name.includes('@')) {
    return {
      ok: false,
      reason: 'An environment name cannot contain "@" (reserved for name@host addressing).'
    }
  }
  if (name.includes(':')) {
    return {
      ok: false,
      reason:
        'An environment name cannot contain ":" (reserved for agent:/run:/dispatch: addressing).'
    }
  }
  if (name.trim().toLowerCase() === 'local') {
    return {
      ok: false,
      reason:
        '"local" is reserved (it means "this host", never a saved environment) and cannot be used as an environment name.'
    }
  }
  return { ok: true }
}

function assertAddressableEnvironmentName(name: string): void {
  const validation = validateEnvironmentNameCandidate(name)
  if (!validation.ok) {
    // No rename verb exists today — RuntimeEnvironmentStoreError carries no structured
    // nextSteps (see toRuntimeClientErrorCode in cli/runtime/environments.ts), so the working
    // fix is folded into the message itself: add under a valid name, then remove the old one.
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `${validation.reason} Choose a different name, then run "orca environment remove <old name>" once the new one is saved and working.`
    )
  }
}

export function listEnvironments(userDataPath: string): KnownRuntimeEnvironment[] {
  return readEnvironmentStore(userDataPath).environments
}

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: {
    name: string
    pairingCode: string
    now?: number
    source?: RuntimeEnvironmentSource
    connectionDependency?: 'ssh-tunnel'
  }
): KnownRuntimeEnvironment {
  assertAddressableEnvironmentName(args.name)
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  assertNotMobileScope(offer)
  const store = readEnvironmentStore(userDataPath)
  const now = args.now ?? Date.now()
  const existing = store.environments.find((entry) => entry.name === args.name)
  if (existing) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${args.name}" already exists.`
    )
  }
  const environment = createEnvironmentFromPairingOffer({
    id: randomUUID(),
    name: args.name,
    now,
    offer,
    runtimeId: null,
    ...(args.source ? { source: args.source } : {}),
    ...getPairingConnectionDependency(args.connectionDependency, offer)
  })
  const next = {
    version: 1 as const,
    environments: [
      ...store.environments.filter((entry) => entry.id !== environment.id),
      environment
    ].sort((a, b) => a.name.localeCompare(b.name))
  }
  writeEnvironmentStore(userDataPath, next)
  return environment
}

export function removeEnvironment(userDataPath: string, selector: string): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.filter((entry) => entry.id !== environment.id)
  })
  return environment
}

export function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number }
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  assertNotMobileScope(offer)
  const store = readEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
  const environment = createEnvironmentFromPairingOffer({
    id: existing.id,
    name: existing.name,
    now: existing.createdAt,
    offer,
    runtimeId: existing.runtimeId,
    ...(existing.source ? { source: existing.source } : {}),
    ...getPairingConnectionDependency(existing.connectionDependency, offer)
  })
  const next = {
    ...environment,
    createdAt: existing.createdAt,
    updatedAt: now,
    pairingRevision: Math.max(now, previousPairingRevision + 1),
    lastUsedAt: existing.lastUsedAt
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments
      .map((entry) => (entry.id === existing.id ? next : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return next
}

function getPairingConnectionDependency(
  dependency: 'ssh-tunnel' | undefined,
  offer: PairingOffer
): { connectionDependency?: 'ssh-tunnel' } {
  if (!dependency) {
    return {}
  }
  try {
    const endpoint = new URL(offer.endpoint)
    return classifyRemotePairingHostname(endpoint.hostname) === 'loopback'
      ? { connectionDependency: dependency }
      : {}
  } catch {
    return {}
  }
}

export function resolveEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
}

export function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): PairingOffer {
  return getPreferredPairingOffer(resolveEnvironment(userDataPath, selector))
}

// Why: markEnvironmentUsed runs on every runtime round-trip; persisting lastUsedAt each
// time forces a secure-file rewrite (ACL hardening), which blocks the main thread on
// Windows. lastUsedAt only needs coarse freshness, so skip writes within this window.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string; now?: number } = {}
): void {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  const runtimeIdChanged = args.runtimeId != null && args.runtimeId !== environment.runtimeId
  const pairedDeviceIdChanged =
    args.pairedDeviceId != null && args.pairedDeviceId !== environment.pairedDeviceId
  const lastUsedIsFresh =
    environment.lastUsedAt != null &&
    now >= environment.lastUsedAt &&
    now - environment.lastUsedAt < LAST_USED_PERSIST_INTERVAL_MS
  // S10-4 ruling 7: any successful round trip self-heals a stale-pairing mark — a call that
  // reaches this point already got past authentication.
  const clearsStalePairing = environment.pairingState === 'stale_pairing'
  if (!runtimeIdChanged && !pairedDeviceIdChanged && !clearsStalePairing && lastUsedIsFresh) {
    return
  }
  const next = store.environments.map((entry) =>
    entry.id === environment.id
      ? {
          ...entry,
          runtimeId: args.runtimeId ?? entry.runtimeId,
          ...(args.pairedDeviceId ? { pairedDeviceId: args.pairedDeviceId } : {}),
          lastUsedAt: now,
          updatedAt: now,
          pairingState: 'ok' as const
        }
      : entry
  )
  writeEnvironmentStore(userDataPath, { version: 1, environments: next })
}

export function resolveEnvironmentFromStore(
  store: RuntimeEnvironmentStore,
  selector: string
): KnownRuntimeEnvironment {
  const byId = store.environments.find((entry) => entry.id === selector)
  if (byId) {
    return byId
  }
  const matches = store.environments.filter((entry) => entry.name === selector)
  if (matches.length === 1) {
    return matches[0]!
  }
  if (matches.length > 1) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `Environment name "${selector}" is ambiguous; use the environment id.`
    )
  }
  throw new RuntimeEnvironmentStoreError('invalid_argument', `Unknown environment: ${selector}`)
}

export function readEnvironmentStore(userDataPath: string): RuntimeEnvironmentStore {
  const path = getEnvironmentStorePath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, environments: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = RuntimeEnvironmentStoreSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    )
    return {
      version: 1,
      environments: parsed.environments
        .map((entry) => KnownRuntimeEnvironmentSchema.parse(entry))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      `Could not read Orca environments at ${path}; the file is invalid.`
    )
  }
}

export function writeEnvironmentStore(userDataPath: string, store: RuntimeEnvironmentStore): void {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    writeSecureJsonFileWithinLimit(
      path,
      RuntimeEnvironmentStoreSchema.parse(store),
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    )
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}
