// S10-4 ruling 3 (CLI half): `orca agents find --all-hosts` unions the directory across every
// saved environment. Guide: skill-guides/orchestration.md "Cross-Host". Trust boundary
// (s10-4-federation-spec.md ARBITRATION #10): a peer's own `agents.find` outcome/confidence is
// never trusted directly - every host's RAW rows are pulled (`orchestration.agents.list`,
// row-capped) and re-scored together, once, by the same local resolver every host runs. Ruling
// 11: `resolved` is allowed among ANSWERED hosts only - a silent peer never vetoes local
// resolution, but it is always named in `unreached` with `hostsAnswered: n/m` alongside it.
import {
  resolveAgentQuery,
  type AgentResolverCandidateInput
} from '../../main/runtime/orchestration/agent-resolver'
import { RuntimeClient } from '../runtime-client'
import { listEnvironments } from '../runtime/environments'

export const LOCAL_FIND_HOST = 'local'
const CROSS_HOST_ROW_CAP = 200
export const DEFAULT_CROSS_HOST_TIMEOUT_MS = 10_000

// Why: an older or capability-missing peer answers an unknown/ungated method with one of
// these - every other failure means the peer itself could not be reached. Mirrors
// environment-terminal-roster.ts's classification for the same reason: a stale peer degrades
// into "unreached", never a hard error for the whole merged query.
const CAPABILITY_MISSING_ERROR_CODES = new Set([
  'method_not_found',
  'capability_unsupported',
  'orchestration_migration_required'
])

export type CrossHostCandidate = {
  id: string
  host: string
  foreign: boolean
  displayName: string
  role: string | null
  state: 'live' | 'idle' | 'gone'
  derived: boolean
  confidence: number
  why: string[]
  terminalHandle?: string | null
}

export type UnreachedHost = { host: string; reason: string }

export type CrossHostFindResult = {
  outcome: 'resolved' | 'ambiguous' | 'no_match'
  query: string
  threshold: number
  margin: number
  candidates: CrossHostCandidate[]
  hostsAnswered: string
  unreached: UnreachedHost[]
  nextSteps: string[]
}

type RawRow = AgentResolverCandidateInput & { terminalHandle: string | null }

type HostListing = {
  host: string
  foreign: boolean
  rows: RawRow[]
  ok: boolean
  reason: string | null
}

type ListCallClient = { call: RuntimeClient['call'] }

type RawAgentListRow = {
  id: string
  displayName: string
  role: string | null
  title: string | null
  worktreePath: string | null
  branch: string | null
  state: 'live' | 'idle' | 'gone'
  derived: boolean
  terminalHandle?: string | null
}

async function listHost(
  host: string,
  foreign: boolean,
  client: ListCallClient,
  timeoutMs: number
): Promise<HostListing> {
  try {
    const response = await withTimeout(
      client.call<{ agents: RawAgentListRow[] }>('orchestration.agents.list', {
        includeDerived: true,
        includeQuarantined: false,
        limit: CROSS_HOST_ROW_CAP
      }),
      timeoutMs
    )
    const rows = response.result.agents.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      role: a.role,
      title: a.title,
      worktreePath: a.worktreePath,
      branch: a.branch,
      state: a.state,
      derived: a.derived,
      terminalHandle: a.terminalHandle ?? null
    }))
    return { host, foreign, rows, ok: true, reason: null }
  } catch (error) {
    return { host, foreign, rows: [], ok: false, reason: describeFailure(error) }
  }
}

class ProbeTimeoutError extends Error {}

function withTimeout<TValue>(pending: Promise<TValue>, timeoutMs: number): Promise<TValue> {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProbeTimeoutError(`no response within ${timeoutMs}ms`)),
      timeoutMs
    )
    timer.unref?.()
    pending.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ProbeTimeoutError) {
    return message
  }
  const code = errorCode(error)
  if (code && CAPABILITY_MISSING_ERROR_CODES.has(code)) {
    return 'peer does not support the agent directory'
  }
  return code ? `${code}: ${message}` : message
}

// Why a composite scoring id: candidates from every host feed one `resolveAgentQuery` call so a
// remote row is scored by the exact same code the local one is (never a peer-asserted
// confidence) - ids only need to be unique within that one call, so `host id` is enough and is
// unwound below before the result ever leaves this module.
function compositeId(host: string, id: string): string {
  return `${host} ${id}`
}

export async function findAgentsAcrossHosts(options: {
  client: ListCallClient
  userDataPath: string
  query: string
  limit?: number
  timeoutMs?: number
  // Why overridable: the real factory opens a network connection per saved environment -
  // tests substitute a fake `ListCallClient` per host instead of standing up a peer runtime.
  hostClientFactory?: (environmentId: string, timeoutMs: number) => ListCallClient
}): Promise<CrossHostFindResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CROSS_HOST_TIMEOUT_MS
  const makeHostClient =
    options.hostClientFactory ??
    ((environmentId: string, hostTimeoutMs: number) =>
      new RuntimeClient(options.userDataPath, hostTimeoutMs, null, environmentId))
  const environments = listEnvironments(options.userDataPath)
  const listings = await Promise.all([
    listHost(LOCAL_FIND_HOST, false, options.client, timeoutMs),
    ...environments.map((environment) =>
      listHost(environment.name, true, makeHostClient(environment.id, timeoutMs), timeoutMs)
    )
  ])

  const metaByCompositeId = new Map<
    string,
    { host: string; foreign: boolean; role: string | null; terminalHandle: string | null }
  >()
  const merged: AgentResolverCandidateInput[] = []
  for (const listing of listings) {
    if (!listing.ok) {
      continue
    }
    for (const row of listing.rows) {
      const id = compositeId(listing.host, row.id)
      metaByCompositeId.set(id, {
        host: listing.host,
        foreign: listing.foreign,
        role: row.role,
        terminalHandle: row.terminalHandle
      })
      merged.push({ ...row, id })
    }
  }

  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20)
  const resolved = resolveAgentQuery(options.query, merged)
  const trimmed = resolved.candidates.slice(0, limit)
  const candidates: CrossHostCandidate[] = trimmed.map((candidate) => {
    const meta = metaByCompositeId.get(candidate.id)
    // Why non-null-ish fallback: every scored candidate id was minted above from a listing this
    // same call built, so a lookup miss can only mean a real bug, not bad input.
    const host = meta?.host ?? LOCAL_FIND_HOST
    const rawId = candidate.id.slice(host.length + 1)
    return {
      id: rawId,
      host,
      foreign: meta?.foreign ?? false,
      displayName: candidate.displayName,
      role: meta?.role ?? null,
      state: candidate.state,
      derived: candidate.derived,
      confidence: candidate.confidence,
      why: candidate.why,
      terminalHandle: meta?.terminalHandle ?? null
    }
  })

  const answered = listings.filter((listing) => listing.ok).length
  const unreached: UnreachedHost[] = listings
    .filter((listing) => !listing.ok)
    .map((listing) => ({ host: listing.host, reason: listing.reason ?? 'unreachable' }))

  const nextSteps =
    resolved.outcome === 'ambiguous'
      ? candidates.slice(0, 2).map((c) => `orca agents show ${addressOf(c)}`)
      : resolved.outcome === 'no_match'
        ? ['orca agents list', 'orca agents list --environment <name> (per remote host)']
        : []

  return {
    outcome: resolved.outcome,
    query: resolved.query,
    threshold: resolved.threshold,
    margin: resolved.margin,
    candidates,
    hostsAnswered: `${answered}/${listings.length}`,
    unreached,
    nextSteps
  }
}

/** `name@host` for a remote candidate, the bare name for a local one - the address form the
 * CLI's own `agents show`/`agents ask` name@host parsing (agents-shared.ts) accepts back. */
export function addressOf(candidate: {
  displayName: string
  host: string
  foreign?: boolean
}): string {
  return candidate.foreign ? `${candidate.displayName}@${candidate.host}` : candidate.displayName
}
