import { getAgentLabel } from '../../shared/terminal-title-agent-type'

export const LOCAL_ROSTER_ENVIRONMENT = 'local'
export const DEFAULT_ROSTER_PROBE_TIMEOUT_MS = 10_000

// Why: an older runtime answers an unknown or ungated method with these codes; every
// other failure means the runtime itself could not be reached.
const CAPABILITY_MISSING_ERROR_CODES = new Set([
  'method_not_found',
  'capability_unsupported',
  'orchestration_migration_required'
])

export type RosterReachability = 'ok' | 'unreachable' | 'capability-missing'

export type RosterTerminal = {
  handle: string
  title: string | null
  worktreePath?: string | null
}

export type RosterProbeResponse = {
  runtimeId: string | null
  terminals: readonly RosterTerminal[]
  truncated?: boolean
}

export type RosterProbe = {
  environment: string
  environmentId: string | null
  listTerminals: () => Promise<RosterProbeResponse>
}

export type RosterRow = {
  environment: string
  environmentId: string | null
  runtimeId: string | null
  reachability: RosterReachability
  reason: string | null
  terminal: string | null
  title: string | null
  agent: string | null
  worktreePath: string | null
}

export type EnvironmentTerminalRoster = {
  rows: RosterRow[]
  runtimeCount: number
  reachableCount: number
  terminalCount: number
  truncated: boolean
}

type ProbedRuntime = {
  environment: string
  environmentId: string | null
  runtimeId: string | null
  reachability: RosterReachability
  reason: string | null
  terminals: readonly RosterTerminal[]
  truncated: boolean
}

class RosterProbeTimeoutError extends Error {}

export async function collectEnvironmentTerminalRoster(
  probes: readonly RosterProbe[],
  options: { timeoutMs?: number } = {}
): Promise<EnvironmentTerminalRoster> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROSTER_PROBE_TIMEOUT_MS
  // Why: probes run together and never reject, so one dead peer costs the roster its
  // own bounded timeout instead of the whole aggregate.
  const probed = await Promise.all(probes.map((probe) => probeRuntime(probe, timeoutMs)))
  return {
    rows: probed.flatMap(toRosterRows),
    runtimeCount: probed.length,
    reachableCount: probed.filter((runtime) => runtime.reachability === 'ok').length,
    terminalCount: probed.reduce((total, runtime) => total + runtime.terminals.length, 0),
    truncated: probed.some((runtime) => runtime.truncated)
  }
}

async function probeRuntime(probe: RosterProbe, timeoutMs: number): Promise<ProbedRuntime> {
  const identity = { environment: probe.environment, environmentId: probe.environmentId }
  try {
    const response = await withProbeTimeout(probe.listTerminals(), timeoutMs)
    return {
      ...identity,
      runtimeId: response.runtimeId ?? null,
      reachability: 'ok',
      reason: null,
      terminals: response.terminals,
      truncated: response.truncated === true
    }
  } catch (error) {
    return {
      ...identity,
      runtimeId: null,
      reachability: classifyProbeFailure(error),
      reason: describeProbeFailure(error),
      terminals: [],
      truncated: false
    }
  }
}

function withProbeTimeout<TValue>(pending: Promise<TValue>, timeoutMs: number): Promise<TValue> {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RosterProbeTimeoutError(`no response within ${timeoutMs}ms`)),
      timeoutMs
    )
    // Why: a peer probe must never hold the CLI process open past its own result.
    timer.unref?.()
    pending.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

function classifyProbeFailure(error: unknown): RosterReachability {
  const code = errorCode(error)
  return code && CAPABILITY_MISSING_ERROR_CODES.has(code) ? 'capability-missing' : 'unreachable'
}

function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RosterProbeTimeoutError) {
    return message
  }
  const code = errorCode(error)
  return code ? `${code}: ${message}` : message
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function toRosterRows(runtime: ProbedRuntime): RosterRow[] {
  const tags = {
    environment: runtime.environment,
    environmentId: runtime.environmentId,
    runtimeId: runtime.runtimeId,
    reachability: runtime.reachability,
    reason: runtime.reason
  }
  if (runtime.terminals.length === 0) {
    return [{ ...tags, terminal: null, title: null, agent: null, worktreePath: null }]
  }
  return runtime.terminals.map((terminal) => ({
    ...tags,
    terminal: terminal.handle,
    title: terminal.title ?? null,
    // Why: terminal.list already carries the title, so the agent column costs no extra RPC.
    agent: terminal.title ? getAgentLabel(terminal.title) : null,
    worktreePath: terminal.worktreePath ?? null
  }))
}
